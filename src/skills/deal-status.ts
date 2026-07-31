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
  getLinkedItems,
  resolveCandidates,
  formatCandidateList,
  BOARDS,
  type ItemWithColumns,
} from "../../lib/monday.js";
import { parseUsd, fmtUsd, AR_COLUMNS } from "../../lib/ar.js";

export async function dealStatus(
  query: string,
  tier: 1 | 2,
): Promise<string> {
  if (!query.trim()) {
    return "Which deal or client? Give me a name and I'll look it up.";
  }

  // Search Deals first, then Contacts as fallback. Tie-breaking is
  // centralized in resolveCandidates (finding 5) — exact-score
  // duplicates and lone weak matches never auto-select.
  const dealResolution = resolveCandidates(
    await fuzzyFindItems(query, { limit: 3, boards: [BOARDS.DEALS] }),
  );

  if (dealResolution.kind === "ambiguous") {
    return (
      `I found multiple matches for *${query}*:\n` +
      `${formatCandidateList(dealResolution.candidates)}\nWhich one?`
    );
  }

  if (dealResolution.kind === "none") {
    // Try contacts as a fallback — sometimes people ask about a person
    // not a deal. Limit 3 so a contact-side tie is visible too.
    const contactResolution = resolveCandidates(
      await fuzzyFindItems(query, { limit: 3, boards: [BOARDS.CONTACTS] }),
    );
    if (contactResolution.kind === "ambiguous") {
      return (
        `I found multiple contacts matching *${query}*:\n` +
        `${formatCandidateList(contactResolution.candidates)}\nWhich one?`
      );
    }
    if (contactResolution.kind === "match") {
      const contact = await getItemWithColumns(contactResolution.top.id);
      if (contact) {
        // Deals are named by code (C26100), so a person's name never
        // fuzzy-matches them — follow the contact's board-relation links
        // instead. This is how "Kevin Stone" resolves to his 3 deals.
        const linkedDeals = (await getLinkedItems(contact.id).catch(() => []))
          .filter((l) => l.boardId === BOARDS.DEALS)
          .slice(0, 5);

        if (linkedDeals.length > 0) {
          const hydrated = await Promise.all(
            linkedDeals.map((l) =>
              getItemWithColumns(l.id).catch(() => null),
            ),
          );
          const lines = hydrated
            .filter((d): d is ItemWithColumns => d !== null)
            .map((d) => {
              const stage = d.columns["Stage"] ?? "unknown";
              const value = d.columns["Deal Value"] ?? "";
              const close = d.columns["Close Date"] ?? "";
              return (
                `• *${d.name}* — stage *${stage}*` +
                (value && tier === 1 ? `, $${value}` : "") +
                (close ? `, close ${close}` : "") +
                ` — <${d.url}|View>`
              );
            });
          return (
            `*${contact.name}* (Contacts) has ${lines.length} linked deal${lines.length === 1 ? "" : "s"}:\n` +
            lines.join("\n") +
            `\n_Source: Monday Contacts → Deals relation • <${contact.url}|Contact>_`
          );
        }

        const dealStatus = contact.columns["Deal Status"] ?? "unknown";
        const account = contact.columns["Account"] ?? "";
        return (
          `*${contact.name}* is in Contacts${account ? ` (${account})` : ""}` +
          `, deal status *${dealStatus}*.` +
          ` I don't see any deal linked to them — they may not have one yet.\n` +
          `_Source: Monday Contacts • <${contact.url}|View>_`
        );
      }
    }
    return `I couldn't find *${query}* in Deals or Contacts. Try the full company or deal name.`;
  }

  const top = dealResolution.top;
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

  // Production status from OCD Schedule — enrichment only. An ambiguous
  // schedule match must not guess a row, and must not claim "not on the
  // schedule" either.
  let sentence2 = "";
  const ocdResolution = resolveCandidates(
    await fuzzyFindItems(query, { limit: 3, boards: [BOARDS.OCD_SCHEDULE] }),
  );
  if (ocdResolution.kind === "match") {
    const ocd = await getItemWithColumns(ocdResolution.top.id);
    if (ocd) {
      const prodStatus = ocd.columns["Status"] ?? "unknown";
      const shipDate = ocd.columns["Ship. Date"] ?? "no date";
      const manDate = ocd.columns["Man. Date"] ?? "";
      sentence2 = `Production: *${prodStatus}*`;
      if (manDate) sentence2 += `, manufacturing ${manDate}`;
      if (shipDate !== "no date") sentence2 += `, ship ${shipDate}`;
      sentence2 += ".";
    }
  } else if (ocdResolution.kind === "ambiguous") {
    sentence2 =
      "Production: multiple schedule rows match this name — check the OCD Schedule board directly.";
  }
  if (!sentence2) {
    sentence2 = "Not on the production schedule yet.";
  }

  // Payment status from the linked AR 2026 item (CODEX finding 19: the
  // skill spec promises payment status; AR 2026 is the sole financial
  // source of truth since FreshBooks was removed 2026-04-17).
  // Tier 1 only — Tier 2 users don't get account-level payment amounts
  // (slack-allowlist scoping rule). Any failure silently skips the line.
  let paymentLine = "";
  if (tier === 1) {
    try {
      const arLink = (await getLinkedItems(deal.id)).find(
        (l) => l.boardId === BOARDS.AR_2026,
      );
      if (arLink) {
        const ar = await getItemWithColumns(arLink.id);
        if (ar) {
          const contract = parseUsd(ar.columns[AR_COLUMNS.contract]);
          const paid =
            parseUsd(ar.columns[AR_COLUMNS.payment1]) +
            parseUsd(ar.columns[AR_COLUMNS.payment2]);
          if (contract > 0 || paid > 0) {
            paymentLine = `Payments: ${fmtUsd(paid)} of ${fmtUsd(contract)} received.`;
          }
        }
      }
    } catch {
      // AR lookup is best-effort — never block the status answer.
    }
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

  const source = `_Source: Monday Deals + OCD Schedule${paymentLine ? " + AR 2026" : ""} • <${deal.url}|View deal>_`;
  return [sentence1, sentence2, paymentLine, sentence3.trim(), source]
    .filter(Boolean)
    .join("\n");
}
