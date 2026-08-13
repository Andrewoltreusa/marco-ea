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
 *   "Remind me who Alex T. is meeting tomorrow"
 *
 * (Board-aggregate questions — "how many leads do we have?", "what deals
 * are closing this week?" — route to board-stats and are counted in code.)
 */

import { anthropic } from "../../lib/anthropic.js";
import { MARCO_PERSONA } from "../../lib/marco-persona.js";
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
  topOutstanding,
  type ArAggregates,
} from "../../lib/ar.js";
import { redactMatchesForTier2, TIER2_PROMPT_NOTE } from "../../lib/tier-redact.js";

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
export function isFinancialQuestion(text: string): boolean {
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
  //
  // FAIL CLOSED: if the AR fetch fails on a financial question we do NOT
  // let the model compose from partial context (it would answer with no
  // numbers, or worse, invented ones). We track the failure separately
  // and short-circuit below.
  const financial = isFinancialQuestion(question);
  let arFailed = false;
  const arPromise = financial
    ? getBoardItems(BOARDS.AR_2026, { limit: 500 }).catch(() => {
        arFailed = true;
        return null;
      })
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
      // TIER GATE (code, not prompt): AR 2026 rows never become entity
      // matches for Tier 2 — their sanctioned AR view is the aggregates
      // + top-5 outstanding blocks below (lib/tier-redact.ts).
      if (tier === 2 && c.boardId === BOARDS.AR_2026) continue;
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

  // TIER GATE (code, not prompt): for Tier 2, drop any AR 2026 row that
  // slipped through hydration and strip financial columns from every
  // other matched row BEFORE the prompt is assembled. The tier note in
  // the prompt below is defense-in-depth only — the data must be gone.
  const matches = tier === 2 ? redactMatchesForTier2(unique) : unique;

  // Financial context: the AR fetch has been running since before term
  // extraction — pre-compute sums in code and pass them as authoritative
  // facts. Claude is unreliable at arithmetic over 30+ rows.
  //
  // TIER GATE (code-level, not prompt-level): Tier 1 gets aggregates plus
  // the full row dump. Tier 2 gets aggregates + top-5 outstanding ONLY —
  // per cash-position spec, no account-level drilldown. The raw rows must
  // never enter a Tier-2 prompt at all.
  const board = await arPromise;

  // Fail closed: financial question + AR board unreachable → no answer,
  // not a half-answer. (Still record the turn so follow-ups have context.)
  if (financial && arFailed) {
    const failText =
      "The AR 2026 board is unreachable right now, so I can't give you financial numbers. Try again in a few minutes.";
    if (channelId) {
      await appendTurn(channelId, {
        at: new Date().toISOString(),
        user: question,
        assistant: failText,
      });
    }
    return failText;
  }

  const arBoardRows: BoardItemRow[] | null =
    board && tier === 1 ? board.items : null;
  const arAggregates: ArAggregates | null = board
    ? computeArAggregates(board.items)
    : null;
  const arTop5 =
    board && tier === 2 ? topOutstanding(board.items, 5) : null;
  // Finding 4b: a page-cap-truncated AR read must never be presented as
  // "all N items" — the prompt header switches to a truncated-read
  // caveat and instructs the model to say so.
  const arIncomplete = board !== null && !board.meta.complete;

  // Step 3: Have Claude compose the answer, with conversation history.
  const answer = await composeAnswer(
    question,
    matches,
    tier,
    history,
    arBoardRows,
    arAggregates,
    arTop5,
    arIncomplete,
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
  const client = anthropic();

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
  arTop5: Array<{ name: string; remaining: number }> | null = null,
  arIncomplete = false,
): Promise<string> {
  const client = anthropic();

  // Build context from Monday per-entity search results
  let mondayContext = "";
  if (results.length === 0) {
    mondayContext = "No matching items found in Monday.com (Deals, Leads, Contacts, Production Schedule, or AR 2026 boards) by entity name.";
  } else {
    mondayContext = results
      .map((r) => {
        // Skip "#columnId" keys — they duplicate the title-keyed values
        // (lib/monday.ts stores every column under BOTH its title and
        // "#<id>") and are machine noise in a prompt.
        const cols = Object.entries(r.item.columns)
          .filter(([k, v]) => !k.startsWith("#") && v && v.trim())
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
      arAgg.byShipMonth.length > 0
        ? arAgg.byShipMonth
            .map(
              (m) =>
                `  - ${m.label} (${m.month}): ${m.count} items | Contract ${fmtUsd(m.contract)} | Paid ${fmtUsd(m.paid)} | Remaining ${fmtUsd(m.remaining)}`,
            )
            .join("\n")
        : "  (no items had a parseable ship date)";
    // Finding 4b: never claim "all N items" when the page safety cap
    // truncated the read — mirror the morning brief's discipline and make
    // the model disclose the truncation in its answer.
    const aggHeader = arIncomplete
      ? `AR 2026 AGGREGATES — TRUNCATED READ (only the first ${arAgg.totalItems} items on the board were read; totals may be LOW. You MUST say the read was incomplete in your answer. Use these EXACT numbers, do NOT recalculate):`
      : `AR 2026 AUTHORITATIVE AGGREGATES (pre-computed from all ${arAgg.totalItems} items on the board — use these EXACT numbers, do NOT recalculate):`;
    arContext += `

${aggHeader}
- Total items: ${arAgg.totalItems}
- Total Contract $ (entire board): ${fmtUsd(arAgg.totalContract)}
- Total Paid (Payment #1 + Payment #2 across entire board): ${fmtUsd(arAgg.totalPaid)}
- Total Remaining Balance (entire board): ${fmtUsd(arAgg.totalRemaining)}
- By Status:
${statusLines}
- By Ship Month (bucketed by each item's ship date — if the user asked about when contracts were SIGNED, say that data isn't bucketed):
${monthLines}
`;
  }
  if (arRows && arRows.length > 0) {
    const rows = arRows
      .map((r) => {
        // Same "#columnId" duplicate filter as the per-entity context —
        // halves the token cost of the row dump.
        const cols = Object.entries(r.columns)
          .filter(([k, v]) => !k.startsWith("#") && v && v.trim())
          .map(([k, v]) => `${k}=${v}`)
          .join(" | ");
        return `- ${r.name} | ${cols}`;
      })
      .join("\n");
    const rowsHeader = arIncomplete
      ? `AR 2026 BOARD ITEMS — TRUNCATED READ (first ${arRows.length} rows only; an item the user asks about may be missing — say so if you can't find it; for totals use the aggregates above):`
      : `FULL AR 2026 BOARD ITEMS (${arRows.length} rows — use for item-level lookups; for totals use the aggregates above):`;
    arContext += `
${rowsHeader}
${rows}`;
  }
  if (arTop5 && arTop5.length > 0) {
    // Tier-2 view: the only account-level AR detail permitted.
    arContext += `
TOP OUTSTANDING (the only per-account AR detail you may share with this user):
${arTop5.map((t) => `- ${t.name}: ${fmtUsd(t.remaining)} outstanding`).join("\n")}`;
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
        // Static prefix — MARCO_PERSONA (single-source voice from
        // lib/marco-persona.ts, shared with kb-query) plus the
        // query-specific rules that only apply to this skill.
        // Byte-identical across every call, so it forms a cacheable
        // prefix. Dynamic content (tier note, Monday context) comes
        // AFTER the breakpoint in the second block.
        type: "text",
        text: `${MARCO_PERSONA}

GENERAL-QUERY RULES (applied on top of the persona; Monday data is provided below):
- **Triangulate when you find partial matches.** If the user asked about "Lynette Renaissance Homes" and the data shows a contact named "Lynette" AND an account named "Renaissance Homes," combine them: "I see Lynette at Renaissance Homes in Contacts — [details]."
- For **financial aggregate questions** (contracted total, cash, AR, balances, etc.): **ALWAYS use the "AR 2026 AUTHORITATIVE AGGREGATES" block verbatim. DO NOT add rows up yourself — you will make arithmetic errors.** If the user asks "what's my contracted amount" or similar full-board totals, report the pre-computed Total Contract $. If they ask about a specific status group (Deposit / Paid / Sample), use the By Status breakdown.
- For **month-specific questions** (e.g. "contracted in April", "what about May?"): use the "By Ship Month" breakdown in the aggregates block. IMPORTANT: those buckets group items by their SHIP date, not the contract signing date. If the user explicitly asks about when contracts were signed, say the data is only bucketed by ship month and report it as such. Match the month name to the corresponding label (e.g. "April 2026" → use that row's numbers). Report the Contract / Paid / Remaining for that month exactly as pre-computed.
- **HARD RULE: Never sum rows yourself to compute an aggregate.** The aggregates block has totals by Status and by Month already. If the user asks for a slice that isn't there (e.g. "Q1", "last week", a specific project by name), say "I don't have that pre-computed" rather than inventing a number. For per-item lookups by name, use the row dump — but only report that single row's fields, don't aggregate.
- Only drill into individual rows from the raw dump when the user asks about a specific named item.
- If a field like "Location" or "Address" is present, use it verbatim for address questions.`,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: `${tier === 2 ? TIER2_PROMPT_NOTE : "This is Tier 1 (Andrew) — full detail."}

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
