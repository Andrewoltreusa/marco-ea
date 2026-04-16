/**
 * Trigger.dev task: comms/marco-slack-inbound
 *
 * Invoked by the Vercel Node-runtime route at
 *   oltre-dashboard/app/api/marco/slack/route.ts
 *
 * That route has already:
 *   - verified the Slack signing secret
 *   - rejected replays > 5 minutes old
 *   - handled Slack's url_verification challenge inline
 *   - parsed the form-urlencoded (slash commands) or JSON (events) body
 *   - normalized the payload into the NormalizedSlackEvent shape below
 *
 * This task runs the actual skill work async, then posts the reply
 * back to Slack via lib/slack.ts. Slack already received its 200
 * from the Vercel route within ~50ms.
 *
 * Project: proj_rfghiguuzwfekcixcuux (shared with oltre-agents)
 * Env: MARCO_SLACK_BOT_TOKEN (and all shared vars from oltre-agents)
 */

import { task, logger, tasks } from "@trigger.dev/sdk";
import { routeInbound, type RoutedRequest } from "../slack/router.js";
import { nameFor } from "../slack/allowlist.js";
import { postMessage } from "../../lib/slack.js";

export interface NormalizedSlackEvent {
  source: "slash_command" | "app_mention" | "message_im";
  slackUserId: string;
  channel: string;
  text: string;
  threadTs?: string;
  isDM: boolean;
  teamId?: string;
}

export const marcoSlackInbound = task({
  id: "comms/marco-slack-inbound",
  maxDuration: 60,
  run: async (payload: NormalizedSlackEvent) => {
    logger.info("marco slack inbound", {
      source: payload.source,
      user: payload.slackUserId,
      isDM: payload.isDM,
    });

    const routed = routeInbound({
      slackUserId: payload.slackUserId,
      channel: payload.channel,
      text: payload.text,
      threadTs: payload.threadTs,
      isDM: payload.isDM,
    });

    logger.info("routed", { tier: routed.tier, skill: routed.skill });

    if (routed.skill === "refuse") {
      await logAccessDenial(payload, routed);
      if (!routed.rateLimited) {
        await postMessage({
          channel: routed.replyChannel,
          text: routed.args.text ?? "Refused.",
          thread_ts: routed.threadTs,
        });
      }
      return { ok: true, tier: 3, posted: !routed.rateLimited };
    }

    // ─── Phase 6a: write intent → draft task ─────────────────
    if (routed.skill === "monday-update") {
      if (routed.tier !== 1 && routed.tier !== 2) {
        return { ok: true, tier: routed.tier, skill: "monday-update", ignored: "bad_tier" };
      }
      const requesterName = nameFor(payload.slackUserId) ?? "Unknown";
      await tasks.trigger("comms/marco-monday-update-draft", {
        rawText: payload.text,
        requesterSlackId: payload.slackUserId,
        requesterName,
        requesterTier: routed.tier,
        replyChannel: routed.replyChannel,
        threadTs: routed.threadTs,
      });
      return { ok: true, tier: routed.tier, skill: "monday-update", delegated: true };
    }

    const response = await runSkill(routed);
    await postMessage({
      channel: routed.replyChannel,
      text: response.text,
      blocks: response.blocks,
      thread_ts: routed.threadTs,
    });

    return { ok: true, tier: routed.tier, skill: routed.skill };
  },
});

/**
 * Stub skill dispatcher. Phase-6b will replace each case with a real
 * implementation that reads Monday / FreshBooks / the vault.
 */
async function runSkill(
  routed: RoutedRequest,
): Promise<{ text: string; blocks?: unknown[] }> {
  switch (routed.skill) {
    case "deal-status":
    case "cash-position":
    case "production-eta":
    case "lead-check":
    case "agent-fleet-health":
    case "find-in-vault":
      return {
        text:
          `_(Marco v1 stub — \`${routed.skill}\` routed correctly for tier ${routed.tier}.` +
          ` Real data wiring lands in Phase 6b.)_`,
      };
    case "clarify":
      return {
        text:
          "I didn't catch that. Try: *what's the status of [client]?*, *when does [client] ship?*, " +
          "*what's AR at?*, *has [name] gotten back to us?*, *is anything broken?*, or " +
          "*what do we know about [topic]?*",
      };
    default:
      return { text: "_(no handler)_" };
  }
}

async function logAccessDenial(
  payload: NormalizedSlackEvent,
  routed: RoutedRequest,
): Promise<void> {
  logger.warn("access-denial", {
    ts: new Date().toISOString(),
    slackUserId: payload.slackUserId,
    channel: routed.replyChannel,
    text: payload.text.slice(0, 200),
    rateLimited: routed.rateLimited ?? false,
  });
  // Phase-6b: also append to memory/access-denials.md via Upstash Redis.
}
