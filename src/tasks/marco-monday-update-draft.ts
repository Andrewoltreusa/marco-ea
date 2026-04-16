/**
 * Trigger.dev task: comms/marco-monday-update-draft
 *
 * Called from the inbound task's dispatcher when the router classifies
 * a message as `monday-update` (a write-intent phrase).
 *
 * Job:
 *   1. Parse the user's raw message into {target, content, confidence} via Claude.
 *   2. Reject if confidence too low → clarify response.
 *   3. Enforce Tier-2 one-active-draft rule (if they have a pending draft, tell them).
 *   4. Fuzzy search Monday Deals / Leads / Contacts for the target.
 *   5. If 0 matches → clarify. If 2+ close matches → ask which.
 *   6. Compose the update body with the requester's enforced signature.
 *   7. Post a preview DM and capture its Slack `ts`.
 *   8. Store the draft in Redis keyed by that ts, TTL matching tier.
 *
 * Tier 1: 12h TTL, signature `— Andrew via Marco`.
 * Tier 2: 2h TTL, signature forced to own name.
 */

import { task, logger } from "@trigger.dev/sdk";
import { parseWriteIntent } from "../../lib/anthropic.js";
import { fuzzyFindItems, BOARDS } from "../../lib/monday.js";
import { postMessage } from "../../lib/slack.js";
import {
  storeDraft,
  getActiveDraftForUser,
  type MondayUpdateDraft,
} from "../../lib/redis.js";

export interface MondayUpdateDraftPayload {
  rawText: string;
  requesterSlackId: string;
  requesterName: string;
  requesterTier: 1 | 2;
  replyChannel: string;
  threadTs?: string;
}

const CONFIDENCE_THRESHOLD = 0.65;

/** Short, human-friendly Tier 2 name for signatures. */
function shortName(full: string): string {
  if (full === "Bella Babere") return "Bella";
  if (full === "Alex Tretiakov") return "Alex T.";
  if (full === "Aleksandr Polkhovskiy") return "Alex P.";
  if (full === "Andrew Shpiruk") return "Andrew";
  return full;
}

export const marcoMondayUpdateDraft = task({
  id: "comms/marco-monday-update-draft",
  maxDuration: 60,
  run: async (payload: MondayUpdateDraftPayload) => {
    logger.info("monday-update draft request", {
      user: payload.requesterSlackId,
      tier: payload.requesterTier,
      text: payload.rawText.slice(0, 120),
    });

    // ─── Tier 2 one-active-draft enforcement ─────────────────
    if (payload.requesterTier === 2) {
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
    }

    // ─── Parse the write intent with Claude ───────────────────
    const parsed = await parseWriteIntent(payload.rawText);
    logger.info("intent parsed", { ...parsed });

    if (parsed.confidence < CONFIDENCE_THRESHOLD || !parsed.target || !parsed.content) {
      await postMessage({
        channel: payload.replyChannel,
        text:
          "I'm not sure exactly what you want me to log. Try a format like: " +
          "*\"Log on Rivertop: spoke with them today, sending contract Friday\"* " +
          "or *\"I'm meeting John Duncan tomorrow at 11\"*.",
        thread_ts: payload.threadTs,
      });
      return { ok: true, reason: "low_confidence", confidence: parsed.confidence };
    }

    // ─── Fuzzy search Monday ─────────────────────────────────
    const candidates = await fuzzyFindItems(parsed.target, {
      limit: 5,
      boards: [BOARDS.DEALS, BOARDS.LEADS, BOARDS.CONTACTS],
    });
    logger.info("monday candidates", { count: candidates.length });

    if (candidates.length === 0) {
      await postMessage({
        channel: payload.replyChannel,
        text:
          `I couldn't find *${parsed.target}* in Monday Deals, Leads, or Contacts. ` +
          `Try the full company name, or tell me which board it's on.`,
        thread_ts: payload.threadTs,
      });
      return { ok: true, reason: "no_match", target: parsed.target };
    }

    // If top match is much better than second, auto-pick it.
    // Otherwise ask which.
    const top = candidates[0];
    const second = candidates[1];
    const confident =
      !second || top.score - second.score >= 0.2 || top.score >= 0.9;

    if (!confident) {
      const list = candidates
        .slice(0, 3)
        .map((c, i) => `${i + 1}. *${c.name}* (${c.boardName})`)
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
    const name = shortName(payload.requesterName);
    const signature = `— ${name} via Marco`;
    const updateBody = `${parsed.content}\n\n${signature}`;

    // ─── Post the preview and capture the message ts ──────────
    const previewText =
      `*Draft update for ${top.name}* (${top.boardName}):\n\n` +
      `> ${parsed.content}\n` +
      `> _${signature}_\n\n` +
      `React ✅ to post it, ❌ to cancel. Expires in ${payload.requesterTier === 1 ? "12 hours" : "2 hours"}.`;

    const posted = await postMessage({
      channel: payload.replyChannel,
      text: previewText,
      thread_ts: payload.threadTs,
    });

    // ─── Persist the draft ────────────────────────────────────
    const now = new Date();
    const ttlMs =
      payload.requesterTier === 1 ? 12 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
    const draft: MondayUpdateDraft = {
      previewTs: posted.ts,
      previewChannel: posted.channel,
      requesterSlackId: payload.requesterSlackId,
      requesterName: name,
      requesterTier: payload.requesterTier,
      monday: {
        boardId: top.boardId,
        boardName: top.boardName,
        itemId: top.id,
        itemName: top.name,
      },
      updateBody,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    await storeDraft(draft);

    return { ok: true, draftStored: true, previewTs: posted.ts, itemName: top.name };
  },
});
