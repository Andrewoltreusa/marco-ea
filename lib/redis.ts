/**
 * Marco's Upstash Redis client.
 *
 * Uses the REST client (not TCP) because Trigger.dev tasks run in a
 * serverless environment where stateless HTTP is the right shape.
 *
 * Credentials come from the shared oltre-agents env:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * This instance is shared with oltre-agents and oltre-dashboard. To
 * avoid key collisions, every Marco key starts with `marco:`.
 */

import { Redis } from "@upstash/redis";

let _client: Redis | null = null;
let _rawClient: Redis | null = null;

function credentials(): { url: string; token: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set. " +
        "These are shared with oltre-agents — copy them into Marco's Trigger.dev env.",
    );
  }
  return { url, token };
}

export function redis(): Redis {
  if (_client) return _client;
  _client = new Redis(credentials());
  return _client;
}

/**
 * Client with automatic deserialization OFF — every response is the raw
 * stored string. Needed where byte-exact values matter: the watchdog's
 * LRANGE elements must be passed back to LREM untouched (the default
 * client JSON-parses list elements, and re-stringifying a parsed copy is
 * not guaranteed byte-identical for foreign-formatted entries).
 */
export function redisRaw(): Redis {
  if (_rawClient) return _rawClient;
  _rawClient = new Redis({ ...credentials(), automaticDeserialization: false });
  return _rawClient;
}

// Atomic compare-and-delete: DEL only when the stored raw string equals
// one of the expected serializations. Replaces GET-then-DEL patterns
// that could clobber a value written between the read and the delete.
const COMPARE_AND_DEL_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return 0
end
for i = 1, #ARGV do
  if raw == ARGV[i] then
    redis.call("DEL", KEYS[1])
    return 1
  end
end
return 0
`;

/** True when the key was deleted (raw value matched an expected form). */
export async function compareAndDel(
  key: string,
  expectedRawValues: string[],
): Promise<boolean> {
  const res = await redis().eval<string[], number>(
    COMPARE_AND_DEL_SCRIPT,
    [key],
    expectedRawValues,
  );
  return res === 1;
}

// ─────────────────────────────────────────────────────────────
// Request lifecycle (replaces the old one-bit event dedup)
// ─────────────────────────────────────────────────────────────
//
// The one-bit claim had a poisoned-claim failure: a worker that claimed
// the event and then died left every redelivery returning "duplicate"
// even though no answer was ever sent. The lifecycle distinguishes
// "being worked on" from "answered", and lets a redelivery take over a
// stale claim.

export interface RequestState {
  status: "processing" | "responded";
  startedAt: string;
  respondedAt?: string;
  /**
   * "delegated": the parent enqueued a child task that owns the terminal
   * reply. The child can legitimately take minutes (queue delay + its own
   * 60s budget), so a delegated claim goes stale far later than an
   * in-process one — a redelivery must not take over a request whose
   * child is alive and about to post a preview.
   */
  phase?: "delegated";
}

const REQ_TTL_SEC = 900; // covers Slack's retry ladder
const STALE_PROCESSING_MS = 120_000; // = inbound maxDuration
export const DELEGATED_STALE_MS = 15 * 60 * 1000;

export type BeginRequestResult = "fresh" | "duplicate" | "takeover";

/**
 * Staleness verdict for a processing record, phase-aware. Pure for
 * tests; an unparseable startedAt counts as stale (a corrupt claim must
 * not suppress redeliveries forever).
 */
export function isStaleProcessing(state: RequestState, nowMs: number): boolean {
  const ageMs = nowMs - new Date(state.startedAt).getTime();
  const staleMs =
    state.phase === "delegated" ? DELEGATED_STALE_MS : STALE_PROCESSING_MS;
  return !Number.isFinite(ageMs) || ageMs > staleMs;
}

// Takeover CAS: only the worker whose read `startedAt` still matches the
// stored record may overwrite it — a plain GET-then-SET let two
// redeliveries both "take over" the same stale claim and double-answer.
// A key missing at EVAL time (expired between the caller's GET and here)
// counts as a win. @upstash/redis stores objects as JSON strings, so the
// raw Lua GET value decodes with cjson.
//
// KEYS[1] = lifecycle key
// ARGV[1] = expected startedAt ("" only for the missing-key claim path)
// ARGV[2] = new processing record (JSON)   ARGV[3] = ttl seconds
const TAKEOVER_CAS_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  redis.call("SET", KEYS[1], ARGV[2], "EX", tonumber(ARGV[3]))
  return 1
end
local cur = cjson.decode(raw)
if cur.status == "responded" then
  return 0
end
if cur.startedAt ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2], "EX", tonumber(ARGV[3]))
return 1
`;

/** CAS argument construction, factored for tests. */
export function buildTakeoverArgs(
  expectedStartedAt: string,
  state: RequestState,
): [string, string, string] {
  return [expectedStartedAt, JSON.stringify(state), String(REQ_TTL_SEC)];
}

export async function beginRequest(key: string): Promise<BeginRequestResult> {
  const r = redis();
  const state: RequestState = {
    status: "processing",
    startedAt: new Date().toISOString(),
  };
  const won = await r.set(key, state, { nx: true, ex: REQ_TTL_SEC });
  if (won === "OK") return "fresh";

  const existing = (await r.get(key)) as RequestState | null;
  if (!existing) {
    // Expired between SET NX and GET. Claim through the CAS so a racer
    // that re-created the key in the meantime keeps its claim.
    const claimed = await r.eval<string[], number>(
      TAKEOVER_CAS_SCRIPT,
      [key],
      buildTakeoverArgs("", state),
    );
    return claimed === 1 ? "fresh" : "duplicate";
  }
  if (existing.status === "responded") return "duplicate";

  if (isStaleProcessing(existing, Date.now())) {
    // Previous worker died mid-run (or its delegated child never
    // finalized) — exactly one redelivery may swap the stale record it
    // read; every other racer gets "duplicate".
    const claimed = await r.eval<string[], number>(
      TAKEOVER_CAS_SCRIPT,
      [key],
      buildTakeoverArgs(String(existing.startedAt), state),
    );
    return claimed === 1 ? "takeover" : "duplicate";
  }
  return "duplicate";
}

/**
 * Parent-side stamp after a successful child enqueue: the lifecycle
 * stays "processing" but flips to the delegated staleness threshold.
 * Best-effort — the child's markResponded overwrites this later.
 */
export async function markDelegated(key: string): Promise<void> {
  try {
    const state: RequestState = {
      status: "processing",
      startedAt: new Date().toISOString(),
      phase: "delegated",
    };
    await redis().set(key, state, { ex: REQ_TTL_SEC });
  } catch {
    // never let bookkeeping break a successful enqueue
  }
}

/** Best-effort terminal marker — only "responded" suppresses redeliveries for good. */
export async function markResponded(key: string): Promise<void> {
  try {
    await redis().set(
      key,
      { status: "responded", respondedAt: new Date().toISOString() },
      { ex: REQ_TTL_SEC },
    );
  } catch {
    // never let bookkeeping break a delivered answer
  }
}

// ─────────────────────────────────────────────────────────────
// Draft storage
// ─────────────────────────────────────────────────────────────
//
// The draft object is IMMUTABLE after storeDraft. All mutable lifecycle
// data (state, owner, reconfirmedAt, attempts, updateId) lives in
// `marco:draft-state:<previewTs>` (lib/draft-state.ts) and changes only
// via CAS — re-storing a draft here can resurrect one a concurrent ❌
// just deleted.

export interface MondayUpdateDraft {
  /** The Slack ts of Marco's preview message — used as the lookup key. */
  previewTs: string;
  /** The Slack channel/DM where the preview was posted. */
  previewChannel: string;
  /** The user who asked for the draft. Must match the reactor. */
  requesterSlackId: string;
  requesterName: string;
  requesterTier: 1 | 2;
  /** Monday target resolved at draft time. */
  monday: {
    boardId: string;
    boardName: string;
    itemId: string;
    itemName: string;
  };
  /** The exact body Marco will post to Monday, with signature already appended. */
  updateBody: string;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
}

const DRAFT_KEY = (previewTs: string) => `marco:draft:${previewTs}`;
export const USER_DRAFT_KEY = (slackId: string) => `marco:user-draft:${slackId}`;

/**
 * Decode the Tier-2 user-draft slot into a preview ts, or null when the
 * slot is empty or holds a `reserving:` sentinel. The pointer is stored
 * as `{ ts }` — a bare ts string like "1753900000.123450" is numeric, so
 * @upstash/redis's automatic JSON parse would return the NUMBER
 * 1753900000.12345 (trailing zero lost → wrong key rebuild). Legacy
 * bare-string/number values are String()-coerced defensively.
 */
export function userDraftPointerTs(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") {
    const ts = (raw as { ts?: unknown }).ts;
    return ts === null || ts === undefined ? null : String(ts);
  }
  const s = String(raw);
  if (!s || s.startsWith("reserving")) return null;
  return s;
}

/** The raw serializations a pointer for `previewTs` may be stored under. */
function pointerRawForms(previewTs: string): string[] {
  // Current object form (client stores objects as JSON), then the legacy
  // bare-string form.
  return [JSON.stringify({ ts: previewTs }), previewTs];
}

export async function storeDraft(draft: MondayUpdateDraft): Promise<void> {
  // Tier 1: 24h — the draft LIVES 24h; execution without re-confirm is
  // allowed ≤12h from createdAt, and a ✅ between 12h and 24h goes
  // through the reaction handler's re-confirm flow. The old 12h TTL made
  // that documented window unreachable. Tier 2: 2h, no re-confirm.
  const ttlSec =
    draft.requesterTier === 1 ? 24 * 60 * 60 : 2 * 60 * 60;
  await redis().set(DRAFT_KEY(draft.previewTs), draft, { ex: ttlSec });

  // Tier 2: enforce one-active-draft-per-user by tracking the latest
  // preview ts under a per-user key with the same TTL. Stored as an
  // object wrapper — see userDraftPointerTs.
  if (draft.requesterTier === 2) {
    await redis().set(
      USER_DRAFT_KEY(draft.requesterSlackId),
      { ts: draft.previewTs },
      { ex: ttlSec },
    );
  }
}

export async function getDraft(
  previewTs: string,
): Promise<MondayUpdateDraft | null> {
  const raw = (await redis().get(DRAFT_KEY(previewTs))) as
    | MondayUpdateDraft
    | null;
  return raw ?? null;
}

export async function deleteDraft(previewTs: string): Promise<void> {
  const draft = await getDraft(previewTs);
  await redis().del(DRAFT_KEY(previewTs));
  if (draft?.requesterTier === 2) {
    // Clear the user pointer ONLY if it still points at this draft —
    // atomic compare-and-del against the raw stored string, so a newer
    // draft's pointer written mid-flight is never clobbered and numeric-
    // looking ts values compare byte-exactly.
    await compareAndDel(
      USER_DRAFT_KEY(draft.requesterSlackId),
      pointerRawForms(previewTs),
    );
  }
}

/**
 * For Tier 2 one-draft-at-a-time enforcement. Returns the draft behind
 * the user's pointer, or null — a `reserving:` sentinel (a draft run in
 * flight) is explicitly NOT an active draft.
 */
export async function getActiveDraftForUser(
  slackId: string,
): Promise<MondayUpdateDraft | null> {
  const raw = await redis().get(USER_DRAFT_KEY(slackId));
  const previewTs = userDraftPointerTs(raw);
  if (!previewTs) return null;
  return getDraft(previewTs);
}
