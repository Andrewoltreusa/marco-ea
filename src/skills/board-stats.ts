/**
 * board-stats skill — zero-LLM aggregate answers over Monday boards.
 *
 * Examples that land here (router board-aggregate patterns):
 *   "How many leads do we have?"
 *   "What deals are closing this week?"
 *   "Can you count the contacts?"
 *
 * CODEX finding 18: these questions used to fall into kb-query (the
 * `^how` rule) or the general fallback and produced vague or invented
 * answers. Counting is code, not model — no Claude call happens here.
 *
 * Column conventions mirror the other read skills:
 *   - Deals    → "Stage"       (deal-status.ts)
 *   - Leads    → "Status"      (lead-check.ts)
 *   - Contacts → "Deal Status" (deal-status.ts contact fallback), then "Status"
 */

import {
  getBoardItems,
  BOARDS,
  type BoardItemRow,
} from "../../lib/monday.js";
import { parseIsoDateNoonUtc, isSameIsoWeek, addDays } from "../../lib/dates.js";

export type StatsBoard = "deals" | "leads" | "contacts";

export type StatsTimeframe = "thisWeek" | "nextWeek" | "unsupported" | null;

export interface BoardStatsPlan {
  board: StatsBoard;
  /**
   * Closing/due timeframe (finding 6):
   *   "thisWeek" / "nextWeek" — the two ISO-week slices we can compute;
   *   "unsupported" — a closing/due question with any OTHER timeframe
   *     ("in June", "by Q3") — gets an explicit refusal, NEVER the
   *     whole-board count;
   *   null — not a closing/due question, or no timeframe given.
   */
  timeframe: StatsTimeframe;
  /** Back-compat alias: timeframe === "thisWeek". */
  closingThisWeek: boolean;
  /** Lowercased question text, used for stage/status filter matching. */
  text: string;
}

/**
 * Timeframe phrasings we can NOT slice (months, quarters, years, other
 * week phrasings, explicit dates). Only consulted after "this week" /
 * "next week" have already failed to match, so plain `\bweek\b` here
 * means phrasings like "in two weeks" or "week of the 15th". "may" is
 * both a month and a modal verb, so it only counts with a preposition
 * or a following number.
 */
const UNSUPPORTED_TIMEFRAME = new RegExp(
  [
    "\\b(january|february|march|april|june|july|august|september|october|november|december)\\b",
    "\\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\b",
    "\\b(in|by|for|during|of|before|until)\\s+may\\b",
    "\\bmay\\s+\\d{1,2}\\b",
    "\\bq[1-4]\\b",
    "\\bquarter\\b",
    "\\b(this|next|last|current|the)\\s+(month|year)\\b",
    "\\bend of\\b",
    "\\bweeks?\\b",
    "\\btoday\\b",
    "\\btomorrow\\b",
    "\\b20\\d{2}\\b",
    "\\d{4}-\\d{2}",
    "\\d{1,2}/\\d{1,2}",
  ].join("|"),
);

const BOARD_IDS: Record<StatsBoard, string> = {
  deals: BOARDS.DEALS,
  leads: BOARDS.LEADS,
  contacts: BOARDS.CONTACTS,
};

/** Which column carries the pipeline grouping on each board (in priority order). */
const STAGE_COLUMNS: Record<StatsBoard, string[]> = {
  deals: ["Stage"],
  leads: ["Status"],
  contacts: ["Deal Status", "Status"],
};

const STAGE_LABEL: Record<StatsBoard, string> = {
  deals: "Stage",
  leads: "Status",
  contacts: "Deal Status",
};

/**
 * Parse the question into a plan: which board (first-mentioned wins;
 * default Deals) and, for closing/due questions, which timeframe.
 * Exported for unit tests.
 */
export function parseBoardStatsQuestion(raw: string): BoardStatsPlan {
  const text = raw.trim().toLowerCase();

  const mentions: Array<{ board: StatsBoard; idx: number }> = [];
  for (const board of ["deals", "leads", "contacts"] as const) {
    const singular = board.slice(0, -1);
    const m = text.match(new RegExp(`\\b${singular}s?\\b`));
    if (m && m.index !== undefined) mentions.push({ board, idx: m.index });
  }
  mentions.sort((a, b) => a.idx - b.idx);
  const board: StatsBoard = mentions[0]?.board ?? "deals";

  const closingVerb = /\b(closing|close|closes|due|expected)\b/.test(text);
  let timeframe: StatsTimeframe = null;
  if (closingVerb) {
    if (/\b(this|current)\s+week\b/.test(text)) timeframe = "thisWeek";
    else if (/\bnext\s+week\b/.test(text)) timeframe = "nextWeek";
    else if (UNSUPPORTED_TIMEFRAME.test(text)) timeframe = "unsupported";
  }

  return { board, timeframe, closingThisWeek: timeframe === "thisWeek", text };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First non-empty grouping column value for a row, or "—". */
function stageOf(row: BoardItemRow, board: StatsBoard): string {
  for (const col of STAGE_COLUMNS[board]) {
    const v = row.columns[col];
    if (v && v.trim()) return v.trim();
  }
  return "—";
}

export async function boardStats(question: string): Promise<string> {
  const plan = parseBoardStatsQuestion(question);

  // Finding 6: a closing/due question with a timeframe we can't slice
  // gets an explicit refusal BEFORE any board read — falling through to
  // the whole-board count confidently answered a question the user
  // didn't ask.
  if (plan.timeframe === "unsupported") {
    return "I can slice closings by this week or next week right now — for other ranges check the Deals board directly.";
  }

  const { boardName, items, meta } = await getBoardItems(BOARD_IDS[plan.board]);

  // Honesty rule: always cite how much of the board was actually read.
  const source = `_Source: Monday ${boardName} (${meta.itemCount} items read${
    meta.complete ? "" : ", incomplete"
  })_`;

  // ─── "Closing this/next week" (Deals only — Close Date lives there) ───
  if (
    plan.board === "deals" &&
    (plan.timeframe === "thisWeek" || plan.timeframe === "nextWeek")
  ) {
    // "Next week" = the ISO week (Mon–Sun) containing now + 7 days.
    const ref =
      plan.timeframe === "nextWeek" ? addDays(new Date(), 7) : new Date();
    const weekLabel = plan.timeframe === "nextWeek" ? "next week" : "this week";
    const closing = items
      .map((row) => ({
        row,
        close: row.columns["Close Date"]
          ? parseIsoDateNoonUtc(row.columns["Close Date"])
          : null,
      }))
      .filter(
        (x): x is { row: BoardItemRow; close: Date } =>
          x.close !== null && isSameIsoWeek(x.close, ref),
      )
      .sort((a, b) => a.close.getTime() - b.close.getTime());

    if (closing.length === 0) {
      return `No deals have a Close Date ${weekLabel} (Mon–Sun).\n${source}`;
    }

    const shown = closing.slice(0, 15);
    const lines = shown.map(({ row }) => {
      const stage = stageOf(row, "deals");
      return `• *${row.name}* — closes ${row.columns["Close Date"]}${
        stage !== "—" ? ` (${stage})` : ""
      }`;
    });
    const more =
      closing.length > shown.length
        ? `\n…and ${closing.length - shown.length} more.`
        : "";
    return (
      `*${closing.length} deal${closing.length === 1 ? "" : "s"} with a Close Date ${weekLabel}:*\n` +
      lines.join("\n") +
      more +
      `\n${source}`
    );
  }

  // ─── Counts: total + by Stage/Status ───────────────────────────
  const counts = new Map<string, number>();
  for (const row of items) {
    const stage = stageOf(row, plan.board);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // Optional stage/status filter: if the question names an actual
  // column value ("how many deals are in negotiation?"), answer that
  // slice specifically. Board nouns themselves never count as filters
  // (a status literally named "Lead" must not match "how many leads").
  const boardNouns = new Set([
    "deal",
    "deals",
    "lead",
    "leads",
    "contact",
    "contacts",
  ]);
  const matched = sorted.filter(([stage]) => {
    const s = stage.toLowerCase();
    if (s === "—" || s.length < 3 || boardNouns.has(s)) return false;
    return new RegExp(`\\b${escapeRegExp(s)}\\b`, "i").test(plan.text);
  });
  if (matched.length > 0) {
    const bits = matched
      .map(([stage, n]) => `*${n}* at *${stage}*`)
      .join(", ");
    return `${boardName}: ${bits} (of ${items.length} total).\n${source}`;
  }

  const label = STAGE_LABEL[plan.board];
  const breakdown = sorted.map(([stage, n]) => `• ${stage}: ${n}`).join("\n");
  return (
    `*${items.length} item${items.length === 1 ? "" : "s"}* on ${boardName}.\n` +
    `By ${label}:\n${breakdown}\n${source}`
  );
}
