/**
 * AR 2026 aggregate math, shared by general-query and the scheduled
 * broadcasts. Rule of the house: pre-compute every sum in code and hand
 * Claude the results as authoritative facts — never let the model do
 * arithmetic over board rows (decisions/log.md, STATUS "Known quirks").
 */

import type { BoardItemRow } from "./monday.js";

/**
 * Canonical AR 2026 column titles. Every read of an AR board column in
 * this file MUST go through this map — if the board is ever renamed,
 * this is the single place to update.
 */
export const AR_COLUMNS = {
  contract: "Contract $",
  payment1: "Payment #1",
  payment2: "Payment #2",
  status: "Status",
} as const;

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
  /**
   * Per-month breakdown, keyed by YYYY-MM, sorted chronologically —
   * bucketed by the item's ship/It date column — NOT the contract
   * signing month. extractShipMonth() prefers `#dup__of_ship__date` (a SHIP
   * date), so "April 2026" here means "ships in April", not "signed in
   * April". Consumers must label it honestly.
   */
  byShipMonth: Array<{
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

/**
 * Pull a YYYY-MM out of the first available date column on an AR item.
 * NOTE: the first candidate is `#dup__of_ship__date` — a SHIP date — so
 * the month this returns is the item's ship month, not the month the
 * contract was signed. See ArAggregates.byShipMonth.
 */
function extractShipMonth(row: BoardItemRow): string | null {
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
    const contract = parseUsd(item.columns[AR_COLUMNS.contract]);
    const pay1 = parseUsd(item.columns[AR_COLUMNS.payment1]);
    const pay2 = parseUsd(item.columns[AR_COLUMNS.payment2]);
    const paid = pay1 + pay2;
    const remaining = contract - paid;
    const status = item.columns[AR_COLUMNS.status] || "—";
    const month = extractShipMonth(item); // YYYY-MM or null

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

  const byShipMonth = Array.from(byMonthMap.entries())
    .map(([month, v]) => ({ month, label: monthLabel(month), ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    totalItems: items.length,
    totalContract,
    totalPaid,
    totalRemaining,
    byStatus,
    byShipMonth,
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
        parseUsd(r.columns[AR_COLUMNS.contract]) -
        parseUsd(r.columns[AR_COLUMNS.payment1]) -
        parseUsd(r.columns[AR_COLUMNS.payment2]),
    }))
    .filter((r) => r.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, n);
}
