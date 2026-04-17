/**
 * Marco's Knowledge Base loader.
 *
 * The KB is a Monday.com Doc (or fallback: a long-text column on a Monday
 * item) that holds Oltre's processes, systems, brand voice, follow-up
 * cadences, dashboard features, and roadmap. It feeds the `kb-query`
 * skill and is cached aggressively so the Anthropic prompt-cache can
 * hit (the KB text is the stable prefix behind a 1h cache breakpoint).
 *
 * Caching layers:
 *   1. In-process cache      — 15 min TTL, zero-latency repeat reads.
 *   2. Upstash Redis         —  1 h TTL, survives cold starts across
 *                              Trigger.dev task runs.
 *   3. Monday authoritative  — source of truth. Cache invalidates when
 *                              the doc's `updated_at` moves forward.
 *
 * Graceful fallback: if Monday errors AND Redis has any value (even
 * stale), we return the stale value with a console.warn so Marco stays
 * answerable during transient outages.
 *
 * Env:
 *   MARCO_KB_DOC_ID  — the Monday Doc ID, OR (fallback path) the Monday
 *                      item ID whose long-text column holds the KB.
 *                      Currently we try Docs first and fall back to the
 *                      long-text path if the doc query errors.
 */

import { redis } from "./redis.js";

const MONDAY_API = "https://api.monday.com/v2";

function token(): string {
  const t = process.env.MONDAY_API_KEY;
  if (!t)
    throw new Error(
      "MONDAY_API_KEY not set. Copy from oltre-agents env into Marco's Trigger.dev env.",
    );
  return t;
}

async function mondayGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      Authorization: token(),
      "Content-Type": "application/json",
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
    error_message?: string;
  };
  if (json.errors?.length) {
    throw new Error(
      `Monday GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (json.error_message) {
    throw new Error(`Monday error: ${json.error_message}`);
  }
  if (!json.data) throw new Error("Monday returned no data");
  return json.data;
}

// ─────────────────────────────────────────────────────────────
// Cache state
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  text: string;
  fetchedAt: number;
  /** Monday's `updated_at` on the doc/item when we last fetched, ISO string. */
  sourceUpdatedAt: string | null;
}

let cached: CacheEntry | null = null;

const IN_MEMORY_TTL_MS = 15 * 60 * 1000;
const REDIS_TTL_SEC = 60 * 60;
const REDIS_KEY = "marco:kb:v1";

// ─────────────────────────────────────────────────────────────
// Monday fetchers
// ─────────────────────────────────────────────────────────────

interface DocFetchResult {
  text: string;
  updatedAt: string | null;
}

/**
 * Try fetching the KB as a Monday Doc. Returns null on any failure so
 * the caller can fall back to the long-text path.
 *
 * Monday's Docs GraphQL surface is `docs(ids: [ID!])` returning blocks
 * with `id`, `type`, and `content` (content is a JSON string that varies
 * by block type — for text blocks it usually contains a `deltaFormat`
 * field holding the rendered text). If the schema version Marco's key
 * is on doesn't support a field we ask for, the query errors and we
 * bail gracefully.
 */
async function fetchAsDoc(docId: string): Promise<DocFetchResult | null> {
  try {
    const gql = `
      query ($ids: [ID!]) {
        docs(ids: $ids) {
          id
          name
          updated_at
          blocks {
            id
            type
            content
          }
        }
      }
    `;
    const data = await mondayGraphql<{
      docs: Array<{
        id: string;
        name: string;
        updated_at: string | null;
        blocks: Array<{ id: string; type: string; content: string }>;
      }>;
    }>(gql, { ids: [docId] });

    const doc = data.docs?.[0];
    if (!doc) return null;

    const lines: string[] = [];
    for (const block of doc.blocks ?? []) {
      const rendered = renderDocBlock(block);
      if (rendered) lines.push(rendered);
    }
    const text = lines.join("\n\n").trim();
    if (!text) return null;
    return { text, updatedAt: doc.updated_at ?? null };
  } catch (err) {
    console.warn(
      "[marco kb] Monday Docs fetch failed, will try long-text fallback:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Flatten a Monday doc block to markdown. The `content` field is a JSON
 * string whose shape is block-type-specific and not formally versioned —
 * we do a best-effort extraction of text and structure, and fall back
 * to the raw content string if we can't parse it.
 */
function renderDocBlock(block: {
  type: string;
  content: string;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.content);
  } catch {
    // Non-JSON content — just use the raw string if it looks text-ish.
    const raw = block.content?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  // Best-effort text extraction. Monday's block payloads commonly carry
  // the rendered text under one of these fields; we check them in order.
  const text = extractText(parsed);
  if (!text) return null;

  switch (block.type) {
    case "large_title":
      return `# ${text}`;
    case "medium_title":
      return `## ${text}`;
    case "small_title":
      return `### ${text}`;
    case "bulleted_list":
      return `- ${text}`;
    case "numbered_list":
      return `1. ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return "```\n" + text + "\n```";
    default:
      return text;
  }
}

function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";

  const obj = node as Record<string, unknown>;
  // Common Monday shapes. `deltaFormat` is a list of {insert: "..."} ops.
  if (Array.isArray(obj.deltaFormat)) {
    return obj.deltaFormat
      .map((d) =>
        typeof d === "object" && d !== null && "insert" in d
          ? String((d as { insert: unknown }).insert ?? "")
          : "",
      )
      .join("")
      .trim();
  }
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;

  // Recurse into nested structures (e.g. { alignment: "...", content: {...} }).
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === "object") {
      const t = extractText(v);
      if (t) return t;
    }
  }
  return "";
}

/**
 * Fallback: treat `MARCO_KB_DOC_ID` as a Monday *item* ID and pull the
 * first long-text column's value as the KB. This is the "refine later"
 * escape hatch documented in the ingest plan.
 *
 * TODO(andrew): if/when we settle on Docs permanently, delete this path.
 */
async function fetchAsLongText(itemId: string): Promise<DocFetchResult | null> {
  const gql = `
    query ($id: [ID!]!) {
      items(ids: $id) {
        id
        name
        updated_at
        column_values {
          id
          type
          text
          column { title }
        }
      }
    }
  `;
  const data = await mondayGraphql<{
    items: Array<{
      id: string;
      name: string;
      updated_at: string | null;
      column_values: Array<{
        id: string;
        type: string;
        text: string | null;
        column: { title: string };
      }>;
    }>;
  }>(gql, { id: [itemId] });

  const item = data.items?.[0];
  if (!item) return null;

  const longText = item.column_values.find(
    (c) => c.type === "long_text" && c.text && c.text.trim(),
  );
  if (!longText || !longText.text) return null;

  return { text: longText.text.trim(), updatedAt: item.updated_at ?? null };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Load the Marco KB, honoring in-memory → Redis → Monday in that order.
 *
 * Invalidation: we compare Monday's `updated_at` against the cached
 * value and refetch if newer. When the in-memory cache is fresh (<15m)
 * we trust it without calling Monday, so there is a bounded window where
 * KB edits don't appear instantly. That's acceptable — the KB changes
 * on the order of days, not minutes.
 */
export async function loadKnowledgeBase(): Promise<string> {
  const docId = process.env.MARCO_KB_DOC_ID;
  if (!docId) {
    throw new Error(
      "MARCO_KB_DOC_ID not set. Point it at a Monday Doc ID (or, as a fallback, a Monday item ID with a long-text column holding the KB).",
    );
  }

  // 1. In-memory cache
  if (cached && Date.now() - cached.fetchedAt < IN_MEMORY_TTL_MS) {
    return cached.text;
  }

  // 2. Redis cache
  let redisEntry: CacheEntry | null = null;
  try {
    const raw = (await redis().get(REDIS_KEY)) as CacheEntry | null;
    if (raw && typeof raw.text === "string") {
      redisEntry = raw;
    }
  } catch (err) {
    console.warn(
      "[marco kb] redis read failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 3. Monday — authoritative. Try Docs first, long-text as fallback.
  let fresh: DocFetchResult | null = null;
  try {
    fresh = await fetchAsDoc(docId);
    if (!fresh) fresh = await fetchAsLongText(docId);
  } catch (err) {
    console.warn(
      "[marco kb] Monday fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Graceful fallback: serve stale Redis if we have it.
    if (redisEntry) {
      console.warn("[marco kb] serving stale Redis value");
      cached = redisEntry;
      return redisEntry.text;
    }
    throw err;
  }

  if (!fresh) {
    // Monday returned no content. Fall back to Redis if possible.
    if (redisEntry) {
      console.warn("[marco kb] Monday returned no content, serving Redis");
      cached = redisEntry;
      return redisEntry.text;
    }
    throw new Error(
      `Marco KB is empty — MARCO_KB_DOC_ID=${docId} returned no content from Monday Docs or long-text fallback.`,
    );
  }

  // If Redis has the same (or newer) version, prefer it to avoid a
  // needless rewrite. Otherwise write through.
  if (
    redisEntry &&
    redisEntry.sourceUpdatedAt &&
    fresh.updatedAt &&
    redisEntry.sourceUpdatedAt === fresh.updatedAt
  ) {
    cached = redisEntry;
    return redisEntry.text;
  }

  const entry: CacheEntry = {
    text: fresh.text,
    fetchedAt: Date.now(),
    sourceUpdatedAt: fresh.updatedAt,
  };
  cached = entry;
  try {
    await redis().set(REDIS_KEY, entry, { ex: REDIS_TTL_SEC });
  } catch (err) {
    console.warn(
      "[marco kb] redis write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return entry.text;
}

/**
 * Test hook — clears the in-memory cache so unit tests can exercise
 * the Redis/Monday fetch paths cleanly. Does NOT clear Redis.
 */
export function __resetKbCache(): void {
  cached = null;
}
