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
 * Project: proj_nvpgdhytpkikscybodkk (Marco's own — split from the shared
 * oltre-agents project on 2026-04-24)
 * Env: MARCO_SLACK_BOT_TOKEN + Marco-specific vars set in the Trigger.dev
 * Marco project (Production env)
 */

import { task, logger, tasks } from "@trigger.dev/sdk";
import { routeInbound, type RoutedRequest } from "../slack/router.js";
import { postMessage, dmUser, addReaction, swapReaction } from "../../lib/slack.js";
import { beginRequest, markResponded, redis } from "../../lib/redis.js";
import { isFinancialQuestion } from "../skills/general-query.js";
import { dealStatus } from "../skills/deal-status.js";
import { productionEta } from "../skills/production-eta.js";
import { leadCheck } from "../skills/lead-check.js";
import { agentFleetHealth } from "../skills/agent-fleet-health.js";
import { generalQuery } from "../skills/general-query.js";
import { kbQuery } from "../skills/kb-query.js";

export interface NormalizedSlackEvent {
  source: "slash_command" | "app_mention" | "message_im";
  slackUserId: string;
  channel: string;
  text: string;
  threadTs?: string;
  isDM: boolean;
  teamId?: string;
  /** Slack ts of the triggering message — enables the 👀 ack + dedup. Optional: older route deploys don't send it. */
  eventTs?: string;
  /** Slack event_id from the events envelope — preferred dedup key. */
  eventId?: string;
}

export const marcoSlackInbound = task({
  id: "comms/marco-slack-inbound",
  // 120s: heavy financial/KB queries could breach the old 60s cap and
  // trigger platform retries. maxAttempts 1 because a retry re-runs the
  // whole pipeline and can double-post — the in-code never-silent catch
  // already turns failures into an error reply.
  maxDuration: 120,
  retry: { maxAttempts: 1 },
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

    // Tier classification FIRST — Tier-3 traffic must never touch Redis
    // state or receive acks/DMs beyond the single refusal.
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
        try {
          await postMessage({
            channel: routed.replyChannel,
            text: routed.args.text ?? "Refused.",
            thread_ts: routed.threadTs,
          });
        } catch (err) {
          logger.warn("tier-3 refusal post failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { ok: true, tier: 3, posted: !routed.rateLimited };
    }

    // Everything below is an authorized (Tier 1/2) request. The outer
    // catch is the never-silent guarantee of last resort: ANY unexpected
    // throw becomes a DM to the asker, not a dead run in a dashboard.
    const lifecycleKey = payload.eventId
      ? `marco:evt:${payload.eventId}`
      : payload.eventTs
        ? `marco:evt:${payload.channel}:${payload.eventTs}`
        : null;
    const canReact = payload.source !== "slash_command" && !!payload.eventTs;

    try {
      // ─── Request lifecycle (dedup that can't poison) ────────
      // Non-fatal by design: if Redis is down we'd rather risk a rare
      // double answer than guarantee silence.
      if (lifecycleKey) {
        try {
          const state = await beginRequest(lifecycleKey);
          if (state === "duplicate") {
            logger.info("duplicate delivery ignored", { lifecycleKey });
            return { ok: true, deduped: true };
          }
          if (state === "takeover") {
            logger.warn("taking over stale claim — previous worker died", {
              lifecycleKey,
            });
          }
        } catch (err) {
          logger.warn("lifecycle unavailable — proceeding without dedup", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ─── Instant ack — 👀 lands within ~2-3s of the message ──
      if (canReact) {
        try {
          await addReaction(payload.channel, payload.eventTs!, "eyes");
        } catch (err) {
          logger.warn("ack reaction failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ─── Phase 6a: write intent → draft task ─────────────────
      if (routed.skill === "monday-update") {
        // Child re-derives tier/name from the allowlist — payloads are
        // forgeable from the Trigger dashboard, so we only send IDs.
        try {
          const triggered = await tasks.trigger("comms/marco-monday-update-draft", {
            rawText: payload.text,
            requesterSlackId: payload.slackUserId,
            replyChannel: routed.replyChannel,
            threadTs: routed.threadTs,
            eventTs: payload.eventTs,
          });
          logger.info("monday-update delegated", {
            user: payload.slackUserId,
            runId: triggered.id,
          });
          // 📝 = "drafting" — the child resolves this emoji when the draft
          // is approved (✅) or rejected (❌).
          if (canReact) {
            await swapReaction(payload.channel, payload.eventTs!, "eyes", "memo");
          }
          if (lifecycleKey) await markResponded(lifecycleKey);
          return {
            ok: true,
            tier: routed.tier,
            skill: "monday-update",
            delegated: true,
            childRunId: triggered.id,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("failed to enqueue monday-update-draft", { error: msg });
          await deliverToUser(
            payload,
            routed,
            `I couldn't kick off the draft for that update — ${msg.slice(0, 200)}. ` +
              `Try again in a moment, or log it manually on the Monday card.`,
          );
          if (canReact) {
            await swapReaction(payload.channel, payload.eventTs!, "eyes", "warning");
          }
          if (lifecycleKey) await markResponded(lifecycleKey);
          return { ok: false, tier: routed.tier, skill: "monday-update", error: msg };
        }
      }

      // ─── Read path ────────────────────────────────────────────
      let response: { text: string; blocks?: unknown[] };
      let hadError = false;
      try {
        response = await runSkill(routed, payload);
      } catch (err) {
        hadError = true;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("skill failed", { skill: routed.skill, error: msg });
        response = {
          text:
            `I hit a snag answering that — ${msg.slice(0, 200)}. ` +
            `Try rephrasing, or ask me something specific like *status of [client name]*.`,
        };
      }
      if (!response.text || response.text.trim().length === 0) {
        response.text =
          "I wasn't sure how to answer that. Try rephrasing, or ask for a specific deal, lead, or AR breakdown.";
      }

      // ─── Delivery (tier-aware destination) ────────────────────
      // Financial answers asked in a shared channel go to the asker's DM;
      // the channel gets a pointer. Everything else replies in place, with
      // a DM fallback when the channel post fails (e.g. not_in_channel).
      const sensitiveInChannel =
        !payload.isDM && isFinancialQuestion(payload.text);
      if (sensitiveInChannel) {
        await dmUser(payload.slackUserId, response.text);
        try {
          await postMessage({
            channel: routed.replyChannel,
            text: "Sent you the details in a DM.",
            thread_ts: routed.threadTs,
          });
        } catch {
          // DM already delivered — the pointer is best-effort.
        }
      } else {
        await deliverToUser(payload, routed, response.text, response.blocks);
      }

      if (canReact) {
        await swapReaction(
          payload.channel,
          payload.eventTs!,
          "eyes",
          hadError ? "warning" : "white_check_mark",
        );
      }
      if (lifecycleKey) await markResponded(lifecycleKey);
      return { ok: true, tier: routed.tier, skill: routed.skill };
    } catch (err) {
      // ─── Never-silent of last resort ──────────────────────────
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("inbound handler failed", { error: msg });
      try {
        await dmUser(
          payload.slackUserId,
          "Something went wrong handling your message — please try again in a minute.",
        );
      } catch {
        // Slack itself is down — nothing more we can do.
      }
      if (canReact) {
        try {
          await swapReaction(payload.channel, payload.eventTs!, "eyes", "warning");
        } catch {
          /* best-effort */
        }
      }
      return { ok: false, tier: routed.tier, error: msg };
    }
  },
});

/**
 * Post to the originating channel; on failure (classic: not_in_channel on
 * a mention in a channel Marco isn't a member of) deliver to the asker's
 * DM instead. Throws only if BOTH deliveries fail — the outer never-silent
 * catch owns that case.
 */
async function deliverToUser(
  payload: NormalizedSlackEvent,
  routed: RoutedRequest,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  try {
    await postMessage({
      channel: routed.replyChannel,
      text,
      blocks,
      thread_ts: routed.threadTs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("channel reply failed — falling back to DM", {
      channel: routed.replyChannel,
      error: msg,
    });
    await dmUser(
      payload.slackUserId,
      `I couldn't reply in <#${routed.replyChannel}> (${msg.includes("not_in_channel") ? "I'm not a member — /invite me there" : msg.slice(0, 80)}). Here's your answer:\n\n${text}`,
    );
  }
}

async function runSkill(
  routed: RoutedRequest,
  payload: NormalizedSlackEvent,
): Promise<{ text: string; blocks?: unknown[] }> {
  const q = routed.args.query ?? "";
  const tier = routed.tier as 1 | 2;
  // Conversation memory key: per-channel AND per-user, DMs only. Shared
  // channels get NO memory — the old channel-only key replayed one user's
  // answers (incl. Tier-1 financial detail) into another user's prompt.
  const ch = payload.isDM
    ? `${routed.replyChannel}:${payload.slackUserId}`
    : undefined;

  switch (routed.skill) {
    case "deal-status":
      return { text: await dealStatus(q, tier) };
    case "production-eta":
      return { text: await productionEta(q) };
    case "lead-check":
      return { text: await leadCheck(q) };
    case "agent-fleet-health":
      return { text: await agentFleetHealth(tier) };
    case "kb-query": {
      // Feature-flagged. If ENABLE_KB isn't "true", OR the KB call throws,
      // fall through to general-query so Marco stays answerable while we
      // iterate on the KB plumbing.
      if (process.env.ENABLE_KB !== "true") {
        console.info(
          "[marco inbound] kb-query routed but ENABLE_KB!=true — falling through to general-query",
        );
        return { text: await generalQuery(q || "help", tier, ch) };
      }
      try {
        return {
          text: await kbQuery({
            question: q,
            tier,
            channelId: ch,
          }),
        };
      } catch (err) {
        console.warn(
          "[marco inbound] kb-query threw — falling through to general-query:",
          err instanceof Error ? err.message : String(err),
        );
        return { text: await generalQuery(q || "help", tier, ch) };
      }
    }
    case "cash-position":
    case "find-in-vault":
      // These don't have dedicated wiring — fall through to the general query
      // which will search Monday and compose a natural answer.
      return { text: await generalQuery(q || routed.args.query || "cash position", tier, ch) };
    case "general-query":
      return { text: await generalQuery(q || "help", tier, ch) };
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
      return { text: await generalQuery(q, tier, ch) };
    default:
      return { text: await generalQuery(q || "help", tier, ch) };
  }
}

async function logAccessDenial(
  payload: NormalizedSlackEvent,
  routed: RoutedRequest,
): Promise<void> {
  const entry = {
    ts: new Date().toISOString(),
    slackUserId: payload.slackUserId,
    channel: routed.replyChannel,
    text: payload.text.slice(0, 200),
    rateLimited: routed.rateLimited ?? false,
  };
  logger.warn("access-denial", entry);
  // Durable audit trail (closes the Phase-6b TODO). Redis, not a local
  // file — Trigger.dev cloud's filesystem is ephemeral. Newest first,
  // capped at 500 entries. Read back: LRANGE marco:log:access-denials 0 -1
  try {
    const r = redis();
    await r.lpush("marco:log:access-denials", JSON.stringify(entry));
    await r.ltrim("marco:log:access-denials", 0, 499);
  } catch (err) {
    logger.warn("access-denial redis log failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
