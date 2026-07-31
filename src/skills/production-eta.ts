/**
 * production-eta skill — "When does [client] ship?"
 *
 * Pulls from Monday OCD Schedule (Manufacturing Schedule) board.
 * Returns 2 sentences: current stage + target ship date.
 */

import {
  fuzzyFindItems,
  getItemWithColumns,
  resolveCandidates,
  formatCandidateList,
  BOARDS,
} from "../../lib/monday.js";

export async function productionEta(query: string): Promise<string> {
  if (!query.trim()) {
    return "Which project? Give me a client or deal name.";
  }

  // Tie-breaking centralized in resolveCandidates (finding 5).
  const resolution = resolveCandidates(
    await fuzzyFindItems(query, { limit: 3, boards: [BOARDS.OCD_SCHEDULE] }),
  );

  if (resolution.kind === "none") {
    // Fall back to deals — maybe it's a deal that hasn't entered
    // production yet. Limit 3 so a deal-side tie is visible too.
    const dealResolution = resolveCandidates(
      await fuzzyFindItems(query, { limit: 3, boards: [BOARDS.DEALS] }),
    );
    if (dealResolution.kind === "ambiguous") {
      return (
        `Nothing on the production schedule matches *${query}*, but several deals do:\n` +
        `${formatCandidateList(dealResolution.candidates)}\nWhich one?`
      );
    }
    if (dealResolution.kind === "match") {
      return (
        `*${dealResolution.top.name}* isn't on the production schedule yet. ` +
        `It's still in Deals at the ${dealResolution.top.boardName} level.`
      );
    }
    return `I couldn't find *${query}* on the production schedule or in Deals.`;
  }

  if (resolution.kind === "ambiguous") {
    return (
      `Multiple matches on the production schedule:\n` +
      `${formatCandidateList(resolution.candidates)}\nWhich one?`
    );
  }

  const top = resolution.top;
  const item = await getItemWithColumns(top.id);
  if (!item) return `Found *${top.name}* but couldn't load the details.`;

  const status = item.columns["Status"] ?? "unknown";
  const shipDate = item.columns["Ship. Date"] ?? "no date set";
  const manDate = item.columns["Man. Date"] ?? "";
  const deadline = item.columns["Deadline"] ?? "";
  const service = item.columns["Service"] ?? "";
  const notes = item.columns["Notes"] ?? "";

  let line1 = `*${item.name}* is at *${status}* on the production schedule.`;

  let line2 = "";
  if (shipDate !== "no date set") {
    line2 = `Target ship: *${shipDate}*`;
  } else if (deadline) {
    line2 = `Deadline: *${deadline}*`;
  } else {
    line2 = "No ship date or deadline set";
  }
  if (manDate) line2 += `, manufacturing date ${manDate}`;
  if (service) line2 += ` (${service})`;
  line2 += ".";

  const flagged =
    status.toLowerCase().includes("red") ||
    status.toLowerCase().includes("block") ||
    status.toLowerCase().includes("delay");
  if (flagged) {
    line2 += " *This item is flagged — don't commit this date to the client until Alex T. confirms.*";
  }

  if (notes) {
    line2 += `\nNotes: ${notes.slice(0, 200)}${notes.length > 200 ? "…" : ""}`;
  }

  const source = `_Source: OCD Schedule • <${item.url}|View>_`;
  return [line1, line2, source].join("\n");
}
