/**
 * Durable audit trails — Redis lists, newest first, bounded. Redis, not
 * local files: Trigger.dev cloud's filesystem is ephemeral.
 *
 * Shared by the inbound parent, the draft child, the reaction handler,
 * and the write watchdog so every path records against the same trail.
 * Strictly best-effort: an audit failure must never affect a reply that
 * was already delivered.
 */

import { redis } from "./redis.js";

/**
 * Per-request audit record (CODEX finding 32). One JSON entry per handled
 * request — refusals, drafts, reads, and failures alike. For the write
 * path the CHILD writes the terminal record; the parent records only
 * enqueue failures. Read back: LRANGE marco:audit:requests 0 -1
 *
 * `ok` contract: ok = the request was handled to a SUCCESSFUL terminal
 * state (answer/preview/clarify delivered, or a deliberate rate-limited
 * silence). A delivered ERROR reply is still ok:false — never-silent is
 * a delivery guarantee, not a success.
 */
export interface RequestAuditRecord {
  ts: string;
  eventId: string | null;
  user: string;
  tier: number;
  skill: string;
  ok: boolean;
  ms: number;
}

export async function auditRequest(rec: RequestAuditRecord): Promise<void> {
  try {
    const r = redis();
    await r.lpush("marco:audit:requests", JSON.stringify(rec));
    await r.ltrim("marco:audit:requests", 0, 999);
  } catch (err) {
    console.warn(
      "[marco audit] request audit failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Write audit trail — every executed, failed, reconciled, or lost Monday
 * write, newest first, capped at 500. Read back:
 *   LRANGE marco:log:write-incidents 0 -1
 */
export async function logWriteIncident(
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    const r = redis();
    await r.lpush(
      "marco:log:write-incidents",
      JSON.stringify({ ts: new Date().toISOString(), ...entry }),
    );
    await r.ltrim("marco:log:write-incidents", 0, 499);
  } catch {
    // audit log must never break the write path
  }
}
