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
  // "find-in-vault" is no longer produced by the classifier (it was only
  // ever a label for the general-query path — CODEX finding 19). The
  // member stays so runSkill's compat case still typechecks.
  | "find-in-vault"
  | "board-stats"
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

// Reworded per Andrew 2026-08-13 (decisions/log.md) — the old "I'm not
// configured to respond to you" read as robotic; the new text explains the
// mechanism (approved list) and the path onto it, and still promises nothing.
const REFUSAL_TEXT =
  "I'm Marco, Oltre's company secretary. I can only help teammates on my " +
  "approved list, and you're not on it yet — ask Andrew Shpiruk if you think " +
  "you should be.";

// In-memory Tier-3 rate limiter — process-local FALLBACK only. Every
// Trigger.dev run is a fresh process, so this Map alone cannot hold the
// 24h window across runs. The durable gate lives in the inbound task:
// SET marco:tier3:refused:<userId> NX EX 86400 — the refusal posts only
// when that SET wins. This Map's verdict is consulted only when Redis is
// unavailable (see tier3ShouldPost). Keyed by slackUserId →
// lastRefusalEpochMs.
const tier3LastSeen = new Map<string, number>();
const TIER3_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Final verdict on whether a Tier-3 refusal may post, combining the
 * durable Redis gate with the in-memory fallback above. Pure — the
 * inbound task performs the actual SET and passes the outcome here.
 *
 *   redisSetOk === true  → this run won the 24h key: post.
 *   redisSetOk === false → another run already refused within 24h: silent.
 *   redisSetOk === null  → Redis unavailable: fall back to the router's
 *                          process-local Map verdict.
 */
export function tier3ShouldPost(opts: {
  inMemoryRateLimited: boolean;
  redisSetOk: boolean | null;
}): boolean {
  if (opts.redisSetOk !== null) return opts.redisSetOk;
  return !opts.inMemoryRateLimited;
}

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

  // Objection quick-draw — "objection: too expensive" returns the exact
  // 3A script from the sales playbook (KB section 19) in one hop. Built
  // for Bella mid-call; anchored at ^, so it runs before EVERY other
  // rule — "objection: they want to log this on the account" must never
  // draft a Monday update.
  const objMatch = raw.match(/^\s*(?:objection|возражение)\s*[:—–-]?\s*(.+)$/i);
  if (objMatch) {
    return {
      skill: "kb-query",
      args: {
        query:
          `From the Objection Handling section of the sales playbook, give the exact 3A script ` +
          `(Acknowledge / Associate / Attack the frame) and the branch response for this objection: ${objMatch[1].trim()}. ` +
          `Answer with the script itself, ready to say out loud, not a description of it.`,
      },
    };
  }

  // Explicit "log on/against <item>" commands — checked BEFORE the
  // read-noun override so a body that happens to contain "the latest
  // update" can't get swallowed into the read path. Live incident
  // 2026-07: "Log on C26100: pickup confirmed" fell through to the read
  // path and the model then CLAIMED it had logged the note.
  if (isExplicitLogCommand(text)) {
    return { skill: "monday-update", args: { query: raw.trim() } };
  }

  // ─────────────────────────────────────────────────────────
  // READ-intent overrides — catch "update" as a noun
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

  // PROCESS questions go to the KB (the 14-SOP canon, sections 25-32) —
  // "how do we handle an aged invoice" wants BILLING-001's ladder, not the
  // AR board dump, so this runs BEFORE the cash/AR rule. Data questions
  // ("how much is outstanding", "who owes us") fall through to cash/AR.
  // Live gap found 2026-08-13: "what is the process for a damage claim?"
  // had no KB route at all and fell to general-query.
  if (
    /\b(what(?:'s| is) the (?:process|procedure|policy|sop)|process for|procedure for|how (?:do|does|should) (?:we|i|you)|what do (?:we|i) do (?:when|if))\b/i.test(
      text,
    )
  ) {
    return { skill: "kb-query", args: { query: raw.trim() } };
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

  // Board-aggregate questions — counted in code by board-stats, never by
  // the model. Must run BEFORE lead-check ("how many leads replied?"),
  // BEFORE the `^how` KB rule, and BEFORE the general fallback — CODEX
  // finding 18: "how many leads do we have?" used to land in kb-query.
  if (
    /\bhow many (deals|leads|contacts)\b/i.test(text) ||
    /\b(deals|leads) (are )?(closing|due|expected)\b/i.test(text) ||
    /\bcount\b.*\b(deals|leads|contacts)\b/i.test(text)
  ) {
    return { skill: "board-stats", args: { query: raw.trim() } };
  }

  // Production ETA
  if (
    /\b(ship(s|ping|ment)?|eta|when does|production (on|for)|delivery)\b/.test(text)
  ) {
    return { skill: "production-eta", args: { query: extractSubject(raw) } };
  }

  // Dealer-process questions → KB (sections 23-24: dealer program + reply
  // workflow). Must run BEFORE lead-check: "a dealer just replied, what do
  // I do?" contains "repl…" and would otherwise misroute to lead-check
  // (which happened live 2026-07-14).
  if (
    /\bdealers?\b/i.test(text) &&
    /\b(reply|replied|responds?|responded|what should|what do|how do|process|next step)\b/i.test(text)
  ) {
    return { skill: "kb-query", args: { query: raw.trim() } };
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

  // KB (process / how-to) — runs BEFORE the general fallback so process
  // questions route to the Monday-hosted KB with prompt caching instead
  // of falling through to a Monday-wide general query.
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

  // Fallback — including "what do we know about X". Routed to
  // general-query DIRECTLY: the runtime always redirected the old
  // "find-in-vault" label here anyway (no vault indexer exists — CODEX
  // finding 19), so the label now says what actually happens.
  return { skill: "general-query", args: { query: raw.trim() } };
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
 * Explicit "log on <item>" / "log this on/against <item>" / "запиши на
 * <item>" commands. These are unambiguous write requests: the target item
 * follows the preposition and the body follows the colon/dash. Kept as
 * its own predicate because classifyIntent must check it BEFORE the
 * read-noun override (live incident 2026-07: "Log on C26100: pickup
 * confirmed" misrouted to the read path and the model claimed a write it
 * never performed).
 *
 * The `(?<!\bthe\s)` guard keeps "show me the log on C26100" (a read of
 * the updates feed) out of the write path.
 */
export function isExplicitLogCommand(text: string): boolean {
  if (
    /(?<!\bthe\s)\blog\s+(?:this\s+|that\s+|it\s+)?(?:on|against)\s+\S+/i.test(
      text,
    )
  ) {
    return true;
  }
  // Russian: "запиши(те) (это) на C26100: ..." — no \b: JS word
  // boundaries are ASCII-only and never match next to Cyrillic.
  if (/запиши(?:те)?\s+(?:это\s+)?на\s+\S+/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Heuristic write-intent detector. Catches the common phrasings:
 *   - Explicit commands: "update ... in monday", "add to monday", "log that ...", "note that ..."
 *   - Targeted log commands: "log on C26100: ...", "log this against C26100"
 *   - Action reports: "I'm meeting X", "spoke with X", "called X", "emailed X", "met with X"
 *   - First-person future actions that imply "record this": "meeting X tomorrow", "calling X friday"
 *
 * Intentionally generous — false positives route to the Claude parser,
 * which returns confidence=0 on non-write messages and the skill falls
 * back to clarify. False NEGATIVES are worse because they silently drop
 * the intent into the general fallback, so we err on catching more.
 */
export function isWriteIntent(text: string): boolean {
  // Targeted "log on/against <item>" commands (also checked earlier in
  // classifyIntent, before the read-noun override).
  if (isExplicitLogCommand(text)) {
    return true;
  }
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
 * Trailing verb tokens that leak into the naive subject extraction:
 * "when does Schellenberg ship?" extracts "Schellenberg ship", and the
 * verb ruins the fuzzy board match (CODEX finding 18).
 */
const TRAILING_SUBJECT_VERBS =
  /\s+(?:ship|shipping|shipped|close|closing|reply|replied)\s*$/i;

/**
 * Pull the "subject" out of a sentence like "what's the status of Schellenberg"
 * → "Schellenberg". Naive but good enough to start.
 */
function extractSubject(raw: string): string {
  const m = raw.match(
    /(?:status of|up with|going on with|on|for|know about|from|about|does)\s+(.+?)(?:\?|$)/i,
  );
  const subject = m && m[1] ? m[1].trim() : raw.trim();
  // Strip trailing verb tokens ("Schellenberg ship" → "Schellenberg"),
  // but never strip down to an empty subject.
  let stripped = subject;
  while (TRAILING_SUBJECT_VERBS.test(stripped)) {
    stripped = stripped.replace(TRAILING_SUBJECT_VERBS, "").trim();
  }
  return stripped.length > 0 ? stripped : subject;
}

/**
 * Test hook: reset rate limiter state between unit tests.
 */
export function __resetTier3State() {
  tier3LastSeen.clear();
}
