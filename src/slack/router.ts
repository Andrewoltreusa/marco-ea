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
  | "clarify"
  | "refuse";

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
 * Very small keyword-based intent classifier. Good enough for v1.
 * If nothing matches, we fall back to `find-in-vault` for Tier 1/2
 * or to `clarify` if the message is ambiguous and short.
 *
 * A Claude-powered classifier lives behind this for edge cases — see
 * src/slack/intent-llm.ts (TBD in a follow-up PR).
 */
export function classifyIntent(
  raw: string,
): { skill: SkillName; args: Record<string, string> } {
  const text = raw.trim().toLowerCase();

  if (!text) return { skill: "clarify", args: { reason: "empty" } };

  // Cash / AR
  if (
    /\b(cash|ar\b|accounts receivable|owe(s|d)?|outstanding|overdue|aging)\b/.test(text)
  ) {
    return { skill: "cash-position", args: {} };
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

  // Vault lookup ("what do we know about X")
  if (/\b(what do we know|vault|find|look up)\b/.test(text)) {
    return { skill: "find-in-vault", args: { query: extractSubject(raw) } };
  }

  // Fallback: vault search with the full text as the query
  return { skill: "find-in-vault", args: { query: raw.trim() } };
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
