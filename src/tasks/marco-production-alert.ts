/**
 * Trigger.dev task: comms/marco-production-alert
 *
 * Polls the OCD Schedule board every 30 minutes during business hours.
 * DMs Alex T. + Andrew when an item is flagged red/blocked/delayed, a
 * ship date has passed without the item shipping, or a ship date has
 * slipped by more than 3 business days since we last saw it. Zero Claude
 * calls — pure Monday reads + code, so it's fast and cheap.
 *
 * Spec: .claude/skills/production-alert/SKILL.md, with one deviation:
 * de-dup state lives in Redis, not a local JSON file — Trigger.dev
 * cloud's filesystem is ephemeral. Redis keys:
 *   marco:prodalert:<dedupId>:<recipientUserId> — per-recipient de-dup,
 *     marked only AFTER that recipient's DM succeeded (a failed DM is
 *     retried naturally on the next slot).
 *   marco:prodalert-dry:*                       — same, for DRY_RUN, so
 *     preview runs never suppress real alerts.
 *   marco:prodship:<itemId>                     — last seen ship date
 *     (plain "YYYY-MM-DD"), for slip detection. 30-day TTL.
 *
 * Data integrity: getBoardItems now cursor-paginates and reports
 * completeness. An incomplete read must NOT produce "no new production
 * flags" — that silence would be a lie — so we skip and tell Andrew.
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
import { businessDaysBetween, parseIsoDateNoonUtc } from "../../lib/dates.js";

// Slack IDs mirror .claude/rules/slack-allowlist.md — this alert is
// Tier-1/ops only. Bella and Alex P are never paged by it.
const ANDREW = "U04D9BPK8H2";
const ALEX_T = "U04J52R155H";

const MAX_ALERTS_PER_RUN = 5;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

/** Stored ship dates for slip detection: marco:prodship:<itemId>, 30 days. */
const SHIP_KEY_PREFIX = "marco:prodship:";
const SHIP_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A ship date moving later than this many business days is a slip alert. */
const SLIP_BUSINESS_DAYS = 3;

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
  /**
   * De-dup identity. Plain item id for status/missed-ship flags;
   * `<itemId>:slip` for slip flags so a slip and a status flag on the
   * same item don't share a Redis key.
   */
  dedupId: string;
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
        dedupId: item.id,
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
            dedupId: item.id,
          });
        }
      }
    }
  }
  return flags;
}

/**
 * Slip detection (SKILL.md condition 3): compare each active item's ship
 * date against the last one we stored. A move of more than 3 business
 * days later is a slip flag. Stored dates are refreshed every run for
 * every active item that has one.
 */
async function findSlipFlags(items: BoardItemRow[]): Promise<Flag[]> {
  const flags: Flag[] = [];
  for (const item of items) {
    const status = item.columns["Status"] ?? "";
    // Terminal items don't slip — and skipping them keeps Redis traffic
    // bounded to the active portion of the board.
    if (DONE_STATUS.test(status)) continue;

    const shipRaw = item.columns["Ship. Date"] ?? "";
    const m = shipRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    const current = m[0];

    const key = `${SHIP_KEY_PREFIX}${item.id}`;
    const stored = (await redis().get(key)) as string | null;
    if (stored && stored !== current) {
      const from = parseIsoDateNoonUtc(stored);
      const to = parseIsoDateNoonUtc(current);
      if (from && to && businessDaysBetween(from, to) > SLIP_BUSINESS_DAYS) {
        flags.push({
          item,
          reason: `ship date slipped from ${stored} to ${current}`,
          stateHash: `slip|${stored}|${current}`,
          dedupId: `${item.id}:slip`,
        });
      }
    }
    await redis().set(key, current, { ex: SHIP_TTL_SECONDS });
  }
  return flags;
}

function alertLine(f: Flag): string {
  const last = f.item.updatedAt
    ? ` Last update: ${f.item.updatedAt.slice(0, 10)}.`
    : "";
  return `OCD flag: *${f.item.name}* — ${f.reason}. <${f.item.url}|Monday link>${last}`;
}

function buildBody(fresh: Flag[]): string {
  const lines = fresh.map(alertLine);
  if (fresh.length > MAX_ALERTS_PER_RUN) {
    return (
      `${fresh.length} OCD Schedule items are flagged right now — top ${MAX_ALERTS_PER_RUN}:\n` +
      lines.slice(0, MAX_ALERTS_PER_RUN).join("\n") +
      `\n…and ${fresh.length - MAX_ALERTS_PER_RUN} more. Full picture on the <https://oregonfivestar-company.monday.com/boards/${BOARDS.OCD_SCHEDULE}|OCD Schedule board>.`
    );
  }
  return lines.join("\n");
}

/** "HH-MM" in America/Los_Angeles, for per-run deliverable keys. */
function laHourMinute(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date())
    .replace(":", "-");
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
      const board = await getBoardItems(BOARDS.OCD_SCHEDULE);
      if (!board.meta.complete) {
        // A truncated read means "nothing flagged" would be unprovable —
        // never report success on partial data.
        logger.error("OCD Schedule read incomplete — skipping run", {
          itemCount: board.meta.itemCount,
          pages: board.meta.pages,
        });
        try {
          await dmUser(
            ANDREW,
            "Production alert skipped: OCD Schedule read was incomplete (board too large or API truncation).",
          );
        } catch (err) {
          logger.error("incomplete-read DM to Andrew failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return { ok: false, skipped: "incomplete_read" };
      }
      items = board.items;
    } catch (err) {
      // Monday down or board gone → skip this slot; the cron fires again
      // in 30 min. (getBoardItems now throws on a missing board.)
      logger.warn("OCD Schedule unreachable — skipping this run", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, skipped: "monday_unreachable" };
    }

    const flags = [...findFlags(items), ...(await findSlipFlags(items))];

    // De-dup PER RECIPIENT: only alert a recipient when the flag's state
    // changed since the last DM that actually reached them. DRY_RUN uses
    // its own prefix so previews never suppress real alerts.
    const dedupPrefix = dryRun ? "marco:prodalert-dry" : "marco:prodalert";
    const recipients = dryRun ? [ANDREW] : [ALEX_T, ANDREW];

    const freshByRecipient = new Map<string, Flag[]>();
    for (const userId of recipients) {
      const freshForUser: Flag[] = [];
      for (const f of flags) {
        const key = `${dedupPrefix}:${f.dedupId}:${userId}`;
        const last = (await redis().get(key)) as string | null;
        if (last === f.stateHash) continue;
        freshForUser.push(f);
      }
      if (freshForUser.length > 0) freshByRecipient.set(userId, freshForUser);
    }

    if (freshByRecipient.size === 0) {
      // Safe to say only because meta.complete was verified above.
      logger.info("no new production flags", { totalFlagged: flags.length });
      return { ok: true, flagged: flags.length, alerted: 0 };
    }

    // Deliverable: the union of everything fresh for at least one
    // recipient. Name carries HH-MM so twice-hourly runs don't collide
    // on the same daily key.
    const seen = new Set<string>();
    const unionFresh: Flag[] = [];
    for (const list of freshByRecipient.values()) {
      for (const f of list) {
        if (!seen.has(f.dedupId)) {
          seen.add(f.dedupId);
          unionFresh.push(f);
        }
      }
    }
    await saveDeliverable(`production-alert-${laHourMinute()}`, buildBody(unionFresh));

    // DM each recipient their own fresh set; mark a flag delivered for a
    // recipient ONLY after their DM succeeded.
    let notified = 0;
    for (const userId of recipients) {
      const freshForUser = freshByRecipient.get(userId);
      if (!freshForUser) continue;
      const body = buildBody(freshForUser);
      const text = dryRun ? `[DRY RUN — Alex T not paged]\n${body}` : body;
      try {
        await dmUser(userId, text);
        notified++;
        for (const f of freshForUser) {
          await redis().set(`${dedupPrefix}:${f.dedupId}:${userId}`, f.stateHash, {
            ex: DEDUP_TTL_SECONDS,
          });
        }
      } catch (err) {
        logger.error("production-alert DM failed — de-dup NOT marked, will retry next slot", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("production alerts sent", {
      alerted: unionFresh.length,
      recipientsNotified: notified,
      dryRun,
    });
    return {
      ok: true,
      flagged: flags.length,
      alerted: unionFresh.length,
      recipientsNotified: notified,
      dryRun,
    };
  },
});
