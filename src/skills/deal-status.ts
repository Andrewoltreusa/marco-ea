/**
 * deal-status skill — "What's the status of [client]?"
 *
 * Pulls from Monday Deals + OCD Schedule (Manufacturing Schedule).
 * Invoice status from Deals board columns (not FreshBooks — per Andrew's
 * 2026-04-15 decision, Deals board is the source of truth).
 *
 * Returns a 3-sentence summary + source citation.
 */

import {
  fuzzyFindItems,
  getItemWithColumns,
  BOARDS,
  type ItemWithColumns,
} from "../../lib/monday.js";

export async function dealStatus(
  query: string,
  tier: 1 | 2,
): Promise<string> {
  if (!query.trim()) {
    return "Which deal or client? Give me a name and I'll look it up.";
  }

  // Search Deals first, then Contacts as fallback
  const dealCandidates = await fuzzyFindItems(query, {
    limit: 3,
    boards: [BOARDS.DEALS],
  });

  if (dealCandidates.length === 0) {
    // Try contacts as a fallback — sometimes people ask about a person not a deal
    const contactCandidates = await fuzzyFindItems(query, {
      limit: 1,
      boards: [BOARDS.CONTACTS],
    });
    if (contactCandidates.length > 0 && contactCandidates[0].score > 0.3) {
      const contact = await getItemWithColumns(contactCandidates[0].id);
      if (contact) {
        const dealStatus = contact.columns["Deal Status"] ?? "unknown";
        const account = contact.columns["Account"] ?? "";
        return (
          `*${contact.name}* is in Contacts${account ? ` (${account})` : ""}` +
          `, deal status *${dealStatus}*.` +
          ` I don't see a matching deal in the Deals board — they may not have one yet.\n` +
          `_Source: Monday Contacts • <${contact.url}|View>_`
        );
      }
    }
    return `I couldn't find *${query}* in Deals or Contacts. Try the full company or deal name.`;
  }

  const top = dealCandidates[0];
  if (dealCandidates.length > 1 && top.score - dealCandidates[1].score < 0.15 && top.score < 0.8) {
    const list = dealCandidates
      .map((c) => `• *${c.name}* (${c.boardName})`)
      .join("\n");
    return `I found multiple matches for *${query}*:\n${list}\nWhich one?`;
  }

  const deal = await getItemWithColumns(top.id, { includeUpdates: true });
  if (!deal) return `Found *${top.name}* but couldn't load the details. Try again.`;

  // Build the 3-sentence summary
  const stage = deal.columns["Stage"] ?? "unknown";
  const value = deal.columns["Deal Value"] ?? "—";
  const owner = deal.columns["Owner"] ?? "unassigned";
  const closeDate = deal.columns["Close Date"] ?? "no close date";
  const followUp = deal.columns["Follow Up"] ?? "";
  const product = deal.columns["Product"] ?? "";

  let sentence1 = `*${deal.name}* is at stage *${stage}*`;
  if (value && value !== "—") sentence1 += `, value $${value}`;
  sentence1 += `, ${owner} owns it`;
  if (closeDate !== "no close date") sentence1 += `, close date ${closeDate}`;
  sentence1 += ".";

  // Production status from OCD Schedule
  let sentence2 = "";
  const ocdCandidates = await fuzzyFindItems(query, {
    limit: 1,
    boards: [BOARDS.OCD_SCHEDULE],
  });
  if (ocdCandidates.length > 0 && ocdCandidates[0].score > 0.3) {
    const ocd = await getItemWithColumns(ocdCandidates[0].id);
    if (ocd) {
      const prodStatus = ocd.columns["Status"] ?? "unknown";
      const shipDate = ocd.columns["Ship. Date"] ?? "no date";
      const manDate = ocd.columns["Man. Date"] ?? "";
      sentence2 = `Production: *${prodStatus}*`;
      if (manDate) sentence2 += `, manufacturing ${manDate}`;
      if (shipDate !== "no date") sentence2 += `, ship ${shipDate}`;
      sentence2 += ".";
    }
  }
  if (!sentence2) {
    sentence2 = "Not on the production schedule yet.";
  }

  // Follow-up / context line
  let sentence3 = "";
  if (followUp) sentence3 += `Follow-up: *${followUp}*. `;
  if (product) sentence3 += `Product: ${product}. `;
  if (deal.updates.length > 0) {
    const latest = deal.updates[0];
    const preview = latest.text.slice(0, 120);
    sentence3 += `Latest update: "${preview}${latest.text.length > 120 ? "…" : ""}"`;
  }
  if (!sentence3) sentence3 = "No recent updates.";

  const source = `_Source: Monday Deals + OCD Schedule • <${deal.url}|View deal>_`;
  return [sentence1, sentence2, sentence3.trim(), source].filter(Boolean).join("\n");
}
