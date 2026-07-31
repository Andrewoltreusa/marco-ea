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
import {
  routeInbound,
  tier3ShouldPost,
  type RoutedRequest,
} from "../slack/router.js";
import { postMessage, dmUser, addReaction, swapReaction } from "../../lib/slack.js";
import { beginRequest, markResponded, markDelegated, redis } from "../../lib/redis.js";
import { auditRequest } from "../../lib/audit.js";
import { pushOutboxEntry } from "../../lib/outbox.js";
import { beginTaskBudget } from "../../lib/deadline.js";
import { isFinancialQuestion } from "../skills/general-query.js";
import { dealStatus } from "../skills/deal-status.js";
import { productionEta } from "../skills/production-eta.js";
import { leadCheck } from "../skills/lead-check.js";
import { agentFleetHealth } from "../skills/agent-fleet-health.js";
import { generalQuery } from "../skills/general-query.js";
import { kbQuery } from "../skills/kb-query.js";
import { boardStats } from "../skills/board-stats.js";

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

// 120s: heavy financial/KB queries could breach the old 60s cap and
// trigger platform retries.
const MAX_DURATION_SEC = 120;

// Durable Tier-3 refusal window. The router's Map is process-local and
// every Trigger run is a fresh process — this key is what actually holds
// the one-refusal-per-24h contract across runs.
const TIER3_REFUSED_KEY = (userId: string) => `marco:tier3:refused:${userId}`;
const TIER3_REFUSAL_WINDOW_SEC = 86_400;

// Prefixed onto general-query answers that were supposed to come from
// the KB (flag off or KB call failed) — the asker must know the answer
// skipped the playbook.
const KB_FALLBACK_NOTE =
  "KB lookup unavailable — answering from Monday data only.";

export const marcoSlackInbound = task({
  id: "comms/marco-slack-inbound",
  maxDuration: MAX_DURATION_SEC,
  // maxAttempts 1 because a retry re-runs the whole pipeline and can
  // double-post — the in-code never-silent catch already turns failures
  // into an error reply.
  retry: { maxAttempts: 1 },
  run: async (payload: NormalizedSlackEvent & { __probe?: boolean }) => {
    beginTaskBudget(MAX_DURATION_SEC);
    const startedAt = Date.now();

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

    // Tier classification FIRST — Tier-3 traffic must never create
    // request-lifecycle state or receive acks/DMs beyond the single
    // refusal. Its only Redis footprint is the denial log + refusal key.
    const routed = routeInbound({
      slackUserId: payload.slackUserId,
      channel: payload.channel,
      text: payload.text,
      threadTs: payload.threadTs,
      isDM: payload.isDM,
    });
    logger.info("routed", { tier: routed.tier, skill: routed.skill });

    const lifecycleKey = payload.eventId
      ? `marco:evt:${payload.eventId}`
      : payload.eventTs
        ? `marco:evt:${payload.channel}:${payload.eventTs}`
        : null;
    const canReact = payload.source !== "slash_command" && !!payload.eventTs;

    // Durable request audit (CODEX finding 32) — one bounded record per
    // handled request. The write path is the exception: the CHILD writes
    // the terminal record (it delivers the reply); the parent audits only
    // enqueue failure. Strictly best-effort: an audit failure must never
    // affect the reply.
    const audit = (ok: boolean) =>
      auditRequest({
        ts: new Date().toISOString(),
        eventId: lifecycleKey,
        user: payload.slackUserId,
        tier: routed.tier,
        skill: routed.skill,
        ok,
        ms: Date.now() - startedAt,
      });

    if (routed.skill === "refuse") {
      // Durable 24h refusal window (CODEX finding 9). The router's Map
      // is process-local — fresh per Trigger run — so the cross-run gate
      // is SET NX EX 86400 on the per-user key: only the run that wins
      // the key posts. Redis down → fall back to the in-memory verdict
      // rather than going fully silent on a first refusal.
      let redisSetOk: boolean | null = null;
      try {
        const won = await redis().set(TIER3_REFUSED_KEY(payload.slackUserId), "1", {
          nx: true,
          ex: TIER3_REFUSAL_WINDOW_SEC,
        });
        redisSetOk = won === "OK";
      } catch (err) {
        logger.warn("tier-3 refusal gate redis unavailable — using in-memory verdict", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const shouldPost = tier3ShouldPost({
        inMemoryRateLimited: !!routed.rateLimited,
        redisSetOk,
      });
      await logAccessDenial(payload, routed, !shouldPost);
      let posted = false;
      if (shouldPost) {
        try {
          await postMessage({
            channel: routed.replyChannel,
            text: routed.args.text ?? "Refused.",
            thread_ts: routed.threadTs,
          });
          posted = true;
        } catch (err) {
          logger.warn("tier-3 refusal post failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // ok = the actual outcome: rate-limited silence is deliberate, a
      // failed refusal post is not.
      await audit(!shouldPost || posted);
      return { ok: true, tier: 3, posted };
    }

    // Everything below is an authorized (Tier 1/2) request. The outer
    // catch is the never-silent guarantee of last resort: ANY unexpected
    // throw becomes a DM to the asker, not a dead run in a dashboard.

    try {
      // ─── Request lifecycle (dedup that can't poison) ────────
      // Non-fatal by design: if Redis is down we'd rather risk a rare
      // double answer than guarantee silence.
      if (lifecycleKey) {
        try {
          const state = await beginRequest(lifecycleKey);
          if (state === "duplicate") {
            // No audit record: nothing was delivered, and the run that
            // actually answered already recorded one for this eventId.
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
            lifecycleKey,
          });
          logger.info("monday-update delegated", {
            user: payload.slackUserId,
            runId: triggered.id,
          });
          // Lifecycle stays OPEN but flips to the delegated phase: the
          // child can legitimately take minutes (queue + its 60s budget),
          // so a Slack redelivery must use the 15-min staleness threshold
          // instead of 120s — otherwise it would take over a request whose
          // child is alive and duplicate the preview. The child marks it
          // responded after its terminal reply and writes the terminal
          // audit record.
          if (lifecycleKey) await markDelegated(lifecycleKey);
          // The outbox entry lets the watchdog catch a child that dies
          // before replying.
          try {
            await pushOutboxEntry({
              lifecycleKey,
              childRunId: triggered.id,
              requester: payload.slackUserId,
              channel: routed.replyChannel,
              eventTs: payload.eventTs ?? null,
              ts: new Date().toISOString(),
            });
          } catch (outboxErr) {
            // Same Redis outage would break the lifecycle anyway — the
            // enqueue itself succeeded, so don't fail the request.
            logger.warn("outbox push failed — watchdog blind for this delegation", {
              error: outboxErr instanceof Error ? outboxErr.message : String(outboxErr),
            });
          }
          // 📝 = "drafting" — the child resolves this emoji when the draft
          // is approved (✅) or rejected (❌).
          if (canReact) {
            await swapReaction(payload.channel, payload.eventTs!, "eyes", "memo");
          }
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
          await audit(false);
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
      await audit(!hadError);
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
      await audit(false);
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
    case "board-stats":
      // Zero-LLM board aggregates ("how many leads do we have?") —
      // counted in code from a full board read, never by the model.
      return { text: await boardStats(q || payload.text) };
    case "kb-query": {
      // Feature-flagged. If ENABLE_KB isn't "true", OR the KB call throws,
      // fall through to general-query so Marco stays answerable while we
      // iterate on the KB plumbing. The substituted answer is DISCLOSED —
      // a process question answered without the playbook must say so, not
      // impersonate a KB answer (CODEX finding 7).
      if (process.env.ENABLE_KB !== "true") {
        console.info(
          "[marco inbound] kb-query routed but ENABLE_KB!=true — falling through to general-query",
        );
        return {
          text: `${KB_FALLBACK_NOTE}\n${await generalQuery(q || "help", tier, ch)}`,
        };
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
        return {
          text: `${KB_FALLBACK_NOTE}\n${await generalQuery(q || "help", tier, ch)}`,
        };
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
  // The EFFECTIVE verdict after the Redis gate — the allowlist requires
  // logging the action actually taken (reply sent / rate-limited
  // silence), not the router's process-local guess.
  rateLimited: boolean,
): Promise<void> {
  const entry = {
    ts: new Date().toISOString(),
    slackUserId: payload.slackUserId,
    channel: routed.replyChannel,
    text: payload.text.slice(0, 200),
    rateLimited,
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
