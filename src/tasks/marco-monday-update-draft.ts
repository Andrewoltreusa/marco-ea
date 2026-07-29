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
 *   9. Store the draft in Redis keyed by that ts.
 *
 * Tier 1: 24h Redis TTL — execution without re-confirm allowed ≤12h from
 *         createdAt; 12–24h requires the reaction handler's re-confirm flow.
 * Tier 2: 2h TTL, one active draft at a time.
 * Signature is forced to the requester's own name for BOTH tiers.
 */

import { task, logger } from "@trigger.dev/sdk";
import { parseWriteIntent } from "../../lib/anthropic.js";
import { fuzzyFindItems, BOARDS } from "../../lib/monday.js";
import { postMessage, openDM, dmUser } from "../../lib/slack.js";
import {
  redis,
  storeDraft,
  getActiveDraftForUser,
  type MondayUpdateDraft,
} from "../../lib/redis.js";
import { tierFor, nameFor } from "../slack/allowlist.js";

export interface MondayUpdateDraftPayload {
  rawText: string;
  requesterSlackId: string;
  /** Channel the request arrived in (DM or channel mention). */
  replyChannel: string;
  threadTs?: string;
  /** ts of the original request message — used to resolve the 📝 ack. */
  eventTs?: string;
}

/**
 * Extra fields Marco stores on the draft JSON beyond lib/redis.ts's
 * MondayUpdateDraft. lib/redis.ts is shared and not edited in this wave;
 * storeDraft persists the object verbatim and getDraft returns it back,
 * so extra keys round-trip safely.
 * Keep in sync with the copy in marco-reaction-handler.ts.
 */
interface DraftExtras {
  /** Channel of the original request message (for the 📝 → ✅/❌ swap). */
  originChannel?: string;
  /** ts of the original request message. */
  eventTs?: string;
  /** Set by the reaction handler when Tier 1 re-confirms a >12h draft. */
  reconfirmedAt?: string;
}

const CONFIDENCE_THRESHOLD = 0.65;

/** Must match lib/redis.ts's USER_DRAFT_KEY so getActiveDraftForUser stays coherent. */
const userDraftKey = (slackId: string) => `marco:user-draft:${slackId}`;

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

/**
 * Release the Tier-2 one-draft slot IF it still holds our "reserving"
 * sentinel. Conditional so we never clobber a real draft pointer written
 * by storeDraft (ours or a concurrent run's). Best-effort — the 120s
 * reservation TTL is the backstop if this fails.
 */
async function releaseTier2Slot(slackId: string): Promise<void> {
  try {
    const key = userDraftKey(slackId);
    const current = await redis().get(key);
    if (current === "reserving") {
      await redis().del(key);
    }
  } catch (err) {
    logger.warn("could not release tier-2 draft slot", { err: String(err) });
  }
}

export const marcoMondayUpdateDraft = task({
  id: "comms/marco-monday-update-draft",
  maxDuration: 60,
  // Never retry: a retry would post a second preview DM (and a second
  // Redis draft) for the same request. The in-task catch already tells
  // the user when drafting fails.
  retry: { maxAttempts: 1 },
  run: async (payload: MondayUpdateDraftPayload) => {
    try {
      return await runDraft(payload);
    } catch (err) {
      // Catch-all so Marco never goes silent. If anything in the draft
      // pipeline throws (Claude, Monday API, Redis, Slack), post a
      // visible error message instead of letting the task fail silently.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("draft pipeline threw", { error: msg });

      // Free the Tier-2 slot if we died while holding the reservation
      // (no-op for Tier 1 / when the slot holds a real draft pointer).
      await releaseTier2Slot(payload.requesterSlackId);

      const errText =
        `I hit a snag drafting that update: ${msg.slice(0, 200)}. ` +
        `Try rephrasing with the exact item name, or just tell me the deal code directly (e.g. "log on C26079: ...").`;
      // Error goes to the requester's DM when reachable (the draft flow
      // lives there); fall back to the channel the request came from.
      try {
        await dmUser(payload.requesterSlackId, errText);
      } catch {
        try {
          await postMessage({
            channel: payload.replyChannel,
            text: errText,
            thread_ts: payload.threadTs,
          });
        } catch {
          // if even postMessage fails, there's nothing more we can do;
          // the logger.error above ensures the Trigger.dev run records it.
        }
      }
      return { ok: false, reason: "draft_pipeline_error", error: msg };
    }
  },
});

async function runDraft(payload: MondayUpdateDraftPayload) {
  // ─── Re-derive tier + name from the compiled allowlist ─────
  // The payload crosses the Trigger.dev API and can be forged from the
  // dashboard — requesterName/requesterTier were removed from the payload
  // contract; the Slack ID is the only trusted input.
  const tier = tierFor(payload.requesterSlackId);
  if (tier !== 1 && tier !== 2) {
    logger.warn("draft request from non-allowlisted user", {
      user: payload.requesterSlackId,
    });
    return { ok: true, ignored: "bad_tier" };
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
  // both pass a read-then-check race. storeDraft overwrites the sentinel
  // with the real preview ts on success; every failure path below releases it.
  if (tier === 2) {
    const reserved = await redis().set(
      userDraftKey(payload.requesterSlackId),
      "reserving",
      { nx: true, ex: 120 },
    );
    if (reserved !== "OK") {
      const existing = await getActiveDraftForUser(payload.requesterSlackId);
      if (existing) {
        await postMessage({
          channel: payload.replyChannel,
          text:
            `You already have a pending draft for *${existing.monday.itemName}* (${existing.monday.boardName}). ` +
            `React ✅ or ❌ on that preview first, then ask me for the next one.`,
          thread_ts: payload.threadTs,
        });
        return { ok: true, reason: "existing_draft", previewTs: existing.previewTs };
      }
      // Slot key exists but no live draft behind it → stale reservation
      // from a crashed run. Proceed; the 120s TTL clears it and storeDraft
      // will overwrite it on success.
      logger.info("stale tier-2 reservation — proceeding", {
        user: payload.requesterSlackId,
      });
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
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId);
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
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId);
    await postMessage({
      channel: payload.replyChannel,
      text:
        `I couldn't find *${parsed.target}* in Monday Deals, Leads, or Contacts. ` +
        `Try the full company name, or tell me which board it's on (e.g. "log on C26079: ...").`,
      thread_ts: payload.threadTs,
    });
    return { ok: true, reason: "no_match", target: parsed.target };
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
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId);
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
    return { ok: true, reason: "ambiguous_match", candidates: candidates.length };
  }

  // ─── Compose update body with enforced signature ──────────
  // The signature is forced for ALL tiers and derived server-side from the
  // Slack sender ID. Tier-1 custom attribution (allowed on paper by the
  // Phase-6a decision) is DEFERRED pending an explicit Andrew decision —
  // until then Andrew gets the same forced "— Andrew via Marco".
  // Strip any attribution line smuggled into the parsed content so a user
  // can't fake someone else's "via Marco" signature in the body.
  const strippedContent = parsed.content
    .replace(/(^|\n)\s*[—–-]\s*.{0,40}via Marco.*$/gim, "")
    .trim();
  if (!strippedContent || /via Marco/i.test(strippedContent)) {
    if (tier === 2) await releaseTier2Slot(payload.requesterSlackId);
    await postMessage({
      channel: payload.replyChannel,
      text: "I can't include attribution text in the update body — rephrase without it.",
      thread_ts: payload.threadTs,
    });
    return { ok: true, reason: "attribution_in_body" };
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

  if (tier === 1) {
    // lib/redis.ts's storeDraft sets a 12h TTL for Tier 1 (shared file —
    // not edited in this wave). Wave-1 semantics: the draft LIVES 24h in
    // Redis; execution without re-confirm is allowed only ≤12h from
    // createdAt, and a ✅ between 12h and 24h triggers the reaction
    // handler's re-confirm flow. Extend the TTL here so the 12–24h
    // re-confirm window is actually reachable.
    await redis().expire(`marco:draft:${posted.ts}`, 24 * 60 * 60);
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

  return { ok: true, draftStored: true, previewTs: posted.ts, itemName: top.name };
}
