/**
 * Trigger.dev task: comms/marco-slack-inbound
 *
 * Webhook handler for the Marco Slack app. Receives events from Slack
 * (slash commands, DMs, mentions), tier-checks the sender, routes to a
 * skill, and posts the response back to Slack.
 *
 * Project: proj_rfghiguuzwfekcixcuux (shared with oltre-agents)
 *
 * Environment:
 *   MARCO_SLACK_BOT_TOKEN
 *   MARCO_SLACK_SIGNING_SECRET
 *   MONDAY_API_KEY          (shared with oltre-agents)
 *   FRESHBOOKS_*            (shared with oltre-agents)
 *   ANTHROPIC_API_KEY       (shared with oltre-agents)
 *
 * Slack wiring: the Marco Slack app's Request URL points at this task's
 * HTTP endpoint. Slack sends an event → this task returns 200 fast
 * → the actual skill work happens in a child task triggered asynchronously.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { routeInbound, type RoutedRequest } from "../slack/router.js";
import { postMessage, verifySlackSignature } from "../../lib/slack.js";

export interface SlackInboundPayload {
  rawBody: string;
  timestamp: string;
  signature: string;
  parsed: {
    type: "slash_command" | "event";
    slackUserId: string;
    channel: string;
    text: string;
    threadTs?: string;
    isDM: boolean;
  };
}

export const marcoSlackInbound = task({
  id: "comms/marco-slack-inbound",
  maxDuration: 30, // seconds; Slack expects 200 inside 3s, the heavy work forks
  run: async (payload: SlackInboundPayload) => {
    // 1. Verify signature. Reject tampered or replayed requests.
    const valid = await verifySlackSignature(
      payload.rawBody,
      payload.timestamp,
      payload.signature,
    );
    if (!valid) {
      logger.warn("Slack signature invalid — rejecting", {
        user: payload.parsed.slackUserId,
      });
      return { ok: false, reason: "signature_invalid" };
    }

    // 2. Route (tier-check first, then intent classification).
    const routed = routeInbound({
      slackUserId: payload.parsed.slackUserId,
      channel: payload.parsed.channel,
      text: payload.parsed.text,
      threadTs: payload.parsed.threadTs,
      isDM: payload.parsed.isDM,
    });

    logger.info("Slack event routed", {
      user: payload.parsed.slackUserId,
      tier: routed.tier,
      skill: routed.skill,
    });

    // 3. Tier 3 short-circuit.
    if (routed.skill === "refuse") {
      await logAccessDenial(payload.parsed.slackUserId, payload.parsed.text, routed);
      if (!routed.rateLimited) {
        await postMessage({
          channel: routed.replyChannel,
          text: routed.args.text ?? "Refused.",
          thread_ts: routed.threadTs,
        });
      }
      return { ok: true, tier: 3, posted: !routed.rateLimited };
    }

    // 4. Tier 1/2 — dispatch to the skill runner.
    //    For v1, we run the skill inline here. Phase-6 skill implementations
    //    live under src/skills/<skill-name>/run.ts.
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
 * Skill dispatcher. Each Phase-6 skill exports a `run(args)` function.
 * This is a minimal stub — the real implementations land in Phase 6b.
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
          `_(Marco v1 stub — skill \`${routed.skill}\` routed correctly for tier ${routed.tier}.` +
          ` Skill implementation lands in the next commit.)_`,
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

/**
 * Append a Tier-3 denial to Marco's access-denials log.
 * In production this writes to Upstash Redis + a daily flush to a file.
 */
async function logAccessDenial(
  slackUserId: string,
  text: string,
  routed: RoutedRequest,
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    slackUserId,
    channel: routed.replyChannel,
    text: text.slice(0, 200),
    rateLimited: routed.rateLimited ?? false,
  });
  logger.info("access-denial", { line });
  // TODO Phase-6b: append to memory/access-denials.md via filesystem or Redis.
}
