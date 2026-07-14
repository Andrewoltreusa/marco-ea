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
  fuzzyFindItemsMulti,
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
import {
  computeArAggregates,
  fmtUsd,
  type ArAggregates,
} from "../../lib/ar.js";

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

  // Financial questions need the AR board regardless of what terms come
  // back — kick the fetch off NOW so it runs concurrently with the Claude
  // term-extraction call instead of after it.
  const arPromise = isFinancialQuestion(question)
    ? getBoardItems(BOARDS.AR_2026, { limit: 500 }).catch(() => null)
    : Promise.resolve(null);

  // Step 1: Extract search terms — history helps Claude resolve pronouns.
  const searchTerms = await extractSearchTerms(question, history);

  // Step 2: ONE board scan scores all terms (was: a full 5-board dump per
  // term), then dedupe candidates and hydrate them in parallel (was: one
  // awaited getItemWithColumns per candidate in a nested loop).
  const byTerm = await fuzzyFindItemsMulti(searchTerms, {
    limit: 3,
    boards: ALL_SEARCH_BOARDS,
  });

  const candidateTermById = new Map<string, string>();
  for (const [term, candidates] of byTerm) {
    for (const c of candidates) {
      if (c.score >= 0.3 && !candidateTermById.has(c.id)) {
        candidateTermById.set(c.id, term);
      }
    }
  }
  const candidateIds = Array.from(candidateTermById.keys()).slice(0, 6);

  const hydrated = await Promise.all(
    candidateIds.map((id) =>
      getItemWithColumns(id, { includeUpdates: true }).catch(() => null),
    ),
  );
  const unique: Array<{ item: ItemWithColumns; query: string }> = [];
  hydrated.forEach((full, i) => {
    if (full) {
      unique.push({ item: full, query: candidateTermById.get(candidateIds[i])! });
    }
  });

  // Financial context: the AR fetch has been running since before term
  // extraction — pre-compute sums in code and pass them as authoritative
  // facts. Claude is unreliable at arithmetic over 30+ rows.
  const board = await arPromise;
  const arBoardRows: BoardItemRow[] | null = board ? board.items : null;
  const arAggregates: ArAggregates | null = board
    ? computeArAggregates(board.items)
    : null;

  // Step 3: Have Claude compose the answer, with conversation history.
  const answer = await composeAnswer(
    question,
    unique,
    tier,
    history,
    arBoardRows,
    arAggregates,
  );

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
    // Haiku-class: structured term extraction doesn't need a frontier
    // model, and this call sits on the critical path of every query.
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: `You extract search terms from a user's question about Oltre Castings & Design's business.
Return a JSON array of search terms to look up in Monday.com boards (Deals, Leads, Contacts, Production).

INPUT MAY BE IN ENGLISH OR RUSSIAN. The search terms you return MUST be in English/proper-noun form (Monday items are indexed in English). Translate Russian names phonetically if unambiguous (e.g. "Ребекка Брук" → "Rebecca Brooke"); otherwise return both the Cyrillic and your best English transliteration as two separate terms.

RESOLVE PRONOUNS using the prior conversation. "her", "them", "that", "the project", "её", "его", "этот проект" all refer to entities Marco mentioned in the most recent turn. Substitute the actual names before extracting terms.

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
  arAgg: ArAggregates | null = null,
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

  // Build AR 2026 board context if this is a financial question.
  // Pre-computed aggregates (arAgg) go FIRST as authoritative facts;
  // the raw row dump follows for drill-down questions.
  let arContext = "";
  if (arAgg) {
    const statusLines = arAgg.byStatus
      .map(
        (s) =>
          `  - ${s.status}: ${s.count} items | Contract ${fmtUsd(s.contract)} | Paid ${fmtUsd(s.paid)} | Remaining ${fmtUsd(s.remaining)}`,
      )
      .join("\n");
    const monthLines =
      arAgg.byMonth.length > 0
        ? arAgg.byMonth
            .map(
              (m) =>
                `  - ${m.label} (${m.month}): ${m.count} items | Contract ${fmtUsd(m.contract)} | Paid ${fmtUsd(m.paid)} | Remaining ${fmtUsd(m.remaining)}`,
            )
            .join("\n")
        : "  (no items had a parseable date)";
    arContext += `

AR 2026 AUTHORITATIVE AGGREGATES (pre-computed from all ${arAgg.totalItems} items on the board — use these EXACT numbers, do NOT recalculate):
- Total items: ${arAgg.totalItems}
- Total Contract $ (entire board): ${fmtUsd(arAgg.totalContract)}
- Total Paid (Payment #1 + Payment #2 across entire board): ${fmtUsd(arAgg.totalPaid)}
- Total Remaining Balance (entire board): ${fmtUsd(arAgg.totalRemaining)}
- By Status:
${statusLines}
- By Month (bucketed by the item's Date column):
${monthLines}
`;
  }
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
    arContext += `
FULL AR 2026 BOARD ITEMS (${arRows.length} rows — use for item-level lookups; for totals use the aggregates above):
${rows}`;
  }

  const res = await client.messages.create({
    // Sonnet-class replaces Opus for composition: near-Opus quality on
    // this kind of grounded summarization at a fraction of the latency
    // and cost. Thinking is explicitly OFF — Sonnet 5 defaults to
    // adaptive thinking when the field is omitted, which would silently
    // eat the small max_tokens budget on a 2-4 sentence answer.
    model: "claude-sonnet-5",
    max_tokens: 600,
    thinking: { type: "disabled" },
    system: [
      {
        // Static persona + rules — byte-identical across every call, so
        // it forms a cacheable prefix. Dynamic content (tier note, Monday
        // context) comes AFTER the breakpoint in the second block.
        type: "text",
        text: `You are Marco, Oltre Castings & Design's company secretary. You answer questions about the business using Monday.com data provided below.

LANGUAGE: The user may write in English OR Russian (Alex Polkhovskiy and Alex Tretiakov often write in Russian). **Regardless of input language, ALWAYS respond in English.** This keeps Monday updates, Slack messages, and team communication consistent. Do not respond in Russian, Spanish, or any other language — English only, every time.

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
- For **financial aggregate questions** (contracted total, cash, AR, balances, etc.): **ALWAYS use the "AR 2026 AUTHORITATIVE AGGREGATES" block verbatim. DO NOT add rows up yourself — you will make arithmetic errors.** If the user asks "what's my contracted amount" or similar full-board totals, report the pre-computed Total Contract $. If they ask about a specific status group (Deposit / Paid / Sample), use the By Status breakdown.
- For **month-specific questions** (e.g. "contracted in April", "what about May?"): use the "By Month" breakdown in the aggregates block. Match the month name to the corresponding label (e.g. "April 2026" → use that row's numbers). Report the Contract / Paid / Remaining for that month exactly as pre-computed.
- **HARD RULE: Never sum rows yourself to compute an aggregate.** The aggregates block has totals by Status and by Month already. If the user asks for a slice that isn't there (e.g. "Q1", "last week", a specific project by name), say "I don't have that pre-computed" rather than inventing a number. For per-item lookups by name, use the row dump — but only report that single row's fields, don't aggregate.
- Only drill into individual rows from the raw dump when the user asks about a specific named item.
- If a field like "Location" or "Address" is present, use it verbatim for address questions.
- If you found matching items, reference them by name and board. Include a Monday link when you can.
- If nothing matches, tell the user what to try next — don't dead-end.
- Don't make up data. Only use what's in the context below.
- Don't use exclamation marks or emojis.`,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: `${tier === 2 ? "This is a Tier 2 user — don't include financial details beyond deal value and status." : "This is Tier 1 (Andrew) — full detail."}

Monday.com per-entity search results:
${mondayContext}${arContext}`,
      },
    ],
    messages: [
      ...toClaudeMessages(history),
      { role: "user", content: question },
    ],
  });

  // Observability — same pattern as kb-query; confirms cache behavior.
  console.info("[general-query] usage", {
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return "I ran into an issue composing the answer. Try rephrasing your question.";
  }
  return textBlock.text;
}
