/**
 * Tier-2 redaction — code-level, not prompt-level.
 *
 * The slack-allowlist scoping rule says Tier 2 users never see
 * Tier-1-only fields. For AR financials the sanctioned Tier-2 view is
 * the company aggregates plus topOutstanding(5) (cash-position spec) —
 * account-level financial data must never enter a Tier-2 prompt at all.
 * A prompt instruction ("don't include financial details...") stays as
 * defense in depth, but the data itself is removed here BEFORE prompt
 * assembly (CODEX second-audit finding 2: a prompt note alone is not a
 * redaction boundary).
 */

import { AR_COLUMNS } from "./ar.js";
import { BOARDS } from "./monday.js";

/**
 * Column titles Tier 2 must never see on any matched row's column dump.
 * Sourced from AR_COLUMNS so a board rename stays a one-place update;
 * "Remaining Balance" is a computed board column that AR_COLUMNS doesn't
 * carry, so it is listed literally.
 *
 * Matching is by column TITLE. The "#<columnId>" duplicate keys that
 * getBoardItems stores are already filtered out of every prompt dump
 * (they never reach the model), and AR 2026 rows are dropped wholesale
 * below, so title matching is the complete surface.
 */
const TIER2_BLOCKED_COLUMN_TITLES: ReadonlySet<string> = new Set(
  [
    AR_COLUMNS.contract,
    AR_COLUMNS.payment1,
    AR_COLUMNS.payment2,
    "Remaining Balance",
  ].map((t) => t.toLowerCase()),
);

/** True when a column title is financial data Tier 2 may not see. */
export function isTier2BlockedColumn(title: string): boolean {
  return TIER2_BLOCKED_COLUMN_TITLES.has(title.trim().toLowerCase());
}

/** Copy of `columns` with every Tier-2-blocked financial column removed. */
export function stripFinancialColumns(
  columns: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(columns)) {
    if (!isTier2BlockedColumn(k)) out[k] = v;
  }
  return out;
}

/**
 * Tier-2 filter for entity-search matches, applied before prompt
 * assembly:
 *   - AR 2026 rows are dropped entirely (the Tier-2 AR view is the
 *     aggregates + top-5 outstanding blocks, never row-level matches);
 *   - every other row keeps its columns minus the financial ones.
 *
 * Tier 1 callers must not route through this.
 */
export function redactMatchesForTier2<
  T extends { item: { boardId: string; columns: Record<string, string> } },
>(matches: T[]): T[] {
  return matches
    .filter((m) => m.item.boardId !== BOARDS.AR_2026)
    .map(
      (m) =>
        ({
          ...m,
          item: { ...m.item, columns: stripFinancialColumns(m.item.columns) },
        }) as T,
    );
}
