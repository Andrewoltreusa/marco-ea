/**
 * Trigger.dev task: comms/marco-production-alert
 *
 * Polls the OCD Schedule board every 30 minutes during business hours.
 * DMs Alex T. + Andrew when an item is flagged red/blocked/delayed or a
 * ship date has passed without the item shipping. Zero Claude calls —
 * pure Monday reads + code, so it's fast and cheap.
 *
 * Spec: .claude/skills/production-alert/SKILL.md, with one deviation:
 * de-dup state lives in Redis (`marco:prodalert:<itemId>`), not a local
 * JSON file — Trigger.dev cloud's filesystem is ephemeral.
 *
 * DRY_RUN=1 (default when unset): DM Andrew only, prefixed [DRY RUN].
 * DRY_RUN=0: DM Alex T. + Andrew.
 *
 * Project: proj_nvpgdhytpkikscybodkk
 */

import { schedules, logger } from "@trigger.dev/sdk";
import { getBoardItems, BOARDS, type BoardItemRow } from "../../lib/monday.js";
import { dmUser } from "../../lib/slack.js";
import { redis } from "../../lib/redis.js";
import { saveDeliverable } from "../../lib/deliverables.js";

// Slack IDs mirror .claude/rules/slack-allowlist.md — this alert is
// Tier-1/ops only. Bella and Alex P are never paged by it.
const ANDREW = "U04D9BPK8H2";
const ALEX_T = "U04J52R155H";

const MAX_ALERTS_PER_RUN = 5;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

const FLAGGED_STATUS = /\b(red|blocked?|delay(ed)?|stuck|on hold)\b/i;
// Terminal statuses that mean "past ship date is fine" — verified against
// live board data 2026-07-14: "Installed" is Oltre's most common terminal
// state (58 old items would false-alarm without it).
const DONE_STATUS =
  /\b(shipped|done|complete(d)?|delivered|picked up|installed|invoiced|paid|cancel(l)?ed)\b/i;

interface Flag {
  item: BoardItemRow;
  reason: string;
  stateHash: string;
}

function findFlags(items: BoardItemRow[]): Flag[] {
  const now = new Date();
  const flags: Flag[] = [];

  for (const item of items) {
    const status = item.columns["Status"] ?? "";
    const shipDate = item.columns["Ship. Date"] ?? "";
    const stateHash = `${status}|${shipDate}`;

    if (FLAGGED_STATUS.test(status)) {
      flags.push({
        item,
        reason: `status is "${status}"`,
        stateHash,
      });
      continue;
    }

    // Missed ship date: date in the past, status not terminal.
    if (shipDate && !DONE_STATUS.test(status)) {
      const m = shipDate.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        const due = new Date(`${m[0]}T23:59:59-07:00`);
        if (due < now) {
          flags.push({
            item,
            reason: `ship date ${m[0]} has passed and status is still "${status || "empty"}"`,
            stateHash,
          });
        }
      }
    }
  }
  return flags;
}

export const marcoProductionAlert = schedules.task({
  id: "comms/marco-production-alert",
  // Every 30 min, 7 AM–6 PM Pacific, Mon–Fri.
  cron: { pattern: "*/30 7-18 * * 1-5", timezone: "America/Los_Angeles" },
  maxDuration: 60,
  // SKILL.md: never retry inside the same cron slot — the next slot is
  // 30 minutes away anyway.
  retry: { maxAttempts: 1 },
  run: async () => {
    const dryRun = process.env.DRY_RUN !== "0";

    let items: BoardItemRow[];
    try {
      const board = await getBoardItems(BOARDS.OCD_SCHEDULE, { limit: 500 });
      items = board.items;
    } catch (err) {
      // Monday down → skip this slot; the cron fires again in 30 min.
      logger.warn("OCD Schedule unreachable — skipping this run", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, skipped: "monday_unreachable" };
    }

    const flags = findFlags(items);

    // De-dup: only alert when an item's (status|shipDate) changed since
    // the last alert, and at most once per 24h for the same state.
    const fresh: Flag[] = [];
    for (const f of flags) {
      const key = `marco:prodalert:${f.item.id}`;
      const last = (await redis().get(key)) as string | null;
      if (last === f.stateHash) continue;
      fresh.push(f);
    }

    if (fresh.length === 0) {
      logger.info("no new production flags", { totalFlagged: flags.length });
      return { ok: true, flagged: flags.length, alerted: 0 };
    }

    // Build message bodies. Never include customer financial info —
    // OCD Schedule columns are production-only, but keep to the format.
    const lines = fresh.map((f) => {
      return `OCD flag: *${f.item.name}* — ${f.reason}. <${f.item.url}|Monday link>`;
    });

    let body: string;
    if (fresh.length > MAX_ALERTS_PER_RUN) {
      body =
        `${fresh.length} OCD Schedule items are flagged right now — top ${MAX_ALERTS_PER_RUN}:\n` +
        lines.slice(0, MAX_ALERTS_PER_RUN).join("\n") +
        `\n…and ${fresh.length - MAX_ALERTS_PER_RUN} more. Full picture on the <https://oregonfivestar-company.monday.com/boards/${BOARDS.OCD_SCHEDULE}|OCD Schedule board>.`;
    } else {
      body = lines.join("\n");
    }

    await saveDeliverable("production-alert", body);

    const recipients = dryRun ? [ANDREW] : [ALEX_T, ANDREW];
    const text = dryRun ? `[DRY RUN — Alex T not paged]\n${body}` : body;
    for (const userId of recipients) {
      try {
        await dmUser(userId, text);
      } catch (err) {
        logger.error("production-alert DM failed", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Mark alerted states only after the DMs went out.
    for (const f of fresh) {
      await redis().set(`marco:prodalert:${f.item.id}`, f.stateHash, {
        ex: DEDUP_TTL_SECONDS,
      });
    }

    logger.info("production alerts sent", {
      alerted: fresh.length,
      dryRun,
    });
    return { ok: true, flagged: flags.length, alerted: fresh.length, dryRun };
  },
});
