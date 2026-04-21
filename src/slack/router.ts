/**
 * Marco Slack router.
 *
 * Responsibilities (in order, no exceptions):
 *   1. Tier check — look up the sender in the allowlist.
 *   2. Tier 3 → log + send at most 1 refusal per 24h, return.
 *   3. Tier 1/2 → classify intent, route to the matching skill.
 *   4. Return a normalized response envelope for the webhook task to post.
 *
 * This file is pure logic — no Slack Web API calls. The Trigger.dev inbound
 * task wraps this router and handles outbound.
 */

import { tierFor, nameFor, type Tier } from "./allowlist.js";

export type SkillName =
  | "deal-status"
  | "cash-position"
  | "production-eta"
  | "lead-check"
  | "agent-fleet-health"
  | "find-in-vault"
  | "kb-query"
  | "monday-update"
  | "clarify"
  | "refuse"
  | "general-query";

export interface InboundEvent {
  slackUserId: string;
  channel: string;
  text: string;
  threadTs?: string;
  isDM: boolean;
}

export interface RoutedRequest {
  skill: SkillName;
  tier: Tier;
  args: Record<string, string>;
  replyChannel: string;
  threadTs?: string;
  rateLimited?: boolean;
}

const REFUSAL_TEXT =
  "I'm Marco, Oltre's company secretary. I'm not configured to respond to you — " +
  "please ask Andrew Shpiruk directly if you need something from the company.";

// In-memory Tier-3 rate limiter. Backed by Upstash Redis in production
// (see trigger task). Keyed by slackUserId → lastRefusalEpochMs.
const tier3LastSeen = new Map<string, number>();
const TIER3_WINDOW_MS = 24 * 60 * 60 * 1000;

export function routeInbound(evt: InboundEvent): RoutedRequest {
  const tier = tierFor(evt.slackUserId);

  if (tier === 3) {
    const last = tier3LastSeen.get(evt.slackUserId) ?? 0;
    const now = Date.now();
    const rateLimited = now - last < TIER3_WINDOW_MS;
    if (!rateLimited) tier3LastSeen.set(evt.slackUserId, now);

    return {
      skill: "refuse",
      tier: 3,
      args: { text: REFUSAL_TEXT, reason: rateLimited ? "rate_limited" : "first_refusal" },
      replyChannel: evt.channel,
      threadTs: evt.threadTs,
      rateLimited,
    };
  }

  const intent = classifyIntent(evt.text);

  return {
    skill: intent.skill,
    tier,
    args: { ...intent.args, requesterName: nameFor(evt.slackUserId) ?? "unknown" },
    replyChannel: evt.channel,
    threadTs: evt.threadTs,
  };
}

/**
 * Keyword-based intent classifier.
 *
 * Order matters. WRITE-intent detection runs FIRST — if a message looks
 * like a write request, it goes to `monday-update` even if it also
 * contains read keywords. This is because the skill's actual parser
 * (Claude call in lib/anthropic.ts) is more accurate than this regex,
 * and it will return confidence=0 for false positives, which the skill
 * handles gracefully by falling back to clarify.
 *
 * Read classifiers only fire if we're confident there is NO write intent.
 */
export function classifyIntent(
  raw: string,
): { skill: SkillName; args: Record<string, string> } {
  const text = raw.trim().toLowerCase();

  if (!text) return { skill: "clarify", args: { reason: "empty" } };

  // ─────────────────────────────────────────────────────────
  // READ-intent overrides — run FIRST, catch "update" as a noun
  //
  // These phrasings look like writes to the isWriteIntent regex
  // because of words like "update" / "note" appearing near board
  // nouns, but they're read requests. Force them to general-query.
  // ─────────────────────────────────────────────────────────
  if (isReadNounIntent(text)) {
    return { skill: "general-query", args: { query: raw.trim() } };
  }

  // ─────────────────────────────────────────────────────────
  // WRITE intent — runs after the read override
  // ─────────────────────────────────────────────────────────
  if (isWriteIntent(text)) {
    return { skill: "monday-update", args: { query: raw.trim() } };
  }

  // Cash / AR / contracted / invoiced — route directly to general-query
  // so it picks up the AR 2026 board dump. Keep the raw query text so
  // Claude sees the full question (including month names like "April").
  if (
    /\b(cash|ar\b|accounts? receivable|owe(s|d)?|outstanding|overdue|aging|contract(ed)?|invoiced?|paid|balance|revenue|payment)\b/.test(
      text,
    )
  ) {
    return { skill: "general-query", args: { query: raw.trim() } };
  }

  // Production ETA
  if (
    /\b(ship(s|ping|ment)?|eta|when does|production (on|for)|delivery)\b/.test(text)
  ) {
    return { skill: "production-eta", args: { query: extractSubject(raw) } };
  }

  // Lead check
  if (
    /\b(gotten back|responded|reply|replied|any word|latest from|heard back)\b/.test(
      text,
    )
  ) {
    return { skill: "lead-check", args: { query: extractSubject(raw) } };
  }

  // Fleet health
  if (
    /\b(broken|failing|errors?|fleet|ai status|agents? (health|status))\b/.test(text)
  ) {
    return { skill: "agent-fleet-health", args: {} };
  }

  // Deal status ("what's up with X", "status of X", "where are we on X")
  if (
    /\b(status of|what'?s (up|going on) with|where are we on|tell me about|how'?s)\b/.test(
      text,
    )
  ) {
    return { skill: "deal-status", args: { query: extractSubject(raw) } };
  }

  // KB (process / how-to) — runs BEFORE find-in-vault so process
  // questions route to the Monday-hosted KB via Opus 4.7 with prompt
  // caching, instead of falling through to a vault text search.
  if (
    /\b(how do i|how does|what'?s the process|what'?s our|steps? (to|for)|walk me through|remind me how|procedure|sop|where do i|when should i|cadence|sequence|template|brand voice)\b/i.test(
      raw,
    )
  ) {
    return { skill: "kb-query", args: { query: raw.trim() } };
  }
  if (/^how\b/i.test(raw)) {
    return { skill: "kb-query", args: { query: raw.trim() } };
  }
  if (
    /\b(follow[- ]up|sendblue|intake|\/intake|\/bella|\/alex|\/operations|\/checks|\/quote)\b/i.test(
      raw,
    )
  ) {
    return { skill: "kb-query", args: { query: raw.trim() } };
  }

  // Vault lookup ("what do we know about X")
  if (/\b(what do we know|vault|find|look up)\b/.test(text)) {
    return { skill: "find-in-vault", args: { query: extractSubject(raw) } };
  }

  // Fallback: vault search with the full text as the query
  return { skill: "find-in-vault", args: { query: raw.trim() } };
}

/**
 * Read-intent overrides that use "update"/"note"/"log" as nouns
 * rather than verbs. These would otherwise be misclassified as
 * write intents. Returns true if the message is clearly asking
 * to read the updates feed, not to add to it.
 *
 * Examples that should match (all route to general-query):
 *   "Pull up the latest update on her contact"
 *   "Show me the most recent update on Rivertop"
 *   "What are the updates on that deal?"
 *   "Any recent notes on this lead?"
 *   "Read the last update"
 *   "What's on her contact"
 *   "Walk me through the updates"
 */
export function isReadNounIntent(text: string): boolean {
  // "the latest/last/most recent/any/all [note|update|comment]"
  // "pull up/show me/read the [update|note|comment]"
  // Core signal: update/note/log/comment used WITH a determiner
  // ("the", "any", "all", "recent") before it, or preceded by a
  // read verb ("pull", "show", "read", "see", "fetch").
  if (
    /\b(the|any|all|latest|recent|most recent|last)\s+(update|note|comment|message)s?\b/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(pull up|show me|read|fetch|see|bring up|display|tell me about|walk me through)\b.{0,40}\b(update|note|comment|message|contact|record|details?|info)/.test(
      text,
    )
  ) {
    return true;
  }
  // "what are the updates" / "is there any update" / "any recent notes"
  if (
    /\b(what|is there|are there|any)\b.{0,25}\b(update|note|comment)s?\b/.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Heuristic write-intent detector. Catches the common phrasings:
 *   - Explicit commands: "update ... in monday", "add to monday", "log that ...", "note that ..."
 *   - Action reports: "I'm meeting X", "spoke with X", "called X", "emailed X", "met with X"
 *   - First-person future actions that imply "record this": "meeting X tomorrow", "calling X friday"
 *
 * Intentionally generous — false positives route to the Claude parser,
 * which returns confidence=0 on non-write messages and the skill falls
 * back to clarify. False NEGATIVES are worse because they silently drop
 * the intent into `find-in-vault`, so we err on catching more.
 */
export function isWriteIntent(text: string): boolean {
  // Explicit write verbs directed at Monday or at Marco
  if (
    /\b(update|add|log|note|record|save|put|post|write|append)\b.{0,30}\b(monday|deal|contact|lead|card|it|this|that)\b/.test(
      text,
    )
  ) {
    return true;
  }
  // "Note that X" / "Log that X" / "Remember that X" without a target object
  if (/\b(note|log|remember)\s+(that|for)\b/.test(text)) {
    return true;
  }
  // "Make sure X is in Monday" / "make sure X is updated"
  if (
    /\bmake\s+sure\b.{0,40}\b(updat|on monday|in monday|reflect|note|log)/.test(
      text,
    )
  ) {
    return true;
  }
  // First-person action reports: "I'm meeting X", "I spoke with X", "I called X"
  // Trigger on past/present/future personal actions with a named object
  if (
    /\b(i'?m|i am|i)\s+(meeting|met with|spoke (with|to)|called|emailed|texted|messaged|saw|visited|toured|walking|reviewed|sent|quoted)\b/.test(
      text,
    )
  ) {
    return true;
  }
  // "Spoke with X" / "Met with X" without the leading "I"
  if (
    /^(spoke|met|called|emailed|texted|met with|talked to)\s+(with\s+)?[a-z]/.test(
      text,
    )
  ) {
    return true;
  }
  // "Can you" + action verb
  if (
    /\bcan you\b.{0,40}\b(updat|add|log|note|record|reflect|post|put)\b/.test(
      text,
    )
  ) {
    return true;
  }

  // ─── Russian write-intent keywords (for Alex P. / Alex T.) ───
  // Russian imperative write verbs: обнови/обновить, добавь/добавить,
  // отметь/отметить, запиши/записать, сохрани/сохранить, напиши.
  if (
    /(обнови|обновить|добавь|добавить|отметь|отметить|запиши|записать|сохрани|сохранить|напиши|написать|учти|учесть)/i.test(
      text,
    )
  ) {
    return true;
  }
  // Russian first-person action reports: "я звонил/звонила" (I called),
  // "я говорил/говорила" (I spoke), "я встретил/встретилась" (I met),
  // "я написал/написала" (I wrote/emailed), "я отправил" (I sent),
  // "встретился с" (met with), "созвонился" (had a call).
  if (
    /\b(я\s+(звонил|позвонил|говорил|поговорил|встретил|встретился|встретилась|написал|отправил|увидел|посмотрел|поговорила|звонила|позвонила)|встретился\s+с|созвонился|отправил)/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Pull the "subject" out of a sentence like "what's the status of Schellenberg"
 * → "Schellenberg". Naive but good enough to start.
 */
function extractSubject(raw: string): string {
  const m = raw.match(
    /(?:status of|up with|going on with|on|for|know about|from|about|does)\s+(.+?)(?:\?|$)/i,
  );
  if (m && m[1]) return m[1].trim();
  return raw.trim();
}

/**
 * Test hook: reset rate limiter state between unit tests.
 */
export function __resetTier3State() {
  tier3LastSeen.clear();
}
