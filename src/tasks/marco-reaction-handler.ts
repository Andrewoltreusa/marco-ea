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
 *   4. Read the draft's lifecycle state (marco:draft-state:<ts>,
 *      lib/draft-state.ts) — lazily initialized for pre-deploy drafts.
 *   5. Verify: reactor == requester; Tier 1 ≥12h old → re-confirm once.
 *   6. Decide via the pure transition table (decideReaction), apply the
 *      decision with an atomic CAS transition, and on a lost race re-read
 *      and re-decide (bounded).
 *   7. Ambiguous or orphaned outcomes reconcile against the item's own
 *      Monday updates feed before any retry or cancel is allowed.
 *   8. Post confirmation, delete the draft, resolve the 📝 ack on the
 *      original request message — each step independent so one failure
 *      can't cascade into a double write or silence.
 *
 * Safety: verification failures never write to Monday. Deliberate ✅/❌
 * reactions are never met with silence. Exactly-once: only the run that
 * wins the pending→executing (or reconciled unknown→executing) CAS may
 * call createItemUpdate.
 */

import { task, logger } from "@trigger.dev/sdk";
import { tierFor } from "../slack/allowlist.js";
import {
  createItemUpdate,
  getItemUpdates,
  classifyMondayFailure,
  type CreateUpdateResult,
} from "../../lib/monday.js";
import { postMessage, dmUser, swapReaction } from "../../lib/slack.js";
import {
  getDraft,
  deleteDraft,
  beginRequest,
  type MondayUpdateDraft,
} from "../../lib/redis.js";
import {
  getDraftState,
  initDraftState,
  transition,
  decideReaction,
  decideReconcileAbsent,
  computeBodyHash,
  matchUpdateBody,
  slackTsToMs,
  type DraftState,
  type ReactionKind,
  type ReplyClass,
  type TransitionResult,
} from "../../lib/draft-state.js";
import { logWriteIncident } from "../../lib/audit.js";
import { beginTaskBudget } from "../../lib/deadline.js";

/**
 * Extra fields the draft task stores on the draft JSON beyond
 * lib/redis.ts's MondayUpdateDraft (storeDraft persists the object
 * verbatim, so these round-trip through Redis). Keep in sync with the
 * copy in marco-monday-update-draft.ts. The draft is immutable after
 * storeDraft — mutable lifecycle data lives in marco:draft-state:<ts>.
 */
interface DraftExtras {
  /** Channel of the original request message (for the 📝 → ✅/❌ swap). */
  originChannel?: string;
  /** ts of the original request message. */
  eventTs?: string;
}

type StoredDraft = MondayUpdateDraft & DraftExtras;

export interface ReactionPayload {
  /** The user who reacted. */
  reactorSlackId: string;
  /** Emoji name without colons (e.g. "white_check_mark", "x"). */
  reaction: string;
  /** ts of the message that was reacted to. */
  messageTs: string;
  /** Channel where the reaction happened (must be a DM with Marco). */
  channel: string;
  /** Slack event_id of the reaction event — request-level dedup. Optional: older route deploys don't send it. */
  eventId?: string;
  /** Slack event_ts of the reaction EVENT (not the message) — gates the re-confirm second-✅. */
  eventTs?: string;
}

// Binding decision (decisions/2026-04-15-phase-6a-level-2.md, flow step 9):
// approval is EXACTLY ✅ `white_check_mark`; rejection is EXACTLY ❌ `x`.
// The earlier permissive sets (+1, check, ballot_box_with_check, no_entry, …)
// let near-miss reactions trigger a Monday write — narrowed in Wave 1.
const APPROVE_EMOJIS = new Set(["white_check_mark"]);
const REJECT_EMOJIS = new Set(["x"]);

// 120s: draft fetch retry (2s) + reconciliation query + Monday write
// (both clamped at 25s) + several Slack posts. The old 30s could not fit
// the reconciliation path.
const MAX_DURATION_SEC = 120;

/** CAS lost races are rare; two re-decides cover any realistic interleaving. */
const MAX_DECISION_PASSES = 3;

const mondayItemUrl = (boardId: string, itemId: string) =>
  `https://oregonfivestar-company.monday.com/boards/${boardId}/pulses/${itemId}`;

export const marcoReactionHandler = task({
  id: "comms/marco-reaction-handler",
  maxDuration: MAX_DURATION_SEC,
  // Never retry: a crash after createItemUpdate but before the posted
  // transition would re-run the whole task; the state machine plus
  // reconciliation is the defense, not platform retries.
  retry: { maxAttempts: 1 },
  run: async (payload: ReactionPayload, { ctx }) => {
    beginTaskBudget(MAX_DURATION_SEC);
    try {
      return await runReaction(payload, ctx.run.id);
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

async function runReaction(payload: ReactionPayload, runId: string) {
  logger.info("reaction received", { ...payload });

  // Fast reject BEFORE any Redis call: only the two decision emojis matter.
  const approved = APPROVE_EMOJIS.has(payload.reaction);
  const rejected = REJECT_EMOJIS.has(payload.reaction);
  if (!approved && !rejected) {
    return { ok: true, ignored: "unrelated_reaction" };
  }
  const reaction: ReactionKind = approved ? "approve" : "reject";

  // Tier-gate the reactor FIRST (before any Redis touch). Tier 3 reactors
  // are ignored silently — no reply, no draft lookup.
  const reactorTier = tierFor(payload.reactorSlackId);
  if (reactorTier !== 1 && reactorTier !== 2) {
    logger.warn("reactor not in allowlist", { user: payload.reactorSlackId });
    return { ok: true, ignored: "reactor_not_allowlisted" };
  }

  // Event-level dedup: a redelivered copy of the same Slack event must
  // not produce a second reply (write safety already lives in the state
  // machine — this guards against duplicate MESSAGES). Non-fatal: if
  // Redis is down, proceed rather than go silent.
  if (payload.eventId) {
    try {
      const req = await beginRequest(`marco:evt:${payload.eventId}`);
      if (req === "duplicate") {
        logger.info("duplicate reaction event ignored", {
          eventId: payload.eventId,
        });
        return { ok: true, deduped: true };
      }
    } catch (err) {
      logger.warn("reaction dedup unavailable — proceeding", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Look up the draft by the reacted-to message ts. One 2s retry closes
  // the race where the preview is reacted to before storeDraft lands.
  let draft = (await getDraft(payload.messageTs)) as StoredDraft | null;
  if (!draft) {
    await new Promise((r) => setTimeout(r, 2000));
    draft = (await getDraft(payload.messageTs)) as StoredDraft | null;
  }

  if (!draft) {
    // The state key outlives the draft (48h vs 24h/2h): a reaction on an
    // expired-but-posted preview still gets the idempotent reply.
    const orphanState = await getDraftState(payload.messageTs);
    if (orphanState?.state === "posted") {
      await postMessage({
        channel: payload.channel,
        text: "Already posted to Monday.",
        thread_ts: payload.messageTs,
      });
      return { ok: true, ignored: "already_posted" };
    }
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

  // Lifecycle state — lazily initialized for drafts stored before the
  // state machine deploy.
  let state: DraftState | null = await getDraftState(draft.previewTs);
  if (!state) {
    state = await initDraftState(
      draft.previewTs,
      computeBodyHash(draft.monday.itemId, draft.updateBody),
    );
  }

  // Epoch ms of this reaction event — the re-confirm second-✅ must be a
  // strictly newer event than the reconfirmedAt stamp (F9).
  const eventTsMs = slackTsToMs(payload.eventTs);

  // Decide → CAS-apply → on a lost race, re-read and re-decide. Every
  // pass either terminates with a reply or observes a fresher state.
  for (let pass = 0; pass < MAX_DECISION_PASSES; pass++) {
    const decision = decideReaction(state, draft, reaction, Date.now(), eventTsMs);
    logger.info("reaction decision", {
      pass,
      state: state.state,
      reaction,
      action: decision.action,
    });

    switch (decision.action) {
      case "cancel": {
        const t = await transition(draft.previewTs, ["pending"], "cancelled");
        if (!t.ok) {
          state = await refreshState(t, draft);
          continue;
        }
        await finishCancelled(draft, `Cancelled — didn't post to *${draft.monday.itemName}*.`);
        return { ok: true, cancelled: true };
      }

      case "reconfirm": {
        const t = await transition(draft.previewTs, ["pending"], "pending", {
          reconfirmedAt: new Date().toISOString(),
          expectedAt: state.at,
        });
        if (!t.ok && t.current?.state !== "pending") {
          state = await refreshState(t, draft);
          continue;
        }
        // A lost race that is still pending means a concurrent first-✅
        // stamped reconfirmedAt — repeating the ask is safe; falling
        // through to execute here would collapse the re-confirm gate.
        const ageMs = Date.now() - new Date(draft.createdAt).getTime();
        await postMessage({
          channel: draft.previewChannel,
          text:
            `This draft is ${Math.round(ageMs / (60 * 60 * 1000))} hours old — ` +
            `the context may be stale. React ✅ again to confirm, or react ❌ to cancel.`,
          thread_ts: draft.previewTs,
        });
        return { ok: true, reconfirm_requested: true };
      }

      case "execute": {
        const t = await transition(draft.previewTs, ["pending"], "executing", {
          owner: runId,
        });
        if (!t.ok) {
          state = await refreshState(t, draft);
          continue;
        }
        return executeDraft(payload, draft);
      }

      case "reconcile": {
        const outcome = await reconcileDraft(payload, draft, state, reaction, runId);
        if (outcome.retryState) {
          state = outcome.retryState;
          continue;
        }
        return outcome.result;
      }

      case "reply": {
        await postMessage({
          channel: draft.previewChannel,
          text: replyText(decision.reply, reaction),
          thread_ts: draft.previewTs,
        });
        return { ok: true, ignored: decision.reply };
      }
    }
  }

  // Only reachable if the state kept changing under us every pass.
  await postMessage({
    channel: draft.previewChannel,
    text: "I couldn't process that reaction — try again, or check Monday directly.",
    thread_ts: draft.previewTs,
  });
  return { ok: false, error: "decision_races_exhausted" };
}

/**
 * After a lost CAS, produce the freshest state. A missing key (state
 * expired mid-flight) is re-initialized pending — the draft still exists,
 * so the user's reaction must still resolve.
 */
async function refreshState(
  t: TransitionResult & { ok: false },
  draft: StoredDraft,
): Promise<DraftState> {
  if (t.current) return t.current;
  return initDraftState(
    draft.previewTs,
    computeBodyHash(draft.monday.itemId, draft.updateBody),
  );
}

function replyText(reply: ReplyClass, reaction: ReactionKind): string {
  switch (reply) {
    case "already_posted":
      return "Already posted to Monday.";
    case "already_cancelled":
      return reaction === "approve"
        ? "This draft was cancelled."
        : "Already cancelled.";
    case "executing_cannot_cancel":
      return "This draft is being posted right now — I can't cancel it. Check the confirmation in a moment.";
    case "already_processing":
      return "This draft is already being processed.";
  }
}

/** Cancel epilogue: draft cleanup, reply, 📝 → ❌ (each best-effort). */
async function finishCancelled(draft: StoredDraft, text: string): Promise<void> {
  try {
    await deleteDraft(draft.previewTs);
  } catch (err) {
    logger.error("deleteDraft failed after cancel — state machine blocks re-execution", {
      err: String(err),
    });
  }
  await postMessage({
    channel: draft.previewChannel,
    text,
    thread_ts: draft.previewTs,
  });
  if (draft.originChannel && draft.eventTs) {
    await swapReaction(draft.originChannel, draft.eventTs, "memo", "x");
  }
}

/**
 * Reconcile an unverified outcome (unknown, or executing whose owner
 * died) against the item's own updates feed. Finding the draft's body is
 * proof the write landed; not finding it is the ONLY path that
 * re-authorizes execution (✅) or cancellation (❌) out of unknown — and
 * only once the stamp is RECONCILE_MIN_AGE_MS old (an aborted mutation
 * can commit server-side after the fact).
 */
async function reconcileDraft(
  payload: ReactionPayload,
  draft: StoredDraft,
  state: DraftState,
  reaction: ReactionKind,
  runId: string,
): Promise<{ result?: Record<string, unknown>; retryState?: DraftState }> {
  if (reaction === "reject") {
    // Spec: tell the user the last outcome is unverified before the
    // (possibly slow) Monday check.
    await postMessage({
      channel: draft.previewChannel,
      text: "The last attempt's outcome was never confirmed — checking the Monday card now.",
      thread_ts: draft.previewTs,
    });
  }

  const updates = await getItemUpdates(draft.monday.itemId, 50);
  const match = matchUpdateBody(updates, draft.updateBody, draft.createdAt);

  if (match) {
    // Same expectedAt CAS as the absent path: a lost race means another
    // run transitioned meanwhile (fresh executing, posted, …) — re-read
    // and re-decide instead of stamping posted over its state.
    const t = await transition(
      draft.previewTs,
      ["unknown", "executing"],
      "posted",
      { updateId: match.id, expectedAt: state.at },
    );
    if (!t.ok) {
      return { retryState: await refreshState(t, draft) };
    }
    await logWriteIncident({
      outcome: "reconciled_found",
      approvedBy: payload.reactorSlackId,
      requester: draft.requesterSlackId,
      tier: draft.requesterTier,
      board: draft.monday.boardName,
      item: draft.monday.itemName,
      updateId: match.id,
    });
    await postMessage({
      channel: draft.previewChannel,
      text: `Already posted to Monday (verified against the item's updates). <${mondayItemUrl(draft.monday.boardId, draft.monday.itemId)}|View>`,
      thread_ts: draft.previewTs,
    });
    try {
      await deleteDraft(draft.previewTs);
    } catch (err) {
      logger.error("deleteDraft failed — posted state blocks re-execution", {
        err: String(err),
      });
    }
    if (draft.originChannel && draft.eventTs) {
      await swapReaction(draft.originChannel, draft.eventTs, "memo", "white_check_mark");
    }
    return { result: { ok: true, reconciled: "found", updateId: match.id } };
  }

  // ABSENT — but Monday can commit an aborted mutation server-side after
  // the timeout, invisibly to a query this early. Until the unknown/
  // executing stamp is RECONCILE_MIN_AGE_MS old, an absent verdict
  // authorizes neither a retry nor a cancel: the state stays as-is.
  if (decideReconcileAbsent(state.at, Date.now()) === "settling") {
    await postMessage({
      channel: draft.previewChannel,
      text:
        reaction === "approve"
          ? "The last attempt is still settling — give it two minutes, then react ✅ again or check the Monday card."
          : "The last attempt is still settling — give it two minutes, then react ❌ again to cancel, or check the Monday card.",
      thread_ts: draft.previewTs,
    });
    return { result: { ok: true, reconciled: "settling" } };
  }

  if (reaction === "approve") {
    // Verified absent → this run may retry. The expectedAt CAS ensures
    // exactly one of any concurrent reconcilers wins the retry.
    const t = await transition(
      draft.previewTs,
      ["unknown", "executing"],
      "executing",
      { owner: runId, expectedAt: state.at },
    );
    if (!t.ok) {
      return { retryState: await refreshState(t, draft) };
    }
    await logWriteIncident({
      outcome: "reconciled_absent_retry",
      approvedBy: payload.reactorSlackId,
      requester: draft.requesterSlackId,
      tier: draft.requesterTier,
      board: draft.monday.boardName,
      item: draft.monday.itemName,
    });
    return { result: await executeDraft(payload, draft) };
  }

  // ❌ on unknown, verified absent → safe to cancel.
  const t = await transition(draft.previewTs, ["unknown"], "cancelled", {
    expectedAt: state.at,
  });
  if (!t.ok) {
    return { retryState: await refreshState(t, draft) };
  }
  await finishCancelled(
    draft,
    `Cancelled — verified the earlier attempt never reached Monday. Didn't post to *${draft.monday.itemName}*.`,
  );
  return { result: { ok: true, cancelled: true, reconciled: "absent" } };
}

/**
 * The Monday write. Caller has already won the →executing CAS; this run
 * owns the draft until it transitions out.
 */
async function executeDraft(payload: ReactionPayload, draft: StoredDraft) {
  let result: CreateUpdateResult;
  try {
    result = await createItemUpdate({
      itemId: draft.monday.itemId,
      body: draft.updateBody,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("monday create_update failed", { err: msg });

    if (classifyMondayFailure(msg) === "ambiguous") {
      // The request may have landed AFTER the timeout/reset. Park in
      // unknown: only reconciliation against the item's updates feed can
      // authorize a retry or a cancel from here.
      await tryTransition(draft.previewTs, ["executing"], "unknown", {});
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
        text: "I couldn't confirm whether Monday accepted that update — please check the Monday card before approving again.",
        thread_ts: draft.previewTs,
      });
      return { ok: false, outcome: "unknown" };
    }

    // Definitive failure: Monday answered with an error envelope — the
    // write provably did not apply, so return to pending for a retry ✅.
    await tryTransition(draft.previewTs, ["executing"], "pending", {
      incrAttempts: true,
    });
    await logWriteIncident({
      outcome: "failed",
      approvedBy: payload.reactorSlackId,
      requester: draft.requesterSlackId,
      tier: draft.requesterTier,
      board: draft.monday.boardName,
      item: draft.monday.itemName,
      error: msg.slice(0, 300),
    });
    await postMessage({
      channel: draft.previewChannel,
      text: `Failed to post the update: ${msg}`,
      thread_ts: draft.previewTs,
    });
    // Leave the draft in Redis so the requester can ✅ again.
    return { ok: false, error: msg };
  }

  // Success. Record posted IMMEDIATELY — before ANY Slack call — so a
  // crash below can never lead to a second execution. If even this Redis
  // write fails, reconciliation makes a later re-✅ safe: log loudly and
  // continue to the confirmation.
  const posted = await tryTransition(draft.previewTs, ["executing"], "posted", {
    updateId: result.updateId,
  });
  if (!posted?.ok) {
    logger.error("posted-state transition did not apply — reconciliation guards re-approval", {
      current: posted && !posted.ok ? posted.current?.state : "transition_threw",
    });
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

  // ─── Slack confirmation (independent of the write) ─────────
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

  // ─── Draft cleanup (independent) ───────────────────────────
  try {
    await deleteDraft(draft.previewTs);
  } catch (err) {
    // The posted state blocks re-execution of this draft.
    logger.error("deleteDraft failed — posted state protects re-execution", {
      err: String(err),
    });
  }

  // Resolve the 📝 ack on the original request message (best-effort).
  if (draft.originChannel && draft.eventTs) {
    await swapReaction(draft.originChannel, draft.eventTs, "memo", "white_check_mark");
  }

  return { ok: true, posted: true, updateId: result.updateId };
}

/** A state write must never mask the user-facing failure message. */
async function tryTransition(
  ...args: Parameters<typeof transition>
): Promise<TransitionResult | null> {
  try {
    return await transition(...args);
  } catch (err) {
    logger.error("draft-state transition threw", {
      previewTs: args[0],
      to: args[2],
      err: String(err),
    });
    return null;
  }
}
