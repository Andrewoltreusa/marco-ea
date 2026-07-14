/**
 * Deliverable storage for Marco's scheduled skills.
 *
 * The original SKILL.md specs wrote artifacts to the local deliverables/
 * folder — but Marco runs on Trigger.dev cloud, whose filesystem is
 * ephemeral. Redis is the durable store the running tasks can actually
 * reach. Keys: `marco:deliverable:<YYYY-MM-DD>-<name>`, 30-day TTL.
 *
 * To read one back: redis().get("marco:deliverable:2026-07-14-morning-brief")
 */

import { redis } from "./redis.js";

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function deliverableKey(name: string, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return `marco:deliverable:${d}-${name}`;
}

export async function saveDeliverable(
  name: string,
  body: string,
  date?: string,
): Promise<string> {
  const key = deliverableKey(name, date);
  await redis().set(key, body, { ex: TTL_SECONDS });
  return key;
}

/** List helper for ops spelunking — most recent deliverable of a given name. */
export async function getDeliverable(
  name: string,
  date?: string,
): Promise<string | null> {
  const raw = (await redis().get(deliverableKey(name, date))) as string | null;
  return raw ?? null;
}
