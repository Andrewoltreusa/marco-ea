/**
 * Output validation for the morning brief (CODEX finding 8).
 *
 * The composer is told to use the FACTS numbers verbatim, but a prompt
 * instruction is not a guarantee — a transposed digit in a dollar amount
 * ships wrong money numbers to the whole team. So the gate is code:
 * every dollar amount and standalone count in the composed brief must
 * literally appear in the facts block. Any unknown number fails the
 * brief and the caller falls back to the raw-facts version, which is
 * built from code-computed numbers only.
 *
 * Extracted from marco-team-morning-brief.ts so it is testable without
 * importing the Trigger.dev task graph.
 */

/**
 * Substrings that read as dates/times, not quantities. Removed before
 * number extraction so "2026-07-30", "07-30", "7:30" and bare years
 * never fail the membership check.
 */
const DATE_LIKE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b/g;

/**
 * Canonical form of a numeric token: "$181,586.50" / "181586.5" /
 * "181,586.50" all normalize to "181586.5", so formatting differences
 * between the facts block and the composed prose never count as a
 * mismatch — only a different VALUE does.
 */
export function normalizeNumberToken(token: string): string {
  const cleaned = token.replace(/[$,\s]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? String(n) : cleaned;
}

/**
 * All numeric tokens in a text — dollar amounts and standalone counts —
 * normalized, with date-like tokens excluded.
 */
export function extractNumberTokens(text: string): Set<string> {
  const out = new Set<string>();
  const scrubbed = text.replace(DATE_LIKE, " ");
  for (const m of scrubbed.matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)) {
    out.add(normalizeNumberToken(m[0]));
  }
  return out;
}

/**
 * Sanity-gate the composed brief before it leaves the building:
 *   1. Format rules — header line, some digits, length cap, no
 *      exclamation marks, no emoji (brand voice).
 *   2. Numeric grounding — every number in the brief is a member of the
 *      set of numbers in the facts block (dates excluded).
 * On failure the caller falls back to the raw-facts brief.
 */
export function isValidBrief(brief: string, facts: string[]): boolean {
  const formatOk =
    brief.includes("Oltre —") &&
    /\d/.test(brief) &&
    brief.length < 3000 &&
    !brief.includes("!") &&
    !/[\u{1F300}-\u{1FAFF}]/u.test(brief);
  if (!formatOk) return false;

  const approved = extractNumberTokens(facts.join("\n"));
  for (const token of extractNumberTokens(brief)) {
    if (!approved.has(token)) return false;
  }
  return true;
}
