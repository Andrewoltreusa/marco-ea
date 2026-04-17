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
  getBoardItems,
  BOARDS,
  BOARD_NAMES,
  type ItemWithColumns,
  type BoardItemRow,
} from "../../lib/monday.js";
import {
  loadConversation,
  appendTurn,
  toClaudeMessages,
  toTranscript,
  type ConversationTurn,
} from "../../lib/conversation.js";

const ALL_SEARCH_BOARDS = [
  BOARDS.DEALS,
  BOARDS.LEADS,
  BOARDS.CONTACTS,
  BOARDS.OCD_SCHEDULE,
  BOARDS.AR_2026,
];

/**
 * Financial-question detector. When true, we inject the full AR 2026
 * board as context so Claude can answer aggregate questions like
 * "What's my contracted amount for April?" — Monday is the source of
 * truth for AR / cash / contracted amounts, NOT FreshBooks.
 */
function isFinancialQuestion(text: string): boolean {
  return /\b(cash|ar\b|accounts? receivable|contract(ed)?|invoiced?|paid|balance|outstanding|revenue|owed?|owes?|payment|amount|receivable|accounts received)\b/i.test(
    text,
  );
}

export async function generalQuery(
  question: string,
  tier: 1 | 2,
  channelId?: string,
): Promise<string> {
  if (!question.trim()) {
    return "What would you like to know? Try asking about a deal, client, lead, or production item.";
  }

  // Load conversation history for follow-up continuity (DMs only have context).
  const history: ConversationTurn[] = channelId
    ? await loadConversation(channelId)
    : [];

  // Step 1: Extract search terms — history helps Claude resolve pronouns.
  const searchTerms = await extractSearchTerms(question, history);

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

  // Step 2.5: If the question is financial, also pull the full AR 2026
  // board so Claude can answer aggregate questions (monthly totals,
  // balances, contracted amounts) that don't map to a single entity.
  let arBoardRows: BoardItemRow[] | null = null;
  if (isFinancialQuestion(question)) {
    try {
      const board = await getBoardItems(BOARDS.AR_2026, { limit: 500 });
      arBoardRows = board.items;
    } catch {
      // non-fatal: general-query still has per-entity results
    }
  }

  // Deduplicate by item ID
  const seen = new Set<string>();
  const unique = allResults.filter((r) => {
    if (seen.has(r.item.id)) return false;
    seen.add(r.item.id);
    return true;
  });

  // Step 3: Have Claude compose the answer, with conversation history.
  const answer = await composeAnswer(question, unique, tier, history, arBoardRows);

  // Step 4: Save the turn so follow-ups have context.
  if (channelId) {
    await appendTurn(channelId, {
      at: new Date().toISOString(),
      user: question,
      assistant: answer,
    });
  }

  return answer;
}

async function extractSearchTerms(
  question: string,
  history: ConversationTurn[],
): Promise<string[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const transcript = toTranscript(history);
  const userBlock =
    history.length > 0
      ? `Prior conversation:\n${transcript}\n\nCurrent question: ${question}`
      : question;

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: `You extract search terms from a user's question about Oltre Castings & Design's business.
Return a JSON array of search terms to look up in Monday.com boards (Deals, Leads, Contacts, Production).

RESOLVE PRONOUNS using the prior conversation. "her", "them", "that", "the project" all refer to entities Marco mentioned in the most recent turn. Substitute the actual names before extracting terms.

CRITICAL: When a query mentions a compound entity (a person + company, or first+last name, or "X from Y"), return MULTIPLE variations:
- The composite phrase
- Each individual name part
- The company alone

This is because Monday items may be indexed under any of those (e.g. contact named just "Lynette Smith", account named just "Renaissance Homes", deal named "Lynette — Renaissance Homes 123 Main St").

If the question is general (not about a specific entity), return an empty array [].
Return ONLY the JSON array, no prose, no code fences. Max 5 terms.

Examples:
"Have we ever worked with Bob Jones?" → ["Bob Jones", "Bob", "Jones"]
"What is the address for the Lynette Renaissance Homes project?" → ["Lynette Renaissance Homes", "Lynette", "Renaissance Homes"]
"What's happening with Schellenberg?" → ["Schellenberg"]
"Who's the contact for the Napa project?" → ["Napa"]
"How many deals are closing this week?" → []
"Who from Acme did we last talk to?" → ["Acme"]

WITH prior context "Marco: I see Lynnette Sandgren at Renaissance Homes...":
"pull up the latest update on her contact" → ["Lynnette Sandgren", "Renaissance Homes"]
"what's her phone number?" → ["Lynnette Sandgren"]`,
    messages: [{ role: "user", content: userBlock }],
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
  history: ConversationTurn[] = [],
  arRows: BoardItemRow[] | null = null,
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build context from Monday per-entity search results
  let mondayContext = "";
  if (results.length === 0) {
    mondayContext = "No matching items found in Monday.com (Deals, Leads, Contacts, Production Schedule, or AR 2026 boards) by entity name.";
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

  // Build AR 2026 board context if this is a financial question
  let arContext = "";
  if (arRows && arRows.length > 0) {
    const rows = arRows
      .map((r) => {
        const cols = Object.entries(r.columns)
          .filter(([, v]) => v && v.trim())
          .map(([k, v]) => `${k}=${v}`)
          .join(" | ");
        return `- ${r.name} | ${cols}`;
      })
      .join("\n");
    arContext = `\n\nFULL AR 2026 BOARD DUMP (${arRows.length} items, the authoritative source for all contracted / AR / cash questions):\n${rows}`;
  }

  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 600,
    system: `You are Marco, Oltre Castings & Design's company secretary. You answer questions about the business using Monday.com data provided below.

OLTRE SYSTEMS CONTEXT (authoritative — use these exactly):
- Pipeline, contacts, leads, production → Monday.com (the boards below)
- **Cash / AR / contracted amounts / invoicing / payments → Monday AR 2026 board** (NOT FreshBooks, NOT Xero, NOT QuickBooks). Shopify orders land in Monday, not FreshBooks — Monday is the source of truth.
- Internal state, agent health, dashboards → oltre-dashboard.vercel.app
- Email → Gmail (Andrew) / Outlook (Bella @ bellab@oltreusa.com)
- Slack workspace → Oltre HQ

Never mention FreshBooks, Xero, or QuickBooks in your answers. If the user asks about financial data, the answer lives in the AR 2026 board dump below.

RULES:
- Be concise: 2-4 sentences maximum unless the question requires a list/table.
- Be specific: use actual names, dates, amounts, statuses from the data below.
- **Triangulate when you find partial matches.** If the user asked about "Lynette Renaissance Homes" and the data shows a contact named "Lynette" AND an account named "Renaissance Homes," combine them: "I see Lynette at Renaissance Homes in Contacts — [details]."
- For **financial aggregate questions** (monthly contracted totals, balances, AR by month, etc.), use the AR 2026 board dump below. Filter by date/timeline columns and sum Contract $ or Remaining Balance as appropriate.
- If a field like "Location" or "Address" is present, use it verbatim for address questions.
- If you found matching items, reference them by name and board. Include a Monday link when you can.
- If nothing matches, tell the user what to try next — don't dead-end.
- Don't make up data. Only use what's in the context below.
- Don't use exclamation marks or emojis.
- ${tier === 2 ? "This is a Tier 2 user — don't include financial details beyond deal value and status." : "This is Tier 1 (Andrew) — full detail."}

Monday.com per-entity search results:
${mondayContext}${arContext}`,
    messages: [
      ...toClaudeMessages(history),
      { role: "user", content: question },
    ],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return "I ran into an issue composing the answer. Try rephrasing your question.";
  }
  return textBlock.text;
}
