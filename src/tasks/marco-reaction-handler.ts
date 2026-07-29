/**
 * Trigger.dev task: comms/marco-reaction-handler
 *
 * Invoked by the Vercel webhook route when Slack sends a
 * `reaction_added` event on a message in a DM with Marco.
 *
 * Job:
 *   1. Ignore any emoji that isn't exactly ✅ or ❌ (before any Redis call).
 *   2. Tier-gate the reactor (before any Redis call) — Tier 3 is silent.
 *   3. Look up the draft in Redis by the reacted message's ts (one 2s retry).
 *   4. Refuse re-execution if the done-marker says this draft already posted.
 *   5. Verify: reactor == requester; Tier 1 >12h old → re-confirm once.
 *   6. Claim execution atomically, then run Monday create_update.
 *   7. Post confirmation, delete the draft, resolve the 📝 ack on the
 *      original request message — each step independent so one failure
 *      can't cascade into a double write or silence.
 *
 * Safety: verification failures never write to Monday. Deliberate ✅/❌
 * reactions are never met with silence.
 */

import { task, logger } from "@trigger.dev/sdk";
import { tierFor } from "../slack/allowlist.js";
import { createItemUpdate, type CreateUpdateResult } from "../../lib/monday.js";
import { postMessage, dmUser, swapReaction } from "../../lib/slack.js";
import {
  getDraft,
  deleteDraft,
  redis,
  type MondayUpdateDraft,
} from "../../lib/redis.js";

/**
 * Extra fields the draft task stores on the draft JSON beyond lib/redis.ts's
 * MondayUpdateDraft (storeDraft persists the object verbatim, so these
 * round-trip through Redis). Keep in sync with the copy in
 * marco-monday-update-draft.ts.
 */
interface DraftExtras {
  /** Channel of the original request message (for the 📝 → ✅/❌ swap). */
  originChannel?: string;
  /** ts of the original request message. */
  eventTs?: string;
  /** Set here when Tier 1 re-confirms a >12h draft. */
  reconfirmedAt?: string;
}

type StoredDraft = MondayUpdateDraft & DraftExtras;

/**
 * Durable write audit trail — every executed or failed Monday write,
 * newest first, capped at 500. Read back:
 *   LRANGE marco:log:write-incidents 0 -1
 */
async function logWriteIncident(entry: Record<string, unknown>): Promise<void> {
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

export interface ReactionPayload {
  /** The user who reacted. */
  reactorSlackId: string;
  /** Emoji name without colons (e.g. "white_check_mark", "x"). */
  reaction: string;
  /** ts of the message that was reacted to. */
  messageTs: string;
  /** Channel where the reaction happened (must be a DM with Marco). */
  channel: string;
}

// Binding decision (decisions/2026-04-15-phase-6a-level-2.md, flow step 9):
// approval is EXACTLY ✅ `white_check_mark`; rejection is EXACTLY ❌ `x`.
// The earlier permissive sets (+1, check, ballot_box_with_check, no_entry, …)
// let near-miss reactions trigger a Monday write — narrowed in Wave 1.
const APPROVE_EMOJIS = new Set(["white_check_mark"]);
const REJECT_EMOJIS = new Set(["x"]);

const draftKey = (previewTs: string) => `marco:draft:${previewTs}`;
const execClaimKey = (messageTs: string) => `marco:draft-exec:${messageTs}`;
const doneKey = (messageTs: string) => `marco:draft-done:${messageTs}`;
const outcomeKey = (messageTs: string) => `marco:draft-outcome:${messageTs}`;

export const marcoReactionHandler = task({
  id: "comms/marco-reaction-handler",
  maxDuration: 30,
  // Never retry: a crash after createItemUpdate but before deleteDraft
  // would re-run the whole task and double-post to Monday (the done-marker
  // is a second line of defense). The user can simply re-react if the
  // handler dies before executing.
  retry: { maxAttempts: 1 },
  run: async (payload: ReactionPayload) => {
    try {
      return await runReaction(payload);
    } catch (err) {
      // Never silent: a deliberate reaction that hits an unexpected error
      // gets a visible reply instead of a dead run in the dashboard.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("reaction handler threw", { error: msg });
      try {
        await postMessage({
          channel: payload.channel,
          text: "I couldn't process that reaction — try again, or check Monday directly.",
          thread_ts: payload.messageTs,
        });
      } catch {
        // even the error reply failed — the run log is the only record
      }
      return { ok: false, error: msg };
    }
  },
});

async function runReaction(payload: ReactionPayload) {
  logger.info("reaction received", { ...payload });

  // Fast reject BEFORE any Redis call: only the two decision emojis matter.
  const approved = APPROVE_EMOJIS.has(payload.reaction);
  const rejected = REJECT_EMOJIS.has(payload.reaction);
  if (!approved && !rejected) {
    return { ok: true, ignored: "unrelated_reaction" };
  }

  // Tier-gate the reactor FIRST (before any Redis touch). Tier 3 reactors
  // are ignored silently — no reply, no draft lookup.
  const reactorTier = tierFor(payload.reactorSlackId);
  if (reactorTier !== 1 && reactorTier !== 2) {
    logger.warn("reactor not in allowlist", { user: payload.reactorSlackId });
    return { ok: true, ignored: "reactor_not_allowlisted" };
  }

  // Look up the draft by the reacted-to message ts. One 2s retry closes
  // the race where the preview is reacted to before storeDraft lands.
  let draft = (await getDraft(payload.messageTs)) as StoredDraft | null;
  if (!draft) {
    await new Promise((r) => setTimeout(r, 2000));
    draft = (await getDraft(payload.messageTs)) as StoredDraft | null;
  }

  // Done-marker: this preview's update already landed on Monday (set the
  // instant createItemUpdate succeeds, and it survives a failed
  // deleteDraft). Never execute the same draft twice.
  const alreadyDone = await redis().get(doneKey(payload.messageTs));
  if (alreadyDone) {
    await postMessage({
      channel: payload.channel,
      text: "Already posted to Monday.",
      thread_ts: payload.messageTs,
    });
    return { ok: true, ignored: "already_posted" };
  }

  if (!draft) {
    // A deliberate ✅/❌ must never be met with silence.
    logger.info("no draft found for message ts", { ts: payload.messageTs });
    await postMessage({
      channel: payload.channel,
      text: "I don't have a pending draft for this message — it may have expired.",
      thread_ts: payload.messageTs,
    });
    return { ok: true, ignored: "no_draft" };
  }

  // Critical: the reactor must be the same user who asked for the draft.
  // This prevents Bella approving Andrew's draft and vice versa.
  if (payload.reactorSlackId !== draft.requesterSlackId) {
    logger.warn("reactor != requester", {
      reactor: payload.reactorSlackId,
      requester: draft.requesterSlackId,
    });
    return { ok: true, ignored: "wrong_reactor" };
  }

  // ❌ → cancel the draft.
  if (rejected) {
    await deleteDraft(draft.previewTs);
    await postMessage({
      channel: draft.previewChannel,
      text: `Cancelled — didn't post to *${draft.monday.itemName}*.`,
      thread_ts: draft.previewTs,
    });
    // Resolve the 📝 ack on the original request message (best-effort —
    // swapReaction swallows its own failures).
    if (draft.originChannel && draft.eventTs) {
      await swapReaction(draft.originChannel, draft.eventTs, "memo", "x");
    }
    return { ok: true, cancelled: true };
  }

  // ✅ but the draft may be stale. Tier-1 drafts live 24h in Redis; per
  // decisions/2026-04-15-phase-6a-level-2.md (flow step 9), execution
  // without re-confirm is only allowed ≤12h from createdAt. Between 12h
  // and 24h the FIRST ✅ stamps `reconfirmedAt` and asks again; the SECOND
  // ✅ (reconfirmedAt already set) proceeds to execute.
  const ageMs = Date.now() - new Date(draft.createdAt).getTime();
  const twelveHoursMs = 12 * 60 * 60 * 1000;

  if (draft.requesterTier === 1 && ageMs >= twelveHoursMs && !draft.reconfirmedAt) {
    draft.reconfirmedAt = new Date().toISOString();
    // Re-store WITHOUT resetting the TTL — the 24h hard cutoff stands.
    try {
      await redis().set(draftKey(draft.previewTs), draft, { keepTtl: true });
    } catch {
      // Fallback if KEEPTTL is unavailable: re-apply the remaining TTL.
      const remaining = await redis().ttl(draftKey(draft.previewTs));
      if (remaining > 0) {
        await redis().set(draftKey(draft.previewTs), draft, { ex: remaining });
      }
    }
    await postMessage({
      channel: draft.previewChannel,
      text:
        `This draft is ${Math.round(ageMs / (60 * 60 * 1000))} hours old — ` +
        `the context may be stale. React ✅ **again** to confirm, or react ❌ to cancel.`,
      thread_ts: draft.previewTs,
    });
    return { ok: true, reconfirm_requested: true };
  }

  // Atomic execution claim: two near-simultaneous ✅ events (Slack retry,
  // double-tap, duplicate delivery) must not both reach createItemUpdate.
  const won = await redis().set(execClaimKey(payload.messageTs), payload.reactorSlackId, {
    nx: true,
    ex: 300,
  });
  if (won !== "OK") {
    await postMessage({
      channel: draft.previewChannel,
      text: "This draft is already being processed.",
      thread_ts: draft.previewTs,
    });
    return { ok: true, ignored: "exec_claimed" };
  }

  // ─── try#1: the Monday write ──────────────────────────────
  let result: CreateUpdateResult;
  try {
    result = await createItemUpdate({
      itemId: draft.monday.itemId,
      body: draft.updateBody,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("monday create_update failed", { err: msg });

    if (/timeout|abort/i.test(msg)) {
      // Ambiguous outcome: the request may have landed AFTER the timeout.
      // Keep the exec claim (its 5-min TTL blocks an immediate re-✅) and
      // make the human verify on Monday before approving again.
      try {
        await redis().set(outcomeKey(payload.messageTs), "unknown", {
          ex: 24 * 60 * 60,
        });
      } catch {
        // marker is best-effort — the exec claim still blocks retries
      }
      await logWriteIncident({
        outcome: "unknown",
        approvedBy: payload.reactorSlackId,
        requester: draft.requesterSlackId,
        tier: draft.requesterTier,
        board: draft.monday.boardName,
        item: draft.monday.itemName,
        error: msg.slice(0, 300),
      });
      await postMessage({
        channel: draft.previewChannel,
        text: "I couldn't confirm whether Monday accepted that update — please CHECK the Monday card before approving again.",
        thread_ts: draft.previewTs,
      });
      return { ok: false, outcome: "unknown" };
    }

    // Clear failure: release the exec claim so a retry ✅ can work.
    await logWriteIncident({
      outcome: "failed",
      approvedBy: payload.reactorSlackId,
      requester: draft.requesterSlackId,
      tier: draft.requesterTier,
      board: draft.monday.boardName,
      item: draft.monday.itemName,
      error: msg.slice(0, 300),
    });
    try {
      await redis().del(execClaimKey(payload.messageTs));
    } catch {
      // claim expires in 300s on its own
    }
    await postMessage({
      channel: draft.previewChannel,
      text: `Failed to post the update: ${msg}`,
      thread_ts: draft.previewTs,
    });
    // Leave the draft in Redis so the requester can see it didn't land.
    return { ok: false, error: msg };
  }

  // Success. Mark done IMMEDIATELY — before ANY Slack call — so a crash or
  // failed deleteDraft below can never lead to a second execution.
  try {
    await redis().set(
      doneKey(payload.messageTs),
      { updateId: result.updateId, at: new Date().toISOString() },
      { ex: 24 * 60 * 60 },
    );
  } catch (err) {
    // The exec claim (never deleted on success) still blocks re-execution
    // for its 5-min TTL; log loudly and continue to the confirmation.
    logger.error("failed to set done-marker", { err: String(err) });
  }
  await logWriteIncident({
    outcome: "posted",
    approvedBy: payload.reactorSlackId,
    requester: draft.requesterSlackId,
    tier: draft.requesterTier,
    board: result.boardName,
    item: result.itemName,
    updateId: result.updateId,
  });

  // ─── try#2: Slack confirmation (independent of the write) ──
  const confirmation =
    `Posted to *${result.itemName}* (${result.boardName}). ` +
    `<${result.url}|View on Monday>`;
  try {
    await postMessage({
      channel: draft.previewChannel,
      text: confirmation,
      thread_ts: draft.previewTs,
    });
  } catch (err) {
    logger.error("confirmation postMessage failed", { err: String(err) });
    try {
      await dmUser(draft.requesterSlackId, confirmation);
    } catch (err2) {
      logger.error("confirmation DM fallback failed", { err: String(err2) });
    }
  }

  // ─── try#3: draft cleanup (independent) ────────────────────
  try {
    await deleteDraft(draft.previewTs);
  } catch (err) {
    // The done-marker check at the top blocks re-execution of this draft.
    logger.error("deleteDraft failed — done-marker protects re-execution", {
      err: String(err),
    });
  }

  // Resolve the 📝 ack on the original request message (best-effort).
  if (draft.originChannel && draft.eventTs) {
    await swapReaction(draft.originChannel, draft.eventTs, "memo", "white_check_mark");
  }

  return { ok: true, posted: true, updateId: result.updateId };
}
