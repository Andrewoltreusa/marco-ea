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
import { nameFor, type Tier } from "../slack/allowlist.js";
import { postMessage } from "../../lib/slack.js";
import { dealStatus } from "../skills/deal-status.js";
import { productionEta } from "../skills/production-eta.js";
import { leadCheck } from "../skills/lead-check.js";
import { agentFleetHealth } from "../skills/agent-fleet-health.js";
import { generalQuery } from "../skills/general-query.js";

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
  run: async (payload: NormalizedSlackEvent & { __probe?: boolean }) => {
    // Diagnostic probe — the Vercel route GET handler uses this to verify
    // end-to-end trigger plumbing without producing any Slack side-effects.
    if (payload.__probe === true) {
      logger.info("probe received", { ts: new Date().toISOString() });
      return { ok: true, probe: true, deploy: process.env.TRIGGER_DEPLOY_VERSION ?? "unknown" };
    }

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

async function runSkill(
  routed: RoutedRequest,
): Promise<{ text: string; blocks?: unknown[] }> {
  const q = routed.args.query ?? "";
  const tier = routed.tier as 1 | 2;

  switch (routed.skill) {
    case "deal-status":
      return { text: await dealStatus(q, tier) };
    case "production-eta":
      return { text: await productionEta(q) };
    case "lead-check":
      return { text: await leadCheck(q) };
    case "agent-fleet-health":
      return { text: await agentFleetHealth(tier) };
    case "cash-position":
    case "find-in-vault":
      // These don't have dedicated wiring — fall through to the general query
      // which will search Monday and compose a natural answer.
      return { text: await generalQuery(q || routed.args.query || "cash position", tier) };
    case "clarify":
      if (!q) {
        return {
          text:
            "What would you like to know? Try:\n" +
            "• *what's the status of [client]?*\n" +
            "• *when does [client] ship?*\n" +
            "• *has [name] gotten back to us?*\n" +
            "• *is anything broken?*\n" +
            "• Or tell me something to log: *I spoke with [name] about [topic]*",
        };
      }
      // Non-empty clarify = the classifier wasn't sure. Let general query handle it.
      return { text: await generalQuery(q, tier) };
    default:
      return { text: await generalQuery(q || "help", tier) };
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
