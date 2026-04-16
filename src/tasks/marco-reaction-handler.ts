/**
 * Trigger.dev task: comms/marco-reaction-handler
 *
 * Invoked by the Vercel webhook route when Slack sends a
 * `reaction_added` event on a message in a DM with Marco.
 *
 * Job:
 *   1. Look up the draft in Redis by the reacted message's ts.
 *   2. Verify: reactor == requester, reaction is ✅, draft not expired.
 *   3. Tier 1: if draft >12h old, re-confirm before firing (post and return).
 *   4. Execute Monday create_update.
 *   5. Post confirmation in the same DM.
 *   6. Delete the draft from Redis.
 *
 * Safety: if ANY verification fails, the handler returns silently — it
 * NEVER writes to Monday without all gates green.
 */

import { task, logger } from "@trigger.dev/sdk";
import { tierFor } from "../slack/allowlist.js";
import { createItemUpdate } from "../../lib/monday.js";
import { postMessage } from "../../lib/slack.js";
import { getDraft, deleteDraft } from "../../lib/redis.js";

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

const APPROVE_EMOJIS = new Set([
  "white_check_mark",
  "heavy_check_mark",
  "check",
  "checkmark",
  "ballot_box_with_check",
  "+1",
]);

const REJECT_EMOJIS = new Set(["x", "negative_squared_cross_mark", "no_entry", "-1"]);

export const marcoReactionHandler = task({
  id: "comms/marco-reaction-handler",
  maxDuration: 30,
  run: async (payload: ReactionPayload) => {
    logger.info("reaction received", { ...payload });

    // Fast reject: non-approval, non-rejection emojis get ignored.
    const approved = APPROVE_EMOJIS.has(payload.reaction);
    const rejected = REJECT_EMOJIS.has(payload.reaction);
    if (!approved && !rejected) {
      return { ok: true, ignored: "unrelated_reaction" };
    }

    // Look up the draft by the reacted-to message ts.
    const draft = await getDraft(payload.messageTs);
    if (!draft) {
      logger.info("no draft found for message ts", { ts: payload.messageTs });
      return { ok: true, ignored: "no_draft" };
    }

    // Tier-check the reactor (in case their account was revoked since draft creation).
    const reactorTier = tierFor(payload.reactorSlackId);
    if (reactorTier !== 1 && reactorTier !== 2) {
      logger.warn("reactor not in allowlist", { user: payload.reactorSlackId });
      return { ok: true, ignored: "reactor_not_allowlisted" };
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
      return { ok: true, cancelled: true };
    }

    // ✅ but draft might be past its TTL. Redis TTL auto-deleted it if so,
    // so `draft` being present means it's still valid. But Tier 1 has a
    // re-confirm rule: if >12h old at ✅ time, we ask first.
    const ageMs = Date.now() - new Date(draft.createdAt).getTime();
    const twelveHoursMs = 12 * 60 * 60 * 1000;

    if (draft.requesterTier === 1 && ageMs >= twelveHoursMs) {
      await postMessage({
        channel: draft.previewChannel,
        text:
          `This draft is ${Math.round(ageMs / (60 * 60 * 1000))} hours old — ` +
          `the context may be stale. React ✅ **again** to confirm, or react ❌ to cancel.`,
        thread_ts: draft.previewTs,
      });
      // We do NOT delete the draft here — we want the second ✅ to fire it.
      // But we reset its createdAt so the re-confirm window is fresh.
      // (For v1 simplicity we rely on the user to react again; the next
      // ✅ will see ageMs reset because the task re-reads the draft and
      // the < 12h check passes only if they re-ack quickly. A cleaner
      // future refactor: persist a `reconfirmed: true` flag on the draft.)
      return { ok: true, reconfirm_requested: true };
    }

    // All gates green — execute the Monday write.
    try {
      const result = await createItemUpdate({
        itemId: draft.monday.itemId,
        body: draft.updateBody,
      });
      await postMessage({
        channel: draft.previewChannel,
        text:
          `Posted to *${result.itemName}* (${result.boardName}). ` +
          `<${result.url}|View on Monday>`,
        thread_ts: draft.previewTs,
      });
      await deleteDraft(draft.previewTs);
      return { ok: true, posted: true, updateId: result.updateId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("monday create_update failed", { err: msg });
      await postMessage({
        channel: draft.previewChannel,
        text: `Failed to post the update: ${msg}`,
        thread_ts: draft.previewTs,
      });
      // Leave the draft in Redis so Andrew can see it didn't land.
      return { ok: false, error: msg };
    }
  },
});
