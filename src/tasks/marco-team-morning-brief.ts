/**
 * Trigger.dev task: comms/marco-team-morning-brief
 *
 * Posts the daily Oltre operational brief at 7:30 AM Pacific, Monday–
 * Friday. Data: Monday Deals + AR 2026 + OCD Schedule (fetched in
 * parallel). One Sonnet-class Claude call composes the prose; every
 * number it uses is pre-computed in code.
 *
 * Spec: .claude/skills/team-morning-brief/SKILL.md, with one deviation:
 * the artifact goes to Redis via lib/deliverables.ts, not a local file
 * (Trigger.dev cloud's filesystem is ephemeral). Saving the artifact is
 * best-effort AFTER delivery — a Redis hiccup must never block the brief.
 *
 * Data integrity: getBoardItems cursor-paginates and reports
 * completeness. An incomplete board read marks that section's facts
 * "INCOMPLETE READ — numbers may be low" instead of authoritative.
 *
 * Destination hard-gate: posting to a channel requires DRY_RUN=0 AND the
 * channel id to appear in APPROVED_CHANNELS below, which only changes
 * with a decisions/log.md entry. An env var alone can no longer publish
 * to a channel — everything else goes to Andrew's DM.
 *
 * Project: proj_nvpgdhytpkikscybodkk
 */

import { schedules, logger } from "@trigger.dev/sdk";
import { isValidBrief } from "./brief-validation.js";
import { beginTaskBudget } from "../../lib/deadline.js";
import { anthropic } from "../../lib/anthropic.js";
import { getBoardItems, BOARDS, type BoardItemRow } from "../../lib/monday.js";
import { postMessage, dmUser } from "../../lib/slack.js";
import { saveDeliverable } from "../../lib/deliverables.js";
import { computeArAggregates, fmtUsd, topOutstanding } from "../../lib/ar.js";
import { MARCO_PERSONA } from "../../lib/marco-persona.js";
import { businessDaysBetween, parseIsoDateNoonUtc } from "../../lib/dates.js";

const ANDREW = "U04D9BPK8H2";

/**
 * Channels the brief is allowed to post to. EMPTY until a decisions/
 * log.md entry names one — Andrew explicitly does not want the brief in
 * #oltre-office yet (2026-07-14). Setting MARCO_OFFICE_CHANNEL_ID alone
 * is NOT sufficient: the id must also be added here, in code review.
 */
const APPROVED_CHANNELS: string[] = [];

// NOTE 2026-07-14: the dashboard /api/state "Today's focus" section was
// removed on Andrew's instruction — its currentFocus data was stale and
// inaccurate. The brief is Monday-boards-only now.

const FLAGGED_STATUS = /\b(red|blocked?|delay(ed)?|stuck|on hold)\b/i;

/** "Shipping soon" horizon for the production section. */
const SHIP_SOON_BUSINESS_DAYS = 5;

const INCOMPLETE_NOTE = "INCOMPLETE READ — numbers may be low";

/** OCD items flagged red OR shipping within the next 5 business days. */
function productionHighlights(items: BoardItemRow[]): string[] {
  const now = new Date();
  const lines: string[] = [];
  for (const item of items) {
    const status = item.columns["Status"] ?? "";
    const shipDate = item.columns["Ship. Date"] ?? "";
    const m = shipDate.match(/(\d{4})-(\d{2})-(\d{2})/);
    const ship = m ? parseIsoDateNoonUtc(m[0]) : null;
    if (FLAGGED_STATUS.test(status)) {
      lines.push(`FLAGGED: ${item.name} — status "${status}"${m ? `, ship ${m[0]}` : ""}`);
    } else if (ship) {
      const businessDaysOut = businessDaysBetween(now, ship);
      if (businessDaysOut >= 0 && businessDaysOut <= SHIP_SOON_BUSINESS_DAYS) {
        lines.push(`Shipping soon: ${item.name} — ${m![0]} (status "${status}")`);
      }
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

// Brief output validation lives in ./brief-validation.ts (format rules +
// numeric grounding against the facts block) so it is unit-testable
// without importing the task graph.

/** Deliverable save is best-effort AFTER delivery — log-only on failure. */
async function saveBriefBestEffort(brief: string): Promise<void> {
  try {
    await saveDeliverable("morning-brief", brief);
  } catch (err) {
    logger.warn("morning-brief deliverable save failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const MAX_DURATION_SEC = 120;

export const marcoTeamMorningBrief = schedules.task({
  id: "comms/marco-team-morning-brief",
  // 7:30 AM Pacific, Mon–Fri.
  cron: { pattern: "30 7 * * 1-5", timezone: "America/Los_Angeles" },
  maxDuration: MAX_DURATION_SEC,
  run: async () => {
    beginTaskBudget(MAX_DURATION_SEC);
    const dryRun = process.env.DRY_RUN !== "0";
    const today = new Date().toISOString().slice(0, 10);

    // All three boards in parallel; each failure degrades gracefully
    // (getBoardItems throws on missing boards — caught here as null).
    const [deals, ar, ocd] = await Promise.all([
      getBoardItems(BOARDS.DEALS).catch(() => null),
      getBoardItems(BOARDS.AR_2026).catch(() => null),
      getBoardItems(BOARDS.OCD_SCHEDULE).catch(() => null),
    ]);

    // Pre-compute every number in code — Claude only writes prose.
    const facts: string[] = [`DATE: ${today}`];

    if (deals) {
      const note = deals.meta.complete ? "" : ` (${INCOMPLETE_NOTE})`;
      facts.push(`DEALS BY STAGE (count)${note}: ${dealCounts(deals.items)}`);
      facts.push(`TOTAL DEALS ON BOARD${note}: ${deals.items.length}`);
    } else {
      facts.push("DEALS: Monday unreachable — pipeline numbers unavailable.");
    }

    if (ar) {
      const label = ar.meta.complete ? "authoritative" : INCOMPLETE_NOTE;
      const agg = computeArAggregates(ar.items);
      const top3 = topOutstanding(ar.items, 3)
        .map((t) => `${t.name}: ${fmtUsd(t.remaining)} outstanding`)
        .join("; ");
      facts.push(
        `AR TOTAL OUTSTANDING (${label}): ${fmtUsd(agg.totalRemaining)} across ${agg.totalItems} items`,
      );
      facts.push(`AR TOP 3 OUTSTANDING (${label}): ${top3 || "none"}`);
    } else {
      facts.push("AR: Monday unreachable — AR numbers unavailable.");
    }

    if (ocd) {
      const highlights = productionHighlights(ocd.items);
      const note = ocd.meta.complete ? "" : ` (${INCOMPLETE_NOTE})`;
      if (highlights.length > 0) {
        facts.push(
          `PRODUCTION (flagged or shipping within ${SHIP_SOON_BUSINESS_DAYS} business days)${note}:\n${highlights.join("\n")}`,
        );
      } else {
        facts.push(
          ocd.meta.complete
            ? `PRODUCTION: nothing flagged, nothing shipping in the next ${SHIP_SOON_BUSINESS_DAYS} business days.`
            : `PRODUCTION: ${INCOMPLETE_NOTE}; nothing flagged in the portion read.`,
        );
      }
    } else {
      facts.push("PRODUCTION: Monday unreachable.");
    }

    // The raw-facts brief is the validated fallback: header + code-computed
    // numbers, no model output.
    const rawFactsBrief = `Oltre — ${today}\n\n${facts.join("\n\n")}`;

    // One Sonnet call turns facts into the brief. Thinking off — this is
    // formatting, not reasoning.
    const client = anthropic();
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
            text: `You are writing Oltre's daily team brief for Slack. Rules:
- Start with the header line "Oltre — ${today}".
- Sections in order: Pipeline, AR, Production.
- Use ONLY the numbers in the FACTS block verbatim — never recalculate, never invent.
- If a fact is marked "${INCOMPLETE_NOTE}", carry that caveat into the brief — do not present that number as exact.
- Team visible: no financial detail beyond the AR outstanding numbers given; never mention personnel matters, negotiation detail, or anything personal.
- Under 400 words. Slack markdown (*bold*, bullet lines). No exclamation marks, no emojis.
- If a section's data is marked unavailable, include one plain line saying so.`,
          },
        ],
        messages: [{ role: "user", content: `FACTS:\n${facts.join("\n\n")}` }],
      });
      const textBlock = res.content.find((b) => b.type === "text");
      brief =
        textBlock && textBlock.type === "text" ? textBlock.text : rawFactsBrief;
    } catch (err) {
      // Claude down → post the raw facts rather than nothing.
      logger.warn("brief composition failed — posting raw facts", {
        error: err instanceof Error ? err.message : String(err),
      });
      brief = rawFactsBrief;
    }

    // Output validation: a composed brief that violates the format rules
    // OR uses any number not present in the facts block never ships —
    // fall back to raw facts.
    if (brief !== rawFactsBrief && !isValidBrief(brief, facts)) {
      logger.warn("composed brief failed output validation — falling back to raw facts", {
        length: brief.length,
      });
      brief = rawFactsBrief;
    }

    // Destination hard-gate: channel posting requires DRY_RUN=0 AND the
    // channel to be in APPROVED_CHANNELS (decisions/log.md entry). Every
    // other combination goes to Andrew's DM with an explanatory note.
    const channel = process.env.MARCO_OFFICE_CHANNEL_ID;
    if (dryRun || !channel || !APPROVED_CHANNELS.includes(channel)) {
      const note = dryRun
        ? "[preview — daily brief; goes only to you until you say otherwise]"
        : !channel
          ? "[no team channel configured — sending to you only]"
          : `[channel ${channel} is set but not in APPROVED_CHANNELS — needs a decisions/log.md entry; sending to you only]`;
      await dmUser(ANDREW, `${note}\n\n${brief}`);
      await saveBriefBestEffort(brief);
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
      await saveBriefBestEffort(brief);
      return { ok: false, posted: false, error: msg };
    }

    await saveBriefBestEffort(brief);
    return { ok: true, posted: true };
  },
});
