/**
 * AR 2026 aggregate math, shared by general-query and the scheduled
 * broadcasts. Rule of the house: pre-compute every sum in code and hand
 * Claude the results as authoritative facts — never let the model do
 * arithmetic over board rows (decisions/log.md, STATUS "Known quirks").
 */

import type { BoardItemRow } from "./monday.js";

export interface ArAggregates {
  totalItems: number;
  /** Sum of Contract $ across the whole board. */
  totalContract: number;
  /** Sum of Payment #1 + Payment #2 (cash in, across all items). */
  totalPaid: number;
  /** Contract - Paid. */
  totalRemaining: number;
  /** Per-status breakdown. */
  byStatus: Array<{
    status: string;
    count: number;
    contract: number;
    paid: number;
    remaining: number;
  }>;
  /** Per-month breakdown, keyed by YYYY-MM, sorted chronologically. */
  byMonth: Array<{
    month: string; // YYYY-MM
    label: string; // e.g. "April 2026"
    count: number;
    contract: number;
    paid: number;
    remaining: number;
  }>;
}

/**
 * Number parsing handles Monday's text-column formats:
 *   "1500" / "1500.00" / "$1,500.00" / "" / undefined
 */
export function parseUsd(v: string | undefined): number {
  if (!v) return 0;
  const cleaned = v.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Pull a YYYY-MM out of the first available date column on an AR item. */
function extractMonth(row: BoardItemRow): string | null {
  // Priority order: specific date column IDs on AR 2026, then any Date title.
  const candidates = [
    row.columns["#dup__of_ship__date"],
    row.columns["#date81"],
    row.columns["Date"],
    row.columns["#dup__of_due_date"],
    row.columns["#dup__of_man__date"],
  ];
  for (const v of candidates) {
    if (!v) continue;
    // Monday date columns return "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS".
    const m = v.match(/(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const idx = parseInt(m, 10) - 1;
  return `${MONTH_NAMES[idx] ?? m} ${y}`;
}

/** Pre-compute sums from the AR 2026 board dump. */
export function computeArAggregates(items: BoardItemRow[]): ArAggregates {
  const byStatusMap = new Map<
    string,
    { count: number; contract: number; paid: number; remaining: number }
  >();
  const byMonthMap = new Map<
    string,
    { count: number; contract: number; paid: number; remaining: number }
  >();

  let totalContract = 0;
  let totalPaid = 0;

  for (const item of items) {
    const contract = parseUsd(item.columns["Contract $"]);
    const pay1 = parseUsd(item.columns["Payment #1"]);
    const pay2 = parseUsd(item.columns["Payment #2"]);
    const paid = pay1 + pay2;
    const remaining = contract - paid;
    const status = item.columns["Status"] || "—";
    const month = extractMonth(item); // YYYY-MM or null

    totalContract += contract;
    totalPaid += paid;

    const sBucket = byStatusMap.get(status) ?? {
      count: 0,
      contract: 0,
      paid: 0,
      remaining: 0,
    };
    sBucket.count += 1;
    sBucket.contract += contract;
    sBucket.paid += paid;
    sBucket.remaining += remaining;
    byStatusMap.set(status, sBucket);

    if (month) {
      const mBucket = byMonthMap.get(month) ?? {
        count: 0,
        contract: 0,
        paid: 0,
        remaining: 0,
      };
      mBucket.count += 1;
      mBucket.contract += contract;
      mBucket.paid += paid;
      mBucket.remaining += remaining;
      byMonthMap.set(month, mBucket);
    }
  }
  const totalRemaining = totalContract - totalPaid;

  const byStatus = Array.from(byStatusMap.entries())
    .map(([status, v]) => ({ status, ...v }))
    .sort((a, b) => b.contract - a.contract);

  const byMonth = Array.from(byMonthMap.entries())
    .map(([month, v]) => ({ month, label: monthLabel(month), ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    totalItems: items.length,
    totalContract,
    totalPaid,
    totalRemaining,
    byStatus,
    byMonth,
  };
}

/** Top-N AR items by remaining balance — for the morning brief's "AR top 3". */
export function topOutstanding(
  items: BoardItemRow[],
  n: number,
): Array<{ name: string; remaining: number }> {
  return items
    .map((r) => ({
      name: r.name,
      remaining:
        parseUsd(r.columns["Contract $"]) -
        parseUsd(r.columns["Payment #1"]) -
        parseUsd(r.columns["Payment #2"]),
    }))
    .filter((r) => r.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, n);
}
