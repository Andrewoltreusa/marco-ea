/**
 * Trigger.dev task: comms/marco-monday-update-draft
 *
 * Called from the inbound task's dispatcher when the router classifies
 * a message as `monday-update` (a write-intent phrase).
 *
 * Job:
 *   1. Re-derive the requester's tier + name from the compiled allowlist
 *      (payloads are forgeable from the Trigger.dev dashboard — never
 *      trust caller-supplied tier/name).
 *   2. Tier 2: atomically reserve the one-draft-per-user slot.
 *   3. Parse the user's raw message into {target, content, confidence} via Claude.
 *   4. Reject if confidence too low → clarify response.
 *   5. Fuzzy search Monday Deals / Leads / Contacts for the target.
 *   6. If 0 matches → clarify. If the top two candidates are close → ask which.
 *   7. Compose the update body with the requester's enforced signature
 *      (forced for ALL tiers — see comment at the signature step).
 *   8. Post a preview in the requester's DM and capture its Slack `ts`.
 *   9. Store the draft in Redis keyed by that ts, and initialize its
 *      lifecycle state machine (marco:draft-state:<ts>).
 *
 * Tier 1: 24h Redis TTL — execution without re-confirm allowed ≤12h from
 *         createdAt; 12–24h requires the reaction handler's re-confirm flow.
 * Tier 2: 2h TTL, one active draft at a time.
 * Signature is forced to the requester's own name for BOTH tiers.
 *
 * Delivery-terminal lifecycle: the parent leaves the request lifecycle
 * OPEN and this task closes it (markResponded + outbox done marker) only
 * after a terminal user-visible reply. If this run dies first, the write
 * watchdog notices the missing done marker and tells the requester.
 */

import { task, logger } from "@trigger.dev/sdk";
import { parseWriteIntent } from "../../lib/anthropic.js";
import { fuzzyFindItems, BOARDS } from "../../lib/monday.js";
import { postMessage, openDM, dmUser } from "../../lib/slack.js";
import {
  redis,
  storeDraft,
  getDraft,
  markResponded,
  compareAndDel,
  userDraftPointerTs,
  USER_DRAFT_KEY,
  type MondayUpdateDraft,
} from "../../lib/redis.js";
import {
  initDraftState,
  computeBodyHash,
  sanitizeSlackMarkup,
} from "../../lib/draft-state.js";
import { auditRequest } from "../../lib/audit.js";
import {
  outboxDoneKey,
  outboxStartedKey,
  OUTBOX_MARKER_TTL_SEC,
} from "../../lib/outbox.js";
import { beginTaskBudget } from "../../lib/deadline.js";
import { tierFor, nameFor } from "../slack/allowlist.js";

export interface MondayUpdateDraftPayload {
  rawText: string;
  requesterSlackId: string;
  /** Channel the request arrived in (DM or channel mention). */
  replyChannel: string;
  threadTs?: string;
  /** ts of the original request message — used to resolve the 📝 ack. */
  eventTs?: string;
  /**
   * Request lifecycle key (marco:evt:*) — the parent leaves it open;
   * this task marks it responded after its terminal reply. Null when the
   * route deploy predates eventTs/eventId.
   */
  lifecycleKey?: string | null;
}

/**
 * Extra fields Marco stores on the draft JSON beyond lib/redis.ts's
 * MondayUpdateDraft. storeDraft persists the object verbatim and getDraft
 * returns it back, so extra keys round-trip safely.
 * Keep in sync with the copy in marco-reaction-handler.ts. The draft is
 * immutable after storeDraft — mutable lifecycle data (reconfirmedAt,
 * attempts, …) lives in marco:draft-state:<ts>.
 */
interface DraftExtras {
  /** Channel of the original request message (for the 📝 → ✅/❌ swap). */
  originChannel?: string;
  /** ts of the original request message. */
  eventTs?: string;
}

const CONFIDENCE_THRESHOLD = 0.65;

// The Tier-2 slot key is lib/redis.ts's USER_DRAFT_KEY — imported, not
// duplicated, so the reservation and the stored pointer can never drift.
const userDraftKey = USER_DRAFT_KEY;

const mondayItemUrl = (boardId: string, itemId: string) =>
  `https://oregonfivestar-company.monday.com/boards/${boardId}/pulses/${itemId}`;

/** Short, human-friendly name for signatures. */
function shortName(full: string): string {
  if (full === "Bella Babere") return "Bella";
  if (full === "Alex Tretiakov") return "Alex T.";
  if (full === "Aleksandr Polkhovskiy") return "Alex P.";
  if (full === "Andrew Shpiruk") return "Andrew";
  return full;
}

/** The reservation sentinel this run writes into the Tier-2 slot. */
const reservingToken = (runId: string) => `reserving:${runId}`;

/**
 * Release the Tier-2 one-draft slot IF it still holds THIS run's
 * reserving token — atomic compare-and-del, so a losing racer can never
 * release the winner's live reservation, and a real draft pointer
 * written by storeDraft is never clobbered. Best-effort — the 120s
 * reservation TTL is the backstop if this fails.
 */
async function releaseTier2Slot(slackId: string, runId: string): Promise<void> {
  try {
    await compareAndDel(userDraftKey(slackId), [reservingToken(runId)]);
  } catch (err) {
    logger.warn("could not release tier-2 draft slot", { err: String(err) });
  }
}

const MAX_DURATION_SEC = 60;

/**
 * Terminal bookkeeping — called ONLY after a terminal user-visible reply
 * (or the deliberate bad-tier silence): closes the request lifecycle so
 * Slack redeliveries stay deduped, and sets the outbox done marker so
 * the watchdog knows this delegation finished. Keyed by lifecycleKey,
 * falling back to the run id for legacy payloads without one (the
 * watchdog applies the same fallback).
 */
async function finalizeDelivery(
  lifecycleKey: string | null | undefined,
  runId: string,
): Promise<void> {
  if (lifecycleKey) await markResponded(lifecycleKey);
  try {
    await redis().set(outboxDoneKey(lifecycleKey ?? runId), 1, {
      ex: OUTBOX_MARKER_TTL_SEC,
    });
  } catch (err) {
    // markResponded above still dedups; worst case the watchdog
    // false-alarms once for a request that was actually answered.
    logger.warn("outbox done marker failed", { err: String(err) });
  }
}

export const marcoMondayUpdateDraft = task({
  id: "comms/marco-monday-update-draft",
  maxDuration: MAX_DURATION_SEC,
  // Never retry: a retry would post a second preview DM (and a second
  // Redis draft) for the same request. The in-task catch already tells
  // the user when drafting fails.
  retry: { maxAttempts: 1 },
  run: async (payload: MondayUpdateDraftPayload, { ctx }) => {
    beginTaskBudget(MAX_DURATION_SEC);
    // Started marker FIRST: tells the watchdog "the child got scheduled"
    // apart from "still queue-delayed" — a run that dies after this point
    // is declared lost at 5 minutes instead of 30.
    try {
      await redis().set(
        outboxStartedKey(payload.lifecycleKey ?? ctx.run.id),
        1,
        { ex: OUTBOX_MARKER_TTL_SEC },
      );
    } catch (err) {
      // Watchdog falls back to the 30-min queue-delay threshold.
      logger.warn("outbox started marker failed", { err: String(err) });
    }
    const startedAt = Date.now();
    // Terminal audit for the write path lives HERE, not in the parent —
    // ok means the preview/clarify/error reply was actually delivered.
    const audit = (ok: boolean) =>
      auditRequest({
        ts: new Date().toISOString(),
        eventId: payload.lifecycleKey ?? null,
        user: payload.requesterSlackId,
        tier: tierFor(payload.requesterSlackId),
        skill: "monday-update",
        ok,
        ms: Date.now() - startedAt,
      });

    try {
      const result = await runDraft(payload, ctx.run.id);
      // Every non-throw return of runDraft is terminal: either a reply
      // was delivered or (bad_tier) silence was deliberate — both must
      // close the lifecycle, or the watchdog would tell a non-allowlisted
      // user to resend.
      await finalizeDelivery(payload.lifecycleKey, ctx.run.id);
      await audit(result.delivered);
      return result;
    } catch (err) {
      // Catch-all so Marco never goes silent. If anything in the draft
      // pipeline throws (Claude, Monday API, Redis, Slack), post a
      // visible error message instead of letting the task fail silently.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("draft pipeline threw", { error: msg });

      // Free the Tier-2 slot if we died while holding the reservation
      // (no-op for Tier 1 / when the slot holds a real draft pointer or
      // another run's token).
      await releaseTier2Slot(payload.requesterSlackId, ctx.run.id);

      const errText =
        `I hit a snag drafting that update: ${msg.slice(0, 200)}. ` +
        `Try rephrasing with the exact item name, or just tell me the deal code directly (e.g. "log on C26079: ...").`;
      // Error goes to the requester's DM when reachable (the draft flow
      // lives there); fall back to the channel the request came from.
      let delivered = false;
      try {
        await dmUser(payload.requesterSlackId, errText);
        delivered = true;
      } catch {
        try {
          await postMessage({
            channel: payload.replyChannel,
            text: errText,
            thread_ts: payload.threadTs,
          });
          delivered = true;
        } catch {
          // if even postMessage fails, there's nothing more we can do;
          // the logger.error above ensures the Trigger.dev run records it.
        }
      }
      // Only a DELIVERED error reply closes the lifecycle — if the user
      // saw nothing, leave it open so the watchdog tells them to resend.
      if (delivered) {
        await finalizeDelivery(payload.lifecycleKey, ctx.run.id);
      }
      await audit(false);
      return { ok: false, reason: "draft_pipeline_error", error: msg, delivered };
    }
  },
});

async function runDraft(payload: MondayUpdateDraftPayload, runId: string) {
  // ─── Re-derive tier + name from the compiled allowlist ─────
  // The payload crosses the Trigger.dev API and can be forged from the
  // dashboard — requesterName/requesterTier were removed from the payload
  // contract; the Slack ID is the only trusted input.
  const tier = tierFor(payload.requesterSlackId);
  if (tier !== 1 && tier !== 2) {
    logger.warn("draft request from non-allowlisted user", {
      user: payload.requesterSlackId,
    });
    // Deliberate silence for non-allowlisted requesters — still terminal.
    return { ok: true, ignored: "bad_tier", delivered: false };
  }
  const fullName = nameFor(payload.requesterSlackId) ?? payload.requesterSlackId;

  logger.info("monday-update draft request", {
    user: payload.requesterSlackId,
    tier,
    text: payload.rawText.slice(0, 120),
  });

  // ─── Tier 2 one-active-draft enforcement (atomic) ──────────
  // NX-reserve the same key lib/redis.ts uses for the user-draft pointer,
  // BEFORE the (slow) Claude parse — two rapid-fire requests can no longer
  // both pass a read-then-check race. The token carries this run's id so
  // a live reservation (another run mid-draft) BLOCKS instead of being
  // treated as stale, and release can never delete another run's token.
  // storeDraft overwrites the token with the real pointer on success.
  if (tier === 2) {
    const key = userDraftKey(payload.requesterSlackId);
    const token = reservingToken(runId);
    const busyReply = async () => {
      await postMessage({
        channel: payload.replyChannel,
        text: "I'm already drafting your previous request — give me a minute.",
        thread_ts: payload.threadTs,
      });
      return { ok: true, reason: "draft_in_flight", delivered: true } as const;
    };

    let reserved = await redis().set(key, token, { nx: true, ex: 120 });
    if (reserved !== "OK") {
      const slot = await redis().get(key);
      if (typeof slot === "string" && slot.startsWith("reserving")) {
        // Another run of this user's is drafting right now. Its 120s TTL
        // (or its own release) frees the slot; never steal a live token.
        return busyReply();
      }
      if (slot === null) {
        // Expired between SET NX and GET — one retry.
        reserved = await redis().set(key, token, { nx: true, ex: 120 });
        if (reserved !== "OK") return busyReply();
      } else {
        // Real pointer: is there still a draft behind it?
        const previewTs = userDraftPointerTs(slot);
        const existing = previewTs ? await getDraft(previewTs) : null;
        if (existing) {
          await postMessage({
            channel: payload.replyChannel,
            text:
              `You already have a pending draft for *${existing.monday.itemName}* (${existing.monday.boardName}). ` +
              `React ✅ or ❌ on that preview first, then ask me for the next one.`,
            thread_ts: payload.threadTs,
          });
          return {
            ok: true,
            reason: "existing_draft",
            previewTs: existing.previewTs,
            delivered: true,
          };
        }
        // Dead pointer (draft expired/deleted): clear it only if it still
        // holds the exact value we read, then take the slot.
        const rawForms: string[] = [
          typeof slot === "object" ? JSON.stringify(slot) : String(slot),
        ];
        if (previewTs) {
          rawForms.push(JSON.stringify({ ts: previewTs }), previewTs);
        }
        try {
          await compareAndDel(key, rawForms);
        } catch (err) {
          logger.warn("dead-pointer clear failed", { err: String(err) });
        }
        reserved = await redis().set(key, token, { nx: true, ex: 120 });
        if (reserved !== "OK") return busyReply();
      }
    }
  }

  // ─── Parse the write intent with Claude ───────────────────
  const parsed = await parseWriteIntent(payload.rawText);
  logger.info("intent parsed", {
    target: parsed.target,
    content: parsed.content,
    confidence: parsed.confidence,
    rawClaudeResponse: parsed._raw ?? "(clean)",
  });

  if (parsed.confidence < CONFIDENCE_THRESHOLD || !parsed.target || !parsed.content) {
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId, runId);
    await postMessage({
      channel: payload.replyChannel,
      text:
        "I'm not sure exactly what you want me to log. Try a format like: " +
        "*\"Log on Rivertop: spoke with them today, sending contract Friday\"* " +
        "or *\"I'm meeting John Duncan tomorrow at 11\"*.",
      thread_ts: payload.threadTs,
    });
    return {
      ok: true,
      reason: "low_confidence",
      confidence: parsed.confidence,
      rawClaudeResponse: parsed._raw ?? "(clean)",
      delivered: true,
    };
  }

  // ─── Fuzzy search Monday ─────────────────────────────────
  const rawCandidates = await fuzzyFindItems(parsed.target, {
    limit: 5,
    boards: [BOARDS.DEALS, BOARDS.LEADS, BOARDS.CONTACTS],
  });
  // Drop low-confidence partials — if no candidate scores >= 0.6
  // we'd rather say "no match" than offer unrelated partial hits
  // (e.g. query "Rebecca Brooke" → returning Brooke Bundy / Rebecca
  // Fraser as "matches" is noise, not signal).
  const candidates = rawCandidates.filter((c) => c.score >= 0.6);
  logger.info("monday candidates", {
    rawCount: rawCandidates.length,
    filteredCount: candidates.length,
    topScore: rawCandidates[0]?.score ?? 0,
  });

  if (candidates.length === 0) {
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId, runId);
    await postMessage({
      channel: payload.replyChannel,
      text:
        `I couldn't find *${parsed.target}* in Monday Deals, Leads, or Contacts. ` +
        `Try the full company name, or tell me which board it's on (e.g. "log on C26079: ...").`,
      thread_ts: payload.threadTs,
    });
    return { ok: true, reason: "no_match", target: parsed.target, delivered: true };
  }

  // ─── Tie-break (hardened) ────────────────────────────────
  // NEVER auto-pick when a second candidate is within 0.1 of the top score,
  // regardless of absolute score — the old `top.score >= 0.9` shortcut
  // auto-picked the first of two identical 0.9 substring hits arbitrarily
  // (e.g. the same client on both Deals and Contacts).
  const top = candidates[0];
  const second = candidates[1];
  const gap = second ? top.score - second.score : Number.POSITIVE_INFINITY;
  const confident = gap >= 0.1 && (gap >= 0.2 || top.score >= 0.9);

  if (!confident) {
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId, runId);
    // Each candidate must be distinguishable: name, board, and a direct
    // Monday link so the requester can open the exact card.
    const list = candidates
      .slice(0, 3)
      .map(
        (c, i) =>
          `${i + 1}. *${c.name}* (${c.boardName}) — <${mondayItemUrl(c.boardId, c.id)}|open in Monday>`,
      )
      .join("\n");
    await postMessage({
      channel: payload.replyChannel,
      text:
        `I found more than one match for *${parsed.target}*:\n${list}\n\n` +
        `Tell me which by number, or use the full name.`,
      thread_ts: payload.threadTs,
    });
    return {
      ok: true,
      reason: "ambiguous_match",
      candidates: candidates.length,
      delivered: true,
    };
  }

  // ─── Compose update body with enforced signature ──────────
  // The signature is forced for ALL tiers — Andrew included, by his own
  // decision (2026-07-31, decisions/log.md): "Should still have my
  // signature." It is what makes a Marco-written update identifiable in a
  // Monday feed several systems write to. Derived server-side from the
  // Slack sender ID; no tier can override it.
  // Strip any attribution line smuggled into the parsed content so a user
  // can't fake someone else's "via Marco" signature in the body.
  // sanitizeSlackMarkup first: Slack auto-wraps every URL in <...> and
  // Monday's HTML sanitizer strips tag-like tokens from stored updates —
  // the stored body must be sanitizer-stable so preview text == what
  // Monday stores == what reconciliation compares (double-post guard).
  const strippedContent = sanitizeSlackMarkup(parsed.content)
    .replace(/(^|\n)\s*[—–-]\s*.{0,40}via Marco.*$/gim, "")
    .trim();
  if (!strippedContent || /via Marco/i.test(strippedContent)) {
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId, runId);
    await postMessage({
      channel: payload.replyChannel,
      text: "I can't include attribution text in the update body — rephrase without it.",
      thread_ts: payload.threadTs,
    });
    return { ok: true, reason: "attribution_in_body", delivered: true };
  }

  const name = shortName(fullName);
  const signature = `— ${name} via Marco`;
  const updateBody = `${strippedContent}\n\n${signature}`;

  // ─── Post the preview in the requester's DM ───────────────
  // The preview ALWAYS goes to the requester's DM — approvals must not be
  // reactable by bystanders in a shared channel.
  const dmChannel = await openDM(payload.requesterSlackId);

  const expiryLine =
    tier === 1
      ? "Expires in 12 hours (a ✅ after that asks you to re-confirm; hard cutoff 24 hours)."
      : "Expires in 2 hours.";
  const itemUrl = mondayItemUrl(top.boardId, top.id);
  const previewText =
    `*Draft update for ${top.name}* (${top.boardName}):\n` +
    `<${itemUrl}|Open the card on Monday>\n\n` +
    `> ${strippedContent}\n` +
    `> _${signature}_\n\n` +
    `React ✅ to post it, ❌ to cancel. ${expiryLine}`;

  const posted = await postMessage({
    channel: dmChannel,
    text: previewText,
    // Only thread when the request itself came from this DM — a channel
    // thread_ts is meaningless in the DM conversation.
    thread_ts: payload.replyChannel === dmChannel ? payload.threadTs : undefined,
  });

  // ─── Persist the draft ────────────────────────────────────
  // storeDraft runs IMMEDIATELY after postMessage — a reaction can arrive
  // the instant the preview renders; the reaction handler retries getDraft
  // once (2s) to cover the remaining sliver. Do not reorder.
  const now = new Date();
  // expiresAt is informational — the Redis TTL is authoritative.
  const ttlMs = tier === 1 ? 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  const draft: MondayUpdateDraft & DraftExtras = {
    previewTs: posted.ts,
    previewChannel: posted.channel,
    requesterSlackId: payload.requesterSlackId,
    requesterName: name,
    requesterTier: tier,
    monday: {
      boardId: top.boardId,
      boardName: top.boardName,
      itemId: top.id,
      itemName: top.name,
    },
    updateBody,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    // DraftExtras — lets the reaction handler resolve the 📝 ack on the
    // original request message to ✅/❌ once the draft is decided.
    originChannel: payload.replyChannel,
    eventTs: payload.eventTs,
  };
  await storeDraft(draft);

  // Lifecycle state machine: pending, keyed by the preview ts. The
  // reaction handler lazily initializes this if it's missing, so a
  // failure here must not kill a draft that already stored fine.
  try {
    await initDraftState(posted.ts, computeBodyHash(top.id, updateBody));
  } catch (err) {
    logger.warn("initDraftState failed — reaction handler will lazy-init", {
      err: String(err),
    });
  }

  // If the request came from a channel/mention rather than this DM, leave
  // a pointer there so the requester knows where the preview went.
  if (payload.replyChannel !== dmChannel) {
    try {
      await postMessage({
        channel: payload.replyChannel,
        text: "I sent you a draft preview in DM — approve it there.",
        thread_ts: payload.threadTs,
      });
    } catch (err) {
      // Best-effort: the preview (the real deliverable) already landed.
      logger.warn("could not post DM pointer to origin channel", {
        err: String(err),
      });
    }
  }

  return {
    ok: true,
    draftStored: true,
    previewTs: posted.ts,
    itemName: top.name,
    delivered: true,
  };
}
