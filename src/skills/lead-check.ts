/**
 * lead-check skill — "Has [name] gotten back to us?"
 *
 * Pulls from Monday Leads board only (MS Graph deferred for v1).
 * Returns: lead status, last activity date, follow-up status.
 */

import {
  fuzzyFindItems,
  getItemWithColumns,
  resolveCandidates,
  formatCandidateList,
  BOARDS,
} from "../../lib/monday.js";

/**
 * Honesty disclaimer (CODEX finding 19): the skill spec promises an
 * Outlook/MS Graph check, but no binding decision in decisions/ grants
 * Marco inbox access yet. Until that decision exists, every lead-check
 * answer must disclose that it only saw Monday — "has X gotten back to
 * us?" cannot be answered authoritatively from board data alone.
 * Remove this (and wire the inbox) only when a written decision lands.
 */
const EMAIL_DISCLAIMER = "— from Monday only; I did not check email.";

export async function leadCheck(query: string): Promise<string> {
  if (!query.trim()) {
    return "Which lead? Give me a name.";
  }
  const answer = await leadCheckFromMonday(query);
  return `${answer}\n${EMAIL_DISCLAIMER}`;
}

async function leadCheckFromMonday(query: string): Promise<string> {
  // Tie-breaking centralized in resolveCandidates (finding 5).
  const resolution = resolveCandidates(
    await fuzzyFindItems(query, { limit: 3, boards: [BOARDS.LEADS] }),
  );

  if (resolution.kind === "none") {
    // Fall back to contacts. Limit 3 so a contact-side tie is visible.
    const contactResolution = resolveCandidates(
      await fuzzyFindItems(query, { limit: 3, boards: [BOARDS.CONTACTS] }),
    );
    if (contactResolution.kind === "ambiguous") {
      return (
        `*${query}* isn't in Leads, but several contacts match:\n` +
        `${formatCandidateList(contactResolution.candidates)}\nWhich one?`
      );
    }
    if (contactResolution.kind === "match") {
      return (
        `*${query}* isn't in Leads — but I found *${contactResolution.top.name}* in Contacts. ` +
        `They may have already been converted. Want me to check their deal status instead?`
      );
    }
    return `I couldn't find *${query}* in Leads or Contacts. Try the full name.`;
  }

  if (resolution.kind === "ambiguous") {
    return (
      `Multiple leads match *${query}*:\n` +
      `${formatCandidateList(resolution.candidates)}\nWhich one?`
    );
  }

  const item = await getItemWithColumns(resolution.top.id, { includeUpdates: true });
  if (!item) return `Found *${resolution.top.name}* but couldn't load details.`;

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
