/**
 * Draft lifecycle state machine — exactly-once Monday approvals.
 *
 * One Redis key per draft: `marco:draft-state:<previewTs>`. The draft
 * object itself (`marco:draft:<previewTs>`, lib/redis.ts) is IMMUTABLE
 * after storeDraft; all mutable lifecycle data (state, owner,
 * reconfirmedAt, attempts, updateId) lives here and changes only via the
 * compare-and-transition Lua script. Re-storing the draft object is
 * forbidden — a SET with KEEPTTL against a key a concurrent ❌ just
 * deleted would create an immortal draft that any future ✅ executes.
 *
 * States:
 *   pending   — awaiting ✅/❌
 *   executing — a run owns the Monday write right now
 *   posted    — the update landed on Monday (terminal, idempotent replies)
 *   cancelled — ❌'d or verified-absent after an unknown outcome (terminal)
 *   unknown   — a write attempt ended ambiguously; only reconciliation
 *               against Monday's own updates feed may move it forward
 */

import { createHash } from "node:crypto";
import { redis } from "./redis.js";

export type DraftStateName =
  | "pending"
  | "executing"
  | "cancelled"
  | "posted"
  | "unknown";

export interface DraftState {
  state: DraftStateName;
  /** Trigger.dev run id that owns the executing transition. */
  owner?: string;
  /** sha256 hex of `${itemId}\n${updateBody}` — durable update identity. */
  bodyHash: string;
  updateId?: string;
  /** ISO of last transition — doubles as the CAS version stamp. */
  at: string;
  attempts: number;
  /** ISO of the Tier-1 first-✅ stale-draft acknowledgement. */
  reconfirmedAt?: string;
}

/**
 * 48h: covers the Tier-1 24h draft life plus another day of idempotent
 * "already posted" replies after the draft key itself expires.
 */
const STATE_TTL_SEC = 48 * 60 * 60;

const stateKey = (previewTs: string) => `marco:draft-state:${previewTs}`;

export function computeBodyHash(itemId: string, updateBody: string): string {
  return createHash("sha256").update(`${itemId}\n${updateBody}`).digest("hex");
}

// ─────────────────────────────────────────────────────────────
// Atomic transitions (Lua compare-and-transition)
// ─────────────────────────────────────────────────────────────
//
// @upstash/redis stores objects as plain JSON strings, so inside Lua the
// raw GET value is JSON — cjson.decode/encode keeps the stored format
// identical to what redis().get() parses back.
//
// KEYS[1] = marco:draft-state:<previewTs>
// ARGV[1] = fromStates (JSON array)   ARGV[2] = toState
// ARGV[3] = expectedAt ("" = skip)    ARGV[4] = new `at` (ISO)
// ARGV[5] = owner ("" = clear)        ARGV[6] = updateId ("" = keep)
// ARGV[7] = incrAttempts ("1"/"0")    ARGV[8] = reconfirmedAt ("" = keep)
// ARGV[9] = ttl seconds
const TRANSITION_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return cjson.encode({ ok = false, missing = true })
end
local cur = cjson.decode(raw)
local from = cjson.decode(ARGV[1])
local allowed = false
for i = 1, #from do
  if cur.state == from[i] then
    allowed = true
    break
  end
end
if not allowed then
  return cjson.encode({ ok = false, current = cur })
end
if ARGV[3] ~= "" and cur.at ~= ARGV[3] then
  return cjson.encode({ ok = false, current = cur })
end
local prev = cur.state
cur.state = ARGV[2]
cur.at = ARGV[4]
if ARGV[5] ~= "" then cur.owner = ARGV[5] else cur.owner = nil end
if ARGV[6] ~= "" then cur.updateId = ARGV[6] end
if ARGV[7] == "1" then cur.attempts = (cur.attempts or 0) + 1 end
if ARGV[8] ~= "" then cur.reconfirmedAt = ARGV[8] end
redis.call("SET", KEYS[1], cjson.encode(cur), "EX", tonumber(ARGV[9]))
return cjson.encode({ ok = true, prev = prev })
`;

export interface TransitionOpts {
  /** Run id that will own the target state (executing takeovers). */
  owner?: string;
  updateId?: string;
  incrAttempts?: boolean;
  reconfirmedAt?: string;
  /**
   * CAS stamp: the exact `at` the caller read. Every transition rewrites
   * `at`, so requiring it unchanged guarantees no other run transitioned
   * between the caller's read and this write.
   */
  expectedAt?: string;
}

export type TransitionResult =
  | { ok: true; prev: DraftStateName }
  | { ok: false; current: DraftState | null };

export async function transition(
  previewTs: string,
  from: DraftStateName[],
  to: DraftStateName,
  opts: TransitionOpts = {},
): Promise<TransitionResult> {
  const raw = await redis().eval<string[], unknown>(
    TRANSITION_SCRIPT,
    [stateKey(previewTs)],
    [
      JSON.stringify(from),
      to,
      opts.expectedAt ?? "",
      new Date().toISOString(),
      opts.owner ?? "",
      opts.updateId ?? "",
      opts.incrAttempts ? "1" : "0",
      opts.reconfirmedAt ?? "",
      String(STATE_TTL_SEC),
    ],
  );
  // The client auto-parses JSON responses; tolerate a raw string anyway.
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    ok: boolean;
    prev?: DraftStateName;
    missing?: boolean;
    current?: DraftState;
  };
  if (parsed.ok && parsed.prev) return { ok: true, prev: parsed.prev };
  if (parsed.missing) return { ok: false, current: null };
  return { ok: false, current: parsed.current ?? null };
}

/**
 * SET NX pending — called by the draft task at store time. If the key
 * already exists (concurrent lazy init), returns the existing state.
 */
export async function initDraftState(
  previewTs: string,
  bodyHash: string,
): Promise<DraftState> {
  const state: DraftState = {
    state: "pending",
    bodyHash,
    at: new Date().toISOString(),
    attempts: 0,
  };
  const won = await redis().set(stateKey(previewTs), state, {
    nx: true,
    ex: STATE_TTL_SEC,
  });
  if (won === "OK") return state;
  return (await getDraftState(previewTs)) ?? state;
}

export async function getDraftState(
  previewTs: string,
): Promise<DraftState | null> {
  const raw = (await redis().get(stateKey(previewTs))) as DraftState | null;
  return raw ?? null;
}

// ─────────────────────────────────────────────────────────────
// Reaction decision table (pure — the task file is a thin adapter)
// ─────────────────────────────────────────────────────────────

/**
 * An `executing` record older than this means the owning run died
 * mid-write: the outcome is unverifiable without reconciliation. 180s =
 * the reaction handler's 120s maxDuration plus a full minute of margin —
 * the stamp is written after run start, so a 180s-old stamp implies the
 * owner has been dead for at least a minute (a 120s threshold had zero
 * margin against a run that used its whole budget).
 */
export const EXECUTING_STALE_MS = 180_000;

/** Tier-1 drafts older than this need a second ✅ before executing. */
export const RECONFIRM_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Cool-down before the verified-absent retry out of `unknown`: an
 * ambiguous failure's mutation can commit server-side AFTER the abort,
 * invisible to an immediate reconciliation query. Until the unknown
 * state is this old, an absent verdict is not trusted to authorize a
 * retry (or a cancel) — the user is asked to wait.
 */
export const RECONCILE_MIN_AGE_MS = 120_000;

export type ReactionKind = "approve" | "reject";

export type ReplyClass =
  | "already_posted"
  | "already_cancelled"
  | "executing_cannot_cancel"
  | "already_processing";

export type ReactionDecision =
  | { action: "cancel" }
  | { action: "reconfirm" }
  | { action: "execute" }
  | { action: "reconcile" }
  | { action: "reply"; reply: ReplyClass };

/** Slack "seconds.micros" ts → epoch ms. Null when missing/unparseable. */
export function slackTsToMs(ts: string | undefined | null): number | null {
  if (!ts) return null;
  const sec = Number.parseFloat(ts);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

export function decideReaction(
  state: Pick<DraftState, "state" | "at" | "reconfirmedAt">,
  draft: { createdAt: string; requesterTier: 1 | 2 },
  reaction: ReactionKind,
  nowMs: number,
  /**
   * Epoch ms of the Slack reaction EVENT (not the message). Gates the
   * second-✅ after a re-confirm: a replayed copy of the very event that
   * stamped reconfirmedAt must not satisfy its own ask. Null (legacy
   * route payloads without event_ts) keeps the pre-gate behavior.
   */
  eventTsMs: number | null = null,
): ReactionDecision {
  switch (state.state) {
    case "pending": {
      if (reaction === "reject") return { action: "cancel" };
      const ageMs = nowMs - Date.parse(draft.createdAt);
      if (
        draft.requesterTier === 1 &&
        Number.isFinite(ageMs) &&
        ageMs >= RECONFIRM_AGE_MS
      ) {
        const reconfirmedAtMs = state.reconfirmedAt
          ? Date.parse(state.reconfirmedAt)
          : Number.NaN;
        // The second ✅ counts only if it is a strictly NEWER event than
        // the re-confirm stamp (when the event time is known at all).
        const confirmed =
          Number.isFinite(reconfirmedAtMs) &&
          (eventTsMs === null || eventTsMs > reconfirmedAtMs);
        if (!confirmed) return { action: "reconfirm" };
      }
      return { action: "execute" };
    }
    case "executing": {
      const heldMs = nowMs - Date.parse(state.at);
      const stale = !Number.isFinite(heldMs) || heldMs > EXECUTING_STALE_MS;
      if (reaction === "reject") {
        // Spec: ❌ against executing always gets the can't-cancel reply;
        // a stale owner is resolvable via a later ✅ (reconciliation).
        return { action: "reply", reply: "executing_cannot_cancel" };
      }
      return stale
        ? { action: "reconcile" }
        : { action: "reply", reply: "already_processing" };
    }
    case "posted":
      return { action: "reply", reply: "already_posted" };
    case "cancelled":
      return { action: "reply", reply: "already_cancelled" };
    case "unknown":
      return { action: "reconcile" };
  }
}

export type ReconcileAbsentAction = "retry" | "settling";

/**
 * Whether an absent reconciliation verdict may be acted on (retry or
 * cancel), or the write is still inside the server-side settling window.
 * `stateAt` is the unknown/executing transition stamp. An unparseable
 * stamp allows the retry — staying "settling" forever would deadlock the
 * draft, and the stamp is always written by our own code.
 */
export function decideReconcileAbsent(
  stateAt: string,
  nowMs: number,
): ReconcileAbsentAction {
  const ageMs = nowMs - Date.parse(stateAt);
  if (!Number.isFinite(ageMs)) return "retry";
  return ageMs >= RECONCILE_MIN_AGE_MS ? "retry" : "settling";
}

// ─────────────────────────────────────────────────────────────
// Slack markup sanitization (compose-time, F1a)
// ─────────────────────────────────────────────────────────────

/**
 * Strip Slack's message markup from update content BEFORE it is
 * previewed/stored: Slack auto-wraps every URL in angle brackets
 * (`<https://x.com|label>` / `<https://x.com>`), and Monday's HTML
 * sanitizer silently REMOVES tag-like tokens from stored updates — so a
 * body containing them can never reconcile against text_body. The
 * stored updateBody must contain no `<...>` tokens: preview text ==
 * what Monday stores == what reconciliation compares.
 */
export function sanitizeSlackMarkup(s: string): string {
  return (
    s
      // Labeled link: <url|label> → "label (url)", or just the label when
      // it repeats the url (Slack does this for typed emails/urls).
      .replace(
        /<((?:https?|mailto|tel):[^|>]*)\|([^>]*)>/gi,
        (_m, url: string, label: string) =>
          label === url || url === `mailto:${label}` || url === `tel:${label}`
            ? label
            : `${label} (${url})`,
      )
      // Bare wrapped link: <url> → url.
      .replace(/<((?:https?|mailto|tel):[^>]*)>/gi, "$1")
      // Anything else Slack wrapped (<@U…>, <!here>, stray tokens): drop
      // the brackets, keep the content.
      .replace(/<([^<>]*)>/g, "$1")
  );
}

// ─────────────────────────────────────────────────────────────
// Reconciliation matcher (pure)
// ─────────────────────────────────────────────────────────────

/** Slack allowed on the created_at window: clock skew + draft-store lag. */
export const RECONCILE_SLACK_MS = 5 * 60 * 1000;

/** Bounded named + numeric HTML entity decoding (Monday escapes text_body). */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d+);/g, (m, dec: string) => {
      const cp = Number(dec);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    // &amp; last so "&amp;lt;" decodes to "&lt;", not "<".
    .replace(/&amp;/g, "&");
}

/**
 * Normalize an update body for reconciliation comparison — applied to
 * BOTH the stored draft body and Monday's text_body. Monday HTML-
 * sanitizes stored updates (tag-like tokens removed, special chars
 * entity-encoded), so: strip tag-like tokens, decode entities, then
 * collapse whitespace runs and trim.
 */
export function normalizeUpdateBody(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the draft's update in the item's recent updates feed. A match is
 * normalized-body equality AND created_at >= draft.createdAt minus the
 * slack window — the time bound stops an identical historical update
 * from masquerading as this draft's write.
 */
export function matchUpdateBody(
  updates: Array<{ id: string; text_body: string; created_at: string }>,
  draftBody: string,
  draftCreatedAt: string,
): { id: string } | null {
  const want = normalizeUpdateBody(draftBody);
  const cutoff = Date.parse(draftCreatedAt) - RECONCILE_SLACK_MS;
  if (!want || !Number.isFinite(cutoff)) return null;
  for (const u of updates) {
    if (normalizeUpdateBody(u.text_body ?? "") !== want) continue;
    const created = Date.parse(u.created_at ?? "");
    if (Number.isFinite(created) && created >= cutoff) return { id: u.id };
  }
  return null;
}
