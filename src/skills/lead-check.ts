/**
 * lead-check skill — "Has [name] gotten back to us?"
 *
 * Pulls from Monday Leads board only (MS Graph deferred for v1).
 * Returns: lead status, last activity date, follow-up status.
 */

import {
  fuzzyFindItems,
  getItemWithColumns,
  BOARDS,
} from "../../lib/monday.js";

export async function leadCheck(query: string): Promise<string> {
  if (!query.trim()) {
    return "Which lead? Give me a name.";
  }

  const candidates = await fuzzyFindItems(query, {
    limit: 3,
    boards: [BOARDS.LEADS],
  });

  if (candidates.length === 0) {
    // Fall back to contacts
    const contactCandidates = await fuzzyFindItems(query, {
      limit: 1,
      boards: [BOARDS.CONTACTS],
    });
    if (contactCandidates.length > 0 && contactCandidates[0].score > 0.3) {
      return (
        `*${query}* isn't in Leads — but I found *${contactCandidates[0].name}* in Contacts. ` +
        `They may have already been converted. Want me to check their deal status instead?`
      );
    }
    return `I couldn't find *${query}* in Leads or Contacts. Try the full name.`;
  }

  const top = candidates[0];
  if (candidates.length > 1 && top.score - candidates[1].score < 0.15 && top.score < 0.8) {
    const list = candidates
      .map((c) => `• *${c.name}*`)
      .join("\n");
    return `Multiple leads match *${query}*:\n${list}\nWhich one?`;
  }

  const item = await getItemWithColumns(top.id, { includeUpdates: true });
  if (!item) return `Found *${top.name}* but couldn't load details.`;

  const status = item.columns["Status"] ?? "unknown";
  const fullName = item.columns["Full Name"] ?? item.name;
  const company = item.columns["Company"] ?? "";
  const lastActivity = item.columns["Last Activity Date"] ?? "no activity";
  const followUp = item.columns["Lead Follow Up"] ?? "none";
  const firstContacted = item.columns["First Contacted Date"] ?? "";
  const assignedTo = item.columns["Assigned To"] ?? "unassigned";

  let line1 = `*${fullName}*`;
  if (company) line1 += ` (${company})`;
  line1 += ` — status *${status}*, assigned to ${assignedTo}.`;

  let line2 = `Last activity: *${lastActivity}*`;
  if (firstContacted) line2 += ` (first contacted ${firstContacted})`;
  line2 += `.`;

  let line3 = "";
  if (followUp && followUp !== "none") {
    line3 = `Follow-up status: *${followUp}*.`;
  }

  // Check if overdue
  if (lastActivity && lastActivity !== "no activity") {
    const lastDate = new Date(lastActivity);
    const daysSince = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince > 7) {
      line3 += ` *${daysSince} days since last activity — follow-up may be overdue.*`;
    }
  }

  if (item.updates.length > 0) {
    const latest = item.updates[0];
    const preview = latest.text.slice(0, 120);
    line3 += `\nLatest note: "${preview}${latest.text.length > 120 ? "…" : ""}"`;
  }

  const source = `_Source: Monday Leads • <${item.url}|View>_`;
  return [line1, line2, line3.trim(), source].filter(Boolean).join("\n");
}
