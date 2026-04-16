/**
 * general-query skill — the intelligent fallback.
 *
 * When the keyword classifier doesn't match a specific skill, this
 * skill takes over. It uses Claude to understand what the user is
 * asking, searches Monday across all boards, and composes a natural
 * response.
 *
 * Examples that land here:
 *   "Have we ever worked with Bob Jones?"
 *   "Who's the contact for the Napa project?"
 *   "What deals are closing this week?"
 *   "How many leads do we have?"
 *   "Remind me who Alex T. is meeting tomorrow"
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  fuzzyFindItems,
  getItemWithColumns,
  BOARDS,
  BOARD_NAMES,
  type ItemWithColumns,
} from "../../lib/monday.js";

const ALL_SEARCH_BOARDS = [
  BOARDS.DEALS,
  BOARDS.LEADS,
  BOARDS.CONTACTS,
  BOARDS.OCD_SCHEDULE,
];

export async function generalQuery(
  question: string,
  tier: 1 | 2,
): Promise<string> {
  if (!question.trim()) {
    return "What would you like to know? Try asking about a deal, client, lead, or production item.";
  }

  // Step 1: Extract search terms from the question using Claude
  const searchTerms = await extractSearchTerms(question);

  // Step 2: Search Monday for each term
  const allResults: Array<{ item: ItemWithColumns; query: string }> = [];
  for (const term of searchTerms) {
    const candidates = await fuzzyFindItems(term, {
      limit: 3,
      boards: ALL_SEARCH_BOARDS,
    });
    for (const c of candidates) {
      if (c.score >= 0.3) {
        const full = await getItemWithColumns(c.id, { includeUpdates: true });
        if (full) allResults.push({ item: full, query: term });
      }
    }
  }

  // Deduplicate by item ID
  const seen = new Set<string>();
  const unique = allResults.filter((r) => {
    if (seen.has(r.item.id)) return false;
    seen.add(r.item.id);
    return true;
  });

  // Step 3: Have Claude compose the answer
  return composeAnswer(question, unique, tier);
}

async function extractSearchTerms(question: string): Promise<string[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: `You extract search terms from a user's question about Oltre Castings & Design's business.
Return a JSON array of 1-3 search terms (names of people, companies, projects, or deals) to look up in Monday.com boards.
If the question is general (not about a specific entity), return an empty array [].
Return ONLY the JSON array, no prose, no code fences.

Examples:
"Have we ever worked with Bob Jones?" → ["Bob Jones"]
"What's happening with the Rivertop and Schellenberg deals?" → ["Rivertop", "Schellenberg"]
"How many deals are closing this week?" → []
"Who's the contact for the Napa project?" → ["Napa"]`,
    messages: [{ role: "user", content: question }],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];

  const raw = textBlock.text.trim();
  try {
    const firstBracket = raw.indexOf("[");
    const lastBracket = raw.lastIndexOf("]");
    if (firstBracket === -1 || lastBracket === -1) return [];
    const arr = JSON.parse(raw.slice(firstBracket, lastBracket + 1));
    if (Array.isArray(arr)) return arr.filter((s): s is string => typeof s === "string");
  } catch {
    // fall through
  }
  return [];
}

async function composeAnswer(
  question: string,
  results: Array<{ item: ItemWithColumns; query: string }>,
  tier: 1 | 2,
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build context from Monday results
  let mondayContext = "";
  if (results.length === 0) {
    mondayContext = "No matching items found in Monday.com (Deals, Leads, Contacts, or Production Schedule boards).";
  } else {
    mondayContext = results
      .map((r) => {
        const cols = Object.entries(r.item.columns)
          .filter(([, v]) => v && v.trim())
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        const updates = r.item.updates
          .slice(0, 2)
          .map((u) => `  - ${u.text.slice(0, 150)}`)
          .join("\n");
        return (
          `Item: ${r.item.name} (${r.item.boardName})\n` +
          `URL: ${r.item.url}\n` +
          (cols ? `Columns:\n${cols}\n` : "") +
          (updates ? `Recent updates:\n${updates}\n` : "")
        );
      })
      .join("\n---\n");
  }

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: `You are Marco, Oltre Castings & Design's company secretary. You answer questions about the business using Monday.com data provided below.

Rules:
- Be concise: 2-4 sentences maximum.
- Be specific: use actual names, dates, amounts, statuses from the data.
- If you found matching items, reference them by name and board.
- If no items matched, say so honestly: "I don't see [name] in our Monday boards (Deals, Leads, Contacts, or Production). They might be under a different name, or they may not be in the system yet."
- Include a Monday link when referencing a specific item.
- Don't make up data. Only use what's in the context below.
- Don't use exclamation marks or emojis.
- ${tier === 2 ? "This is a Tier 2 user — don't include financial details beyond deal value and status." : "This is Tier 1 (Andrew) — full detail."}

Monday.com search results for this question:
${mondayContext}`,
    messages: [{ role: "user", content: question }],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return "I ran into an issue composing the answer. Try rephrasing your question.";
  }
  return textBlock.text;
}
