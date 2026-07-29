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
 *   2. Upstash Redis (fresh) —  1 h TTL ("marco:kb:v1"), survives cold
 *                              starts across Trigger.dev task runs. A hit
 *                              here is served WITHOUT touching Monday.
 *   3. Upstash Redis (LKG)   —  7 d TTL ("marco:kb:lkg"), last-known-good.
 *                              Served immediately when the fresh key has
 *                              expired, while a background single-flight
 *                              refresh ("marco:kb:refresh-lock") re-reads
 *                              Monday. Cold workers no longer pay the
 *                              21-page doc read on every KB question.
 *   4. Monday authoritative  — source of truth. Only read when neither
 *                              Redis key exists (blocking) or during the
 *                              background refresh.
 *
 * Completeness gate: a fetched KB is only allowed to overwrite the Redis
 * keys if it passes size + sentinel-section validation — a partial doc
 * read can never clobber a good cached copy.
 *
 * Graceful fallback: if Monday errors AND anything is cached (even
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
      // Verified live 2026-07-29: docs/blocks(page, limit) resolves on
      // 2025-04 with Marco's key (2024-01 is deprecated). NOTE: 2025-04
      // returns block types with spaces ("large title"), not underscores —
      // renderDocBlock normalizes.
      "API-Version": "2025-04",
    },
    body: JSON.stringify({ query, variables }),
    // 25s deadline — see lib/monday.ts graphql() for rationale.
    signal: AbortSignal.timeout(25_000),
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

/** Last-known-good copy — long-lived so Marco survives Monday outages. */
const LKG_KEY = "marco:kb:lkg";
const LKG_TTL_SEC = 7 * 24 * 60 * 60;

/** Single-flight lock so concurrent cold workers don't stampede the doc API. */
const REFRESH_LOCK_KEY = "marco:kb:refresh-lock";
const REFRESH_LOCK_TTL_SEC = 120;

// ─────────────────────────────────────────────────────────────
// Completeness gate
// ─────────────────────────────────────────────────────────────

/**
 * Minimum plausible KB size. The live KB renders to well over 100k chars
 * (21 pages / ~2,030 blocks as of 2026-07-29); anything under 50k means
 * the doc read was truncated or the doc itself was gutted.
 */
const KB_MIN_CHARS = 50_000;

/**
 * Validate a freshly fetched KB before it is allowed to overwrite the
 * cached copies. Returns null when valid, otherwise a human-readable
 * reason. Sentinels: the doc title, the first section, and the newest
 * section (17) — if the tail section is missing, pagination broke.
 */
function validateKbText(text: string): string | null {
  if (text.length < KB_MIN_CHARS) {
    return `too short (${text.length} chars < ${KB_MIN_CHARS})`;
  }
  if (!text.includes("Marco Knowledge Base")) {
    return 'missing "Marco Knowledge Base" title';
  }
  if (!/\b1\. Lead Workflow/.test(text)) {
    return 'missing "1. Lead Workflow" section sentinel';
  }
  if (!/\b17\. Who Oltre Sells To/.test(text)) {
    return 'missing "17. Who Oltre Sells To" section sentinel (doc tail truncated?)';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Monday fetchers
// ─────────────────────────────────────────────────────────────

interface DocFetchResult {
  text: string;
  updatedAt: string | null;
}

/**
 * Blocks requested per page when reading a doc. Monday's `blocks` connection
 * is paginated; the UNPAGINATED default returns only 25 blocks, which silently
 * truncated the KB to its table of contents — Sections 2+ never loaded. We page
 * through explicitly (see fetchAsDoc) until a short page signals the end.
 */
const DOC_BLOCKS_PAGE_SIZE = 100;

/**
 * Hard cap on pages so a misbehaving API can't loop us forever.
 * 100 pages * 100 blocks = 10k blocks, comfortably above the real KB size.
 */
const DOC_BLOCKS_MAX_PAGES = 100;

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
 *
 * The `blocks` connection is paged with Monday's standard `(page, limit)`
 * args. Without them the API caps the response at 25 blocks; the real KB is
 * 700+ blocks, so we loop until a page comes back shorter than the page size.
 */
async function fetchAsDoc(docId: string): Promise<DocFetchResult | null> {
  try {
    const gql = `
      query ($ids: [ID!], $page: Int!, $limit: Int!) {
        docs(ids: $ids) {
          id
          name
          updated_at
          blocks(page: $page, limit: $limit) {
            id
            type
            content
          }
        }
      }
    `;

    const lines: string[] = [];
    let updatedAt: string | null = null;
    let sawDoc = false;

    for (let page = 1; page <= DOC_BLOCKS_MAX_PAGES; page++) {
      const data = await mondayGraphql<{
        docs: Array<{
          id: string;
          name: string;
          updated_at: string | null;
          blocks: Array<{ id: string; type: string; content: string }>;
        }>;
      }>(gql, { ids: [docId], page, limit: DOC_BLOCKS_PAGE_SIZE });

      const doc = data.docs?.[0];
      if (!doc) {
        // No doc on the very first page → not a doc id; let the caller fall
        // back to the long-text path. On a later page it just means we've run
        // past the end, so stop with whatever we have.
        if (!sawDoc) return null;
        break;
      }
      sawDoc = true;
      if (updatedAt === null) updatedAt = doc.updated_at ?? null;

      const blocks = doc.blocks ?? [];
      for (const block of blocks) {
        const rendered = renderDocBlock(block);
        if (rendered) lines.push(rendered);
      }

      // A short (or empty) page means we've reached the last page.
      if (blocks.length < DOC_BLOCKS_PAGE_SIZE) break;

      if (page === DOC_BLOCKS_MAX_PAGES) {
        console.warn(
          `[marco kb] hit DOC_BLOCKS_MAX_PAGES (${DOC_BLOCKS_MAX_PAGES}) while paging KB blocks; the KB may be truncated.`,
        );
      }
    }

    const text = lines.join("\n\n").trim();
    if (!text) return null;
    return { text, updatedAt };
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

  // API 2024-01 returned underscore types ("large_title"); 2025-04 returns
  // spaces ("large title"). Normalize so headings render either way.
  switch (block.type.replace(/\s+/g, "_")) {
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

/** Read one of the KB cache keys, tolerating Redis being down. */
async function readCacheKey(key: string): Promise<CacheEntry | null> {
  try {
    const raw = (await redis().get(key)) as CacheEntry | null;
    if (raw && typeof raw.text === "string") return raw;
  } catch (err) {
    console.warn(
      `[marco kb] redis read failed (${key}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

/** Write-through to BOTH Redis keys (fresh 1h + last-known-good 7d). Best-effort. */
async function writeCacheKeys(entry: CacheEntry): Promise<void> {
  try {
    await redis().set(REDIS_KEY, entry, { ex: REDIS_TTL_SEC });
    await redis().set(LKG_KEY, entry, { ex: LKG_TTL_SEC });
  } catch (err) {
    console.warn(
      "[marco kb] redis write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Fetch the KB from Monday: Docs first, long-text fallback. */
async function fetchFromMonday(docId: string): Promise<DocFetchResult | null> {
  let fresh = await fetchAsDoc(docId);
  if (!fresh) fresh = await fetchAsLongText(docId);
  return fresh;
}

/**
 * Fetch from Monday, run the completeness gate, and (only if valid)
 * write through to Redis + the in-memory cache.
 *
 * `prior` is whatever cached copy the caller already holds. Keeps the
 * existing updated_at freshness check: when Monday's `updated_at` matches
 * the prior entry's, the prior (already-validated) text is reused instead
 * of being rewritten.
 *
 * Returns the entry now considered current. Throws only when the fetch
 * produced nothing usable AND there is no prior to fall back to.
 */
async function fetchValidateAndCache(
  docId: string,
  prior: CacheEntry | null,
): Promise<CacheEntry> {
  let fresh: DocFetchResult | null;
  try {
    fresh = await fetchFromMonday(docId);
  } catch (err) {
    console.warn(
      "[marco kb] Monday fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    if (prior) {
      console.warn("[marco kb] serving previously cached value");
      cached = prior;
      return prior;
    }
    throw err;
  }

  if (!fresh) {
    if (prior) {
      console.warn("[marco kb] Monday returned no content, serving cached value");
      cached = prior;
      return prior;
    }
    throw new Error(
      `Marco KB is empty — MARCO_KB_DOC_ID=${docId} returned no content from Monday Docs or long-text fallback.`,
    );
  }

  // updated_at freshness check: same source version as what we already
  // hold → reuse it (re-warms the 1h key). The prior copy must itself
  // pass the gate — otherwise fall through and cache the fresh text, so a
  // truncated pre-fix cache can't survive on an unchanged updated_at.
  if (
    prior &&
    prior.sourceUpdatedAt &&
    fresh.updatedAt &&
    prior.sourceUpdatedAt === fresh.updatedAt &&
    validateKbText(prior.text) === null
  ) {
    const rewarmed: CacheEntry = { ...prior, fetchedAt: Date.now() };
    cached = rewarmed;
    await writeCacheKeys(rewarmed);
    return rewarmed;
  }

  // Completeness gate — a truncated read must never clobber a good cache.
  const problem = validateKbText(fresh.text);
  if (problem) {
    console.error(
      `[marco kb] fetched KB failed completeness validation (${problem}) — keeping cached copy, NOT overwriting Redis`,
    );
    if (prior) {
      cached = prior;
      return prior;
    }
    throw new Error(`Marco KB failed completeness validation: ${problem}`);
  }

  const entry: CacheEntry = {
    text: fresh.text,
    fetchedAt: Date.now(),
    sourceUpdatedAt: fresh.updatedAt,
  };
  cached = entry;
  await writeCacheKeys(entry);
  return entry;
}

/**
 * Background refresh behind a Redis single-flight lock (NX EX 120): only
 * one worker per 2-minute window re-reads the 21-page doc; everyone else
 * keeps serving the LKG copy.
 */
async function refreshInBackground(
  docId: string,
  prior: CacheEntry,
): Promise<void> {
  let lock: unknown = null;
  try {
    lock = await redis().set(REFRESH_LOCK_KEY, "1", {
      nx: true,
      ex: REFRESH_LOCK_TTL_SEC,
    });
  } catch (err) {
    console.warn(
      "[marco kb] refresh lock acquire failed:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (lock !== "OK") return; // another worker is already refreshing
  await fetchValidateAndCache(docId, prior);
}

/**
 * Load the Marco KB: in-memory (15m) → fresh Redis (1h) → last-known-good
 * Redis (7d, served immediately with a background refresh) → blocking
 * Monday fetch.
 *
 * Invalidation: the refresh path compares Monday's `updated_at` against
 * the cached value and reuses the cached text when unchanged. When the
 * in-memory or fresh-Redis cache is hot we trust it without calling
 * Monday, so there is a bounded window where KB edits don't appear
 * instantly. That's acceptable — the KB changes on the order of days,
 * not minutes.
 */
export async function loadKnowledgeBase(): Promise<string> {
  const docId = process.env.MARCO_KB_DOC_ID;
  if (!docId) {
    throw new Error(
      "MARCO_KB_DOC_ID not set. Point it at a Monday Doc ID (or, as a fallback, a Monday item ID with a long-text column holding the KB).",
    );
  }

  // 1. In-memory cache (15 min)
  if (cached && Date.now() - cached.fetchedAt < IN_MEMORY_TTL_MS) {
    return cached.text;
  }

  // 2. Fresh Redis (1h) — a hit here is authoritative-enough; no Monday call.
  const fresh = await readCacheKey(REDIS_KEY);
  if (fresh) {
    cached = fresh;
    return fresh.text;
  }

  // 3. Last-known-good (7d) — serve stale IMMEDIATELY, refresh in the
  //    background behind the single-flight lock. Fire-and-forget: a
  //    refresh failure only logs; the caller already has an answer.
  const lkg = await readCacheKey(LKG_KEY);
  if (lkg) {
    cached = lkg;
    refreshInBackground(docId, lkg).catch((err) =>
      console.error(
        "[marco kb] background refresh failed:",
        err instanceof Error ? err.message : String(err),
      ),
    );
    return lkg.text;
  }

  // 4. Nothing cached anywhere — blocking fetch, as before. A stale
  //    in-memory copy (>15m old) still counts as a fallback of last resort.
  const entry = await fetchValidateAndCache(docId, cached);
  return entry.text;
}

/**
 * Test hook — clears the in-memory cache so unit tests can exercise
 * the Redis/Monday fetch paths cleanly. Does NOT clear Redis.
 */
export function __resetKbCache(): void {
  cached = null;
}
