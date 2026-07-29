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

export function redis(): Redis {
  if (_client) return _client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set. " +
        "These are shared with oltre-agents — copy them into Marco's Trigger.dev env.",
    );
  }
  _client = new Redis({ url, token });
  return _client;
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

interface RequestState {
  status: "processing" | "responded";
  startedAt: string;
  respondedAt?: string;
}

const REQ_TTL_SEC = 900; // covers Slack's retry ladder
const STALE_PROCESSING_MS = 120_000; // = inbound maxDuration

export type BeginRequestResult = "fresh" | "duplicate" | "takeover";

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
    await r.set(key, state, { ex: REQ_TTL_SEC });
    return "fresh";
  }
  if (existing.status === "responded") return "duplicate";

  const ageMs = Date.now() - new Date(existing.startedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > STALE_PROCESSING_MS) {
    // Previous worker died mid-run — take over and re-process.
    await r.set(key, state, { ex: REQ_TTL_SEC });
    return "takeover";
  }
  return "duplicate";
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
const USER_DRAFT_KEY = (slackId: string) => `marco:user-draft:${slackId}`;

export async function storeDraft(draft: MondayUpdateDraft): Promise<void> {
  const ttlSec =
    draft.requesterTier === 1 ? 12 * 60 * 60 : 2 * 60 * 60;
  await redis().set(DRAFT_KEY(draft.previewTs), draft, { ex: ttlSec });

  // Tier 2: enforce one-active-draft-per-user by tracking the latest preview ts
  // under a per-user key with the same TTL.
  if (draft.requesterTier === 2) {
    await redis().set(USER_DRAFT_KEY(draft.requesterSlackId), draft.previewTs, {
      ex: ttlSec,
    });
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
    // Only clear the user pointer if it still matches — avoids clobbering a
    // newer draft that happened to land while we were processing this one.
    const current = (await redis().get(
      USER_DRAFT_KEY(draft.requesterSlackId),
    )) as string | null;
    if (current === previewTs) {
      await redis().del(USER_DRAFT_KEY(draft.requesterSlackId));
    }
  }
}

/** For Tier 2 one-draft-at-a-time enforcement. Returns the active preview ts or null. */
export async function getActiveDraftForUser(
  slackId: string,
): Promise<MondayUpdateDraft | null> {
  const previewTs = (await redis().get(USER_DRAFT_KEY(slackId))) as
    | string
    | null;
  if (!previewTs) return null;
  return getDraft(previewTs);
}
