/**
 * Write-delegation outbox — the watchdog's ledger of in-flight
 * monday-update children.
 *
 * The inbound parent LPUSHes one entry per delegated draft; the child
 * sets `marco:outbox-done:<key>` after its terminal user-visible reply.
 * The watchdog (src/tasks/marco-write-watchdog.ts) treats a done-marker
 * absence 5 minutes after enqueue as a lost child: no Trigger.dev API
 * dependency, just Redis.
 */

import { redis } from "./redis.js";

export const OUTBOX_KEY = "marco:outbox:write-delegations";

/**
 * Done-marker key. `key` is the request lifecycleKey when present,
 * otherwise the child run id (legacy route deploys that send no
 * eventTs/eventId) — both sides must apply the same fallback or every
 * legacy entry would false-alarm.
 */
export const outboxDoneKey = (key: string) => `marco:outbox-done:${key}`;

/**
 * Started-marker key — written as the FIRST action of the child run.
 * Lets the watchdog tell "child never started (queue delay)" apart from
 * "child died mid-run": only the latter is a loss at the 5-minute mark.
 */
export const outboxStartedKey = (key: string) => `marco:outbox-started:${key}`;

/** TTL for both markers: outlives any realistic sweep backlog. */
export const OUTBOX_MARKER_TTL_SEC = 86_400;

export interface OutboxEntry {
  lifecycleKey: string | null;
  childRunId: string;
  requester: string;
  channel: string;
  eventTs: string | null;
  /** ISO time the delegation was enqueued. */
  ts: string;
}

/**
 * Canonical serialization: LREM matches by exact string, so LPUSH and
 * LREM must both go through here (fixed field order, no whitespace).
 */
export function serializeOutboxEntry(entry: OutboxEntry): string {
  return JSON.stringify({
    lifecycleKey: entry.lifecycleKey,
    childRunId: entry.childRunId,
    requester: entry.requester,
    channel: entry.channel,
    eventTs: entry.eventTs,
    ts: entry.ts,
  });
}

/**
 * Parse an LRANGE element. @upstash/redis auto-deserializes JSON list
 * elements into objects, so `raw` is usually already an object; a plain
 * string is tolerated for safety. Returns null on any shape mismatch.
 */
export function parseOutboxEntry(raw: unknown): OutboxEntry | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;
  const e = obj as Record<string, unknown>;
  if (typeof e.childRunId !== "string" || !e.childRunId) return null;
  if (typeof e.requester !== "string" || !e.requester) return null;
  if (typeof e.channel !== "string") return null;
  if (typeof e.ts !== "string" || !e.ts) return null;
  return {
    lifecycleKey: typeof e.lifecycleKey === "string" ? e.lifecycleKey : null,
    childRunId: e.childRunId,
    requester: e.requester,
    channel: e.channel,
    eventTs: typeof e.eventTs === "string" ? e.eventTs : null,
    ts: e.ts,
  };
}

export async function pushOutboxEntry(entry: OutboxEntry): Promise<void> {
  const r = redis();
  await r.lpush(OUTBOX_KEY, serializeOutboxEntry(entry));
  await r.ltrim(OUTBOX_KEY, 0, 199);
}

// ─────────────────────────────────────────────────────────────
// Watchdog triage (pure)
// ─────────────────────────────────────────────────────────────

/**
 * A STARTED child that hasn't finalized within 5 minutes died mid-run —
 * its maxDuration is 60s, so even a slow run has finished or died well
 * inside this window.
 */
export const OUTBOX_STALE_MS = 5 * 60 * 1000;

/**
 * A child with NO started marker may simply be queue-delayed (Trigger.dev
 * backlog); it only counts as lost after 30 minutes.
 */
export const OUTBOX_QUEUE_DELAY_MS = 30 * 60 * 1000;

export type OutboxTriage = "keep" | "remove_done" | "fail";

/**
 * Triage table:
 *   done marker present            → remove_done (child delivered), any age
 *   started but no done            → child died mid-run: fail past 5 min
 *   no started marker              → queue-delayed: fail only past 30 min
 * An unparseable ts can't prove youth, so it is treated as old.
 */
export function triageOutboxEntry(
  entry: OutboxEntry,
  markers: { done: boolean; started: boolean },
  nowMs: number,
): OutboxTriage {
  if (markers.done) return "remove_done";
  const ageMs = nowMs - Date.parse(entry.ts);
  const threshold = markers.started ? OUTBOX_STALE_MS : OUTBOX_QUEUE_DELAY_MS;
  if (Number.isFinite(ageMs) && ageMs <= threshold) return "keep";
  return "fail";
}
