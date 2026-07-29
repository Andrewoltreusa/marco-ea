/**
 * Small date helpers shared by Marco's scheduled tasks.
 *
 * Business-day math is used by:
 *   - marco-production-alert: ship-slip detection (slip > 3 business days)
 *   - marco-team-morning-brief: "shipping soon" window (5 business days)
 *
 * All calculations are calendar-day based (time of day is ignored) and use
 * the UTC date of the given Date objects. Callers that care about Pacific
 * day boundaries should construct their Dates so the UTC date matches the
 * Pacific date (e.g. parse "YYYY-MM-DD" ship dates at noon).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Monday–Friday. Saturday/Sunday are not business days. */
export function isBusinessDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * Signed count of business days (Mon–Fri) between two dates, ignoring time
 * of day. Counts calendar days strictly after `from` up to and including
 * `to`. Same calendar day → 0. `to` before `from` → negative.
 *
 * Examples: Mon → Fri (same week) = 4; Fri → Mon = 1; Sat → Sun = 0.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  if (b < a) return -businessDaysBetween(to, from);
  let count = 0;
  for (let t = a + DAY_MS; t <= b; t += DAY_MS) {
    if (isBusinessDay(new Date(t))) count++;
  }
  return count;
}

/**
 * Parse a "YYYY-MM-DD" date string (as Monday returns for date columns)
 * into a Date pinned to noon UTC, so business-day math on it is stable
 * regardless of the server timezone. Returns null if not parseable.
 */
export function parseIsoDateNoonUtc(s: string): Date | null {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[0]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
