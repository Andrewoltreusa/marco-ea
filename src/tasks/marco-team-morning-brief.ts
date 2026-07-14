/**
 * Trigger.dev task: comms/marco-team-morning-brief
 *
 * Posts the daily Oltre operational brief to #oltre-office at 7:30 AM
 * Pacific, Monday–Friday. Data: Monday Deals + AR 2026 + OCD Schedule
 * (fetched in parallel) plus the Oltre Dashboard state endpoint. One
 * Sonnet-class Claude call composes the prose; every number it uses is
 * pre-computed in code.
 *
 * Spec: .claude/skills/team-morning-brief/SKILL.md, with one deviation:
 * the artifact goes to Redis via lib/deliverables.ts, not a local file
 * (Trigger.dev cloud's filesystem is ephemeral).
 *
 * DRY_RUN=1 (default when unset): DM Andrew a preview; do NOT post to
 * the channel. DRY_RUN=0: post to MARCO_OFFICE_CHANNEL_ID (falls back
 * to a DM to Andrew with a note if the channel id is missing or Marco
 * isn't in the channel).
 *
 * Project: proj_nvpgdhytpkikscybodkk
 */

import { schedules, logger } from "@trigger.dev/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { getBoardItems, BOARDS, type BoardItemRow } from "../../lib/monday.js";
import { postMessage, dmUser } from "../../lib/slack.js";
import { saveDeliverable } from "../../lib/deliverables.js";
import { computeArAggregates, fmtUsd, topOutstanding } from "../../lib/ar.js";
import { MARCO_PERSONA } from "../../lib/marco-persona.js";

const ANDREW = "U04D9BPK8H2";

interface DashboardState {
  currentFocus?: string;
  priorities?: string[];
  completedToday?: string[];
}

async function getDashboardState(): Promise<DashboardState | null> {
  const token = process.env.OLTRE_DASHBOARD_API_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch("https://oltre-dashboard.vercel.app/api/state", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as DashboardState;
  } catch {
    return null;
  }
}

const FLAGGED_STATUS = /\b(red|blocked?|delay(ed)?|stuck|on hold)\b/i;

/** OCD items flagged red OR shipping within the next 7 calendar days. */
function productionHighlights(items: BoardItemRow[]): string[] {
  const now = Date.now();
  const soon = now + 7 * 24 * 60 * 60 * 1000;
  const lines: string[] = [];
  for (const item of items) {
    const status = item.columns["Status"] ?? "";
    const shipDate = item.columns["Ship. Date"] ?? "";
    const m = shipDate.match(/(\d{4})-(\d{2})-(\d{2})/);
    const shipTs = m ? new Date(`${m[0]}T12:00:00-07:00`).getTime() : null;
    if (FLAGGED_STATUS.test(status)) {
      lines.push(`FLAGGED: ${item.name} — status "${status}"${m ? `, ship ${m[0]}` : ""}`);
    } else if (shipTs && shipTs >= now && shipTs <= soon) {
      lines.push(`Shipping soon: ${item.name} — ${m![0]} (status "${status}")`);
    }
  }
  return lines.slice(0, 10);
}

/** Deals: counts per stage, computed in code. */
function dealCounts(items: BoardItemRow[]): string {
  const byStage = new Map<string, number>();
  for (const item of items) {
    const stage = item.columns["Stage"] || "(no stage)";
    byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
  }
  return Array.from(byStage.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([stage, n]) => `${stage}: ${n}`)
    .join(", ");
}

export const marcoTeamMorningBrief = schedules.task({
  id: "comms/marco-team-morning-brief",
  // 7:30 AM Pacific, Mon–Fri.
  cron: { pattern: "30 7 * * 1-5", timezone: "America/Los_Angeles" },
  maxDuration: 120,
  run: async () => {
    const dryRun = process.env.DRY_RUN !== "0";
    const today = new Date().toISOString().slice(0, 10);

    // All four sources in parallel; each failure degrades gracefully.
    const [deals, ar, ocd, dashboard] = await Promise.all([
      getBoardItems(BOARDS.DEALS, { limit: 500 }).catch(() => null),
      getBoardItems(BOARDS.AR_2026, { limit: 500 }).catch(() => null),
      getBoardItems(BOARDS.OCD_SCHEDULE, { limit: 500 }).catch(() => null),
      getDashboardState(),
    ]);

    // Pre-compute every number in code — Claude only writes prose.
    const facts: string[] = [`DATE: ${today}`];

    if (deals) {
      facts.push(`DEALS BY STAGE (count): ${dealCounts(deals.items)}`);
      facts.push(`TOTAL DEALS ON BOARD: ${deals.items.length}`);
    } else {
      facts.push("DEALS: Monday unreachable — pipeline numbers unavailable.");
    }

    if (ar) {
      const agg = computeArAggregates(ar.items);
      const top3 = topOutstanding(ar.items, 3)
        .map((t) => `${t.name}: ${fmtUsd(t.remaining)} outstanding`)
        .join("; ");
      facts.push(
        `AR TOTAL OUTSTANDING (authoritative): ${fmtUsd(agg.totalRemaining)} across ${agg.totalItems} items`,
      );
      facts.push(`AR TOP 3 OUTSTANDING (authoritative): ${top3 || "none"}`);
    } else {
      facts.push("AR: Monday unreachable — AR numbers unavailable.");
    }

    if (ocd) {
      const highlights = productionHighlights(ocd.items);
      facts.push(
        highlights.length > 0
          ? `PRODUCTION (flagged or shipping within 7 days):\n${highlights.join("\n")}`
          : "PRODUCTION: nothing flagged, nothing shipping in the next 7 days.",
      );
    } else {
      facts.push("PRODUCTION: Monday unreachable.");
    }

    if (dashboard) {
      if (dashboard.currentFocus) facts.push(`TODAY'S FOCUS (Andrew): ${dashboard.currentFocus}`);
      if (dashboard.priorities?.length)
        facts.push(`PRIORITIES: ${dashboard.priorities.slice(0, 3).join("; ")}`);
      if (dashboard.completedToday?.length)
        facts.push(`COMPLETED YESTERDAY/TODAY: ${dashboard.completedToday.slice(0, 5).join("; ")}`);
    } else {
      facts.push("FOCUS: dashboard unreachable — skip the focus section.");
    }

    // One Sonnet call turns facts into the brief. Thinking off — this is
    // formatting, not reasoning.
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let brief: string;
    try {
      const res = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 700,
        thinking: { type: "disabled" },
        system: [
          { type: "text", text: MARCO_PERSONA, cache_control: { type: "ephemeral" } },
          {
            type: "text",
            text: `You are writing Oltre's daily team brief for the #oltre-office Slack channel. Rules:
- Start with the header line "Oltre — ${today}".
- Sections in order: Pipeline, AR, Production, Wins (only if any), Today's focus (only if provided).
- Use ONLY the numbers in the FACTS block verbatim — never recalculate, never invent.
- Tier-2 visible: no financial detail beyond the AR outstanding numbers given; never mention personnel matters, negotiation detail, Uplift AI, or Andrew's personal tasks.
- Under 400 words. Slack markdown (*bold*, bullet lines). No exclamation marks, no emojis.
- If a section's data is marked unavailable, include one plain line saying so.`,
          },
        ],
        messages: [{ role: "user", content: `FACTS:\n${facts.join("\n\n")}` }],
      });
      const textBlock = res.content.find((b) => b.type === "text");
      brief =
        textBlock && textBlock.type === "text"
          ? textBlock.text
          : `Oltre — ${today}\n\n${facts.join("\n\n")}`;
    } catch (err) {
      // Claude down → post the raw facts rather than nothing.
      logger.warn("brief composition failed — posting raw facts", {
        error: err instanceof Error ? err.message : String(err),
      });
      brief = `Oltre — ${today}\n\n${facts.join("\n\n")}`;
    }

    await saveDeliverable("morning-brief", brief);

    const channel = process.env.MARCO_OFFICE_CHANNEL_ID;
    if (dryRun || !channel) {
      const note = dryRun
        ? "[DRY RUN — not posted to #oltre-office]"
        : "[MARCO_OFFICE_CHANNEL_ID not set — invite Marco to #oltre-office and set the env var]";
      await dmUser(ANDREW, `${note}\n\n${brief}`);
      return { ok: true, posted: false, dryRun, savedTo: "redis" };
    }

    try {
      await postMessage({ channel, text: brief });
    } catch (err) {
      // not_in_channel or similar — never fail silently.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("channel post failed — falling back to Andrew DM", { error: msg });
      await dmUser(
        ANDREW,
        `Couldn't post the morning brief to <#${channel}> (${msg.slice(0, 120)}). Here it is:\n\n${brief}`,
      );
      return { ok: false, posted: false, error: msg };
    }

    return { ok: true, posted: true };
  },
});
