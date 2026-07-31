/**
 * Marco's Monday.com client.
 *
 * Read methods: fuzzy item search across Deals / Leads / Contacts.
 * Write method: `create_update` ONLY. No other mutations.
 *
 * Credentials: MONDAY_API_KEY shared with oltre-agents.
 *
 * Why a separate client instead of importing from oltre-agents:
 * deploy independence (see decisions/log.md "Outbound Slack client is standalone").
 */

import { clampMs } from "./deadline.js";

const MONDAY_API = "https://api.monday.com/v2";

function token(): string {
  const t = process.env.MONDAY_API_KEY;
  if (!t)
    throw new Error(
      "MONDAY_API_KEY not set. Copy from oltre-agents env into Marco's Trigger.dev env.",
    );
  return t;
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      Authorization: token(),
      "Content-Type": "application/json",
      // Verified live 2026-07-29: boards/items_page/next_items_page/updated_at
      // all resolve on 2025-04 with Marco's key (2024-01 was deprecated and
      // silently rerouted by Monday). 2025-07 also works if this ages out.
      "API-Version": "2025-04",
    },
    body: JSON.stringify({ query, variables }),
    // 25s deadline, clamped to the run's remaining budget — a hung Monday
    // call must fail into our catches, not eat the task's maxDuration
    // (Trigger kills runs without running them).
    signal: AbortSignal.timeout(clampMs(25_000)),
  });
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
    error_message?: string;
  };
  if (json.errors?.length) {
    throw new Error(`Monday GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (json.error_message) {
    throw new Error(`Monday error: ${json.error_message}`);
  }
  if (!json.data) throw new Error("Monday returned no data");
  return json.data;
}

/**
 * Failure classification for write attempts. DEFINITIVE means the
 * mutation provably did not apply: Monday itself answered with an error
 * envelope, or createItemUpdate's own guards ("create_update:" — empty
 * body, item not found, board not allowed) threw BEFORE the mutation
 * request was sent. Anything else (timeout, abort, undici "fetch failed"
 * thrown for ECONNRESET after the request may already have been sent,
 * HTTP 5xx bodies that fail to parse) is AMBIGUOUS: the update may have
 * landed, so only reconciliation against the item's updates feed may
 * authorize a retry. The prefixes are exactly the ones this module
 * throws — keep them in sync.
 */
const DEFINITIVE_FAILURE_PREFIXES = [
  "Monday GraphQL error:",
  "Monday error:",
  "Monday returned no data",
  "create_update:",
] as const;

export type MondayFailureClass = "definitive" | "ambiguous";

export function classifyMondayFailure(message: string): MondayFailureClass {
  return DEFINITIVE_FAILURE_PREFIXES.some((p) => message.startsWith(p))
    ? "definitive"
    : "ambiguous";
}

// ─────────────────────────────────────────────────────────────
// Canonical board IDs (also in COMPANY.md — keep in sync)
// ─────────────────────────────────────────────────────────────

export const BOARDS = {
  DEALS: "6466800590",
  LEADS: "6466800613",
  CONTACTS: "6466800570",
  OCD_SCHEDULE: "5895399290",
  AR_2026: "18393591112",
} as const;

export const BOARD_NAMES: Record<string, string> = {
  [BOARDS.DEALS]: "Deals",
  [BOARDS.LEADS]: "Leads",
  [BOARDS.CONTACTS]: "Contacts",
  [BOARDS.OCD_SCHEDULE]: "OCD Schedule",
  [BOARDS.AR_2026]: "AR 2026",
};

// Boards Marco is allowed to WRITE `create_update` against.
export const WRITE_ALLOWED_BOARDS = new Set<string>([
  BOARDS.DEALS,
  BOARDS.LEADS,
  BOARDS.CONTACTS,
]);

// ─────────────────────────────────────────────────────────────
// Cursor-paged board item fetch (shared by search + board dump)
// ─────────────────────────────────────────────────────────────

/** Items requested per page. 500 is Monday's items_page maximum. */
const ITEMS_PAGE_LIMIT = 500;

/**
 * Safety cap: 20 pages × 500 items = 10,000 items per board. If a board
 * ever exceeds this we stop, log a warning, and mark the read incomplete
 * so callers refuse to treat the result as authoritative.
 */
const ITEMS_MAX_PAGES = 20;

interface PagedBoard<TItem> {
  id: string;
  name: string;
  items: TItem[];
  /** Number of pages actually fetched. */
  pages: number;
  /** false only when ITEMS_MAX_PAGES truncated the read. */
  complete: boolean;
}

/**
 * Fetch every item on the given boards, following Monday's items_page
 * cursor until it is null (or the safety cap trips). The first call grabs
 * page 1 for ALL boards in one round-trip; continuation pages use
 * `next_items_page` and are sequential per board (Monday cursors must be
 * consumed in order), with different boards' continuations running in
 * parallel.
 *
 * `itemFields` is the GraphQL selection for each item (e.g. "id name").
 */
async function fetchBoardsPaged<TItem>(
  boardIds: string[],
  itemFields: string,
): Promise<Array<PagedBoard<TItem>>> {
  const firstGql = `
    query ($boardIds: [ID!]!, $limit: Int!) {
      boards(ids: $boardIds) {
        id
        name
        items_page(limit: $limit) {
          cursor
          items { ${itemFields} }
        }
      }
    }
  `;
  const nextGql = `
    query ($cursor: String!, $limit: Int!) {
      next_items_page(cursor: $cursor, limit: $limit) {
        cursor
        items { ${itemFields} }
      }
    }
  `;

  const data = await graphql<{
    boards: Array<{
      id: string;
      name: string;
      items_page: { cursor: string | null; items: TItem[] };
    }>;
  }>(firstGql, { boardIds, limit: ITEMS_PAGE_LIMIT });

  return Promise.all(
    (data.boards ?? []).map(async (board) => {
      const items = [...board.items_page.items];
      let cursor = board.items_page.cursor;
      let pages = 1;
      let complete = true;
      while (cursor) {
        if (pages >= ITEMS_MAX_PAGES) {
          complete = false;
          console.warn(
            `[marco monday] board ${board.id} ("${board.name}") hit the ` +
              `${ITEMS_MAX_PAGES}-page safety cap after ${items.length} items — read is TRUNCATED.`,
          );
          break;
        }
        const next = await graphql<{
          next_items_page: { cursor: string | null; items: TItem[] };
        }>(nextGql, { cursor, limit: ITEMS_PAGE_LIMIT });
        items.push(...(next.next_items_page?.items ?? []));
        cursor = next.next_items_page?.cursor ?? null;
        pages++;
      }
      return { id: board.id, name: board.name, items, pages, complete };
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// Item search (read)
// ─────────────────────────────────────────────────────────────

export interface MondayItem {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
  /** Score 0–1 of how well this item matches the query. */
  score: number;
}

/**
 * Fuzzy-search across Deals + Leads + Contacts by item name.
 * Returns all candidates sorted by score desc. Up to `limit`.
 */
export async function fuzzyFindItems(
  query: string,
  opts: { limit?: number; boards?: string[] } = {},
): Promise<MondayItem[]> {
  const byTerm = await fuzzyFindItemsMulti([query], opts);
  return byTerm.get(query) ?? [];
}

/**
 * Multi-term variant: fetches each board ONCE and scores every term
 * against the same item list. N terms cost 1 Monday round-trip instead
 * of N full board dumps — this was general-query's biggest latency tax.
 */
export async function fuzzyFindItemsMulti(
  terms: string[],
  opts: { limit?: number; boards?: string[] } = {},
): Promise<Map<string, MondayItem[]>> {
  const limit = opts.limit ?? 5;
  const boards = opts.boards ?? [BOARDS.DEALS, BOARDS.LEADS, BOARDS.CONTACTS];
  const out = new Map<string, MondayItem[]>();
  if (terms.length === 0) return out;

  // Monday supports items_page with query_params.rules for text filtering,
  // but the simplest path for fuzzy "contains" is to pull the full item
  // list (cursor-paged — boards >500 items no longer silently truncate)
  // and score locally.
  const pagedBoards = await fetchBoardsPaged<{ id: string; name: string }>(
    boards,
    "id name",
  );

  for (const term of terms) {
    const q = term.trim().toLowerCase();
    const qTokens = q.split(/\s+/).filter(Boolean);

    const candidates: MondayItem[] = [];
    for (const board of pagedBoards) {
      for (const item of board.items) {
        const name = item.name.toLowerCase();
        const score = scoreMatch(name, q, qTokens);
        if (score > 0) {
          candidates.push({
            id: item.id,
            name: item.name,
            boardId: board.id,
            boardName: board.name,
            score,
          });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    out.set(term, candidates.slice(0, limit));
  }
  return out;
}

/**
 * Simple token overlap scorer. 1.0 = exact match, 0.0 = no overlap.
 * Weights: exact substring > normalized substring > all-tokens-present
 *   > some-tokens-present.
 *
 * Normalization strips non-alphanumerics (hyphens, spaces, slashes,
 * parens) so deal-code typos like "C-26079" / "C26079" / "c 26 079"
 * all match the item "C26079".
 */
function scoreMatch(name: string, q: string, qTokens: string[]): number {
  if (!q) return 0;
  if (name === q) return 1.0;
  if (name.includes(q)) return 0.9;

  const normName = name.replace(/[^a-z0-9]/g, "");
  const normQ = q.replace(/[^a-z0-9]/g, "");
  if (normQ.length >= 3) {
    if (normName === normQ) return 0.95;
    if (normName.includes(normQ)) return 0.85;
    if (normQ.includes(normName) && normName.length >= 4) return 0.8;
  }

  const nameTokens = name.split(/\s+/).filter(Boolean);
  const hits = qTokens.filter((t) => nameTokens.some((n) => n.includes(t)));
  if (hits.length === 0) return 0;
  if (hits.length === qTokens.length) return 0.75;
  return 0.4 * (hits.length / qTokens.length);
}

// ─────────────────────────────────────────────────────────────
// Candidate resolution — ONE tie-break policy for every read skill
// ─────────────────────────────────────────────────────────────

export type CandidateResolution =
  | { kind: "match"; top: MondayItem }
  | { kind: "ambiguous"; candidates: MondayItem[] }
  | { kind: "none" };

/**
 * Resolve a fuzzy-candidate list to exactly one of: a confident match,
 * an ambiguous set the user must disambiguate, or nothing usable.
 *
 * Rules (finding 5 — replaces three copy-pasted guards in deal-status /
 * production-eta / lead-check):
 *  - top score < minScore → none. This applies on the PRIMARY path too:
 *    a lone weak token match (e.g. score 0.08) must never auto-select.
 *  - runner-up within tieMargin of top → ambiguous REGARDLESS of the top
 *    score. Two exact-name duplicates both scoring 1.0 are a tie the
 *    user has to break — the old `top.score < 0.8` escape auto-picked
 *    one of them. Only candidates at or above minScore count as
 *    runners-up (a sub-threshold match can't manufacture a tie).
 *  - otherwise → match.
 *
 * Callers should fetch candidates with limit >= 3 so ties are visible —
 * a limit-1 fetch can never expose the runner-up.
 */
export function resolveCandidates(
  candidates: MondayItem[],
  opts: { minScore?: number; tieMargin?: number } = {},
): CandidateResolution {
  const minScore = opts.minScore ?? 0.3;
  const tieMargin = opts.tieMargin ?? 0.15;
  const viable = [...candidates]
    .sort((a, b) => b.score - a.score)
    .filter((c) => c.score >= minScore);
  const top = viable[0];
  if (!top) return { kind: "none" };
  if (viable.length > 1 && top.score - viable[1].score < tieMargin) {
    return { kind: "ambiguous", candidates: viable };
  }
  return { kind: "match", top };
}

/** Canonical Monday item URL — the single place the workspace host lives. */
export function itemUrl(boardId: string, itemId: string): string {
  return `https://oregonfivestar-company.monday.com/boards/${boardId}/pulses/${itemId}`;
}

/**
 * Slack-formatted bullet list of candidates (board + Monday URL) for
 * ambiguous replies — shared by the read skills so the disambiguation
 * prompt looks the same everywhere.
 */
export function formatCandidateList(candidates: MondayItem[]): string {
  return candidates
    .map(
      (c) =>
        `• *${c.name}* (${c.boardName}) — <${itemUrl(c.boardId, c.id)}|View>`,
    )
    .join("\n");
}

// ─────────────────────────────────────────────────────────────
// Relation links — items connected via board_relation columns
// ─────────────────────────────────────────────────────────────

export interface LinkedItem {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
}

/**
 * All items linked to `itemId` through any board_relation column.
 * This is how Contacts connect to Deals (contact_deal): deals are named
 * by code (C26100), so name-based fuzzy search can never find them from
 * a person's name — the relation column is the only bridge.
 */
export async function getLinkedItems(itemId: string): Promise<LinkedItem[]> {
  const gql = `
    query ($id: [ID!]!) {
      items(ids: $id) {
        column_values {
          ... on BoardRelationValue {
            linked_items { id name board { id name } }
          }
        }
      }
    }
  `;
  const data = await graphql<{
    items: Array<{
      column_values: Array<{
        linked_items?: Array<{ id: string; name: string; board: { id: string; name: string } }>;
      }>;
    }>;
  }>(gql, { id: [itemId] });

  const out: LinkedItem[] = [];
  for (const cv of data.items[0]?.column_values ?? []) {
    for (const li of cv.linked_items ?? []) {
      out.push({ id: li.id, name: li.name, boardId: li.board.id, boardName: li.board.name });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Board dump — fetch ALL items on a board with column values
// ─────────────────────────────────────────────────────────────

export interface BoardItemRow {
  id: string;
  name: string;
  url: string;
  /** Monday's item-level `updated_at` (ISO string), when the API returns it. */
  updatedAt?: string;
  columns: Record<string, string>;
}

/** Read-completeness metadata attached to every getBoardItems result. */
export interface BoardReadMeta {
  /** false only when the page safety cap truncated the read. */
  complete: boolean;
  itemCount: number;
  pages: number;
}

/**
 * Fetch every item on a board with selected columns. Used for
 * filter/aggregate questions like "What's my contracted amount for
 * April?" where there's no single entity to search by name.
 *
 * Follows the items_page cursor to completion (safety cap: 20 pages /
 * 10,000 items — `meta.complete` is false if the cap trips). Throws if
 * the board doesn't exist or the API key can't see it — a missing board
 * must never masquerade as an empty successful one.
 *
 * `opts.limit` is accepted for backward compatibility but ignored: the
 * fetch always pages at Monday's 500-item page maximum until done.
 */
export async function getBoardItems(
  boardId: string,
  _opts?: { limit?: number },
): Promise<{ boardName: string; items: BoardItemRow[]; meta: BoardReadMeta }> {
  interface RawItem {
    id: string;
    name: string;
    updated_at: string | null;
    column_values: Array<{
      id: string;
      type: string;
      text: string | null;
      column: { title: string };
    }>;
  }

  const boards = await fetchBoardsPaged<RawItem>(
    [boardId],
    `
      id
      name
      updated_at
      column_values {
        id
        type
        text
        column { title }
      }
    `,
  );

  const board = boards[0];
  if (!board) {
    throw new Error(`Monday board ${boardId} not found or inaccessible`);
  }

  const items: BoardItemRow[] = board.items.map((item) => {
    const columns: Record<string, string> = {};
    for (const col of item.column_values) {
      if (!col.text) continue;
      const title = col.column.title;
      // Title collision (e.g. AR 2026 has two columns both titled "Date"):
      // keep the first non-empty value under the bare title, and expose
      // the column id as a second key for disambiguation.
      if (columns[title] === undefined) {
        columns[title] = col.text;
      }
      // Always also store under the column id so callers can target
      // specific columns when titles collide.
      columns[`#${col.id}`] = col.text;
    }
    return {
      id: item.id,
      name: item.name,
      url: itemUrl(board.id, item.id),
      updatedAt: item.updated_at ?? undefined,
      columns,
    };
  });

  return {
    boardName: board.name,
    items,
    meta: { complete: board.complete, itemCount: items.length, pages: board.pages },
  };
}

// ─────────────────────────────────────────────────────────────
// Item fetch by ID (used by the reaction handler to re-verify target)
// ─────────────────────────────────────────────────────────────

export async function getItem(itemId: string): Promise<{
  id: string;
  name: string;
  boardId: string;
} | null> {
  const gql = `
    query ($id: [ID!]!) {
      items(ids: $id) {
        id
        name
        board { id }
      }
    }
  `;
  const data = await graphql<{
    items: Array<{ id: string; name: string; board: { id: string } }>;
  }>(gql, { id: [itemId] });
  const item = data.items?.[0];
  if (!item) return null;
  return { id: item.id, name: item.name, boardId: item.board.id };
}

// ─────────────────────────────────────────────────────────────
// Item updates feed (used by draft reconciliation)
// ─────────────────────────────────────────────────────────────

export interface ItemUpdate {
  id: string;
  text_body: string;
  created_at: string;
}

/**
 * Recent updates on an item, newest first — the reconciliation source of
 * truth for "did that ambiguous create_update actually land?". Plain
 * query, bounded by the standard clamped 25s signal in graphql().
 */
export async function getItemUpdates(
  itemId: string,
  limit = 50,
): Promise<ItemUpdate[]> {
  const gql = `
    query ($id: [ID!]!, $limit: Int!) {
      items(ids: $id) {
        updates(limit: $limit) {
          id
          text_body
          created_at
        }
      }
    }
  `;
  const data = await graphql<{
    items: Array<{
      updates?: Array<{ id: string; text_body: string | null; created_at: string }>;
    }>;
  }>(gql, { id: [itemId], limit });
  return (data.items?.[0]?.updates ?? []).map((u) => ({
    id: u.id,
    text_body: u.text_body ?? "",
    created_at: u.created_at,
  }));
}

// ─────────────────────────────────────────────────────────────
// Item fetch with column values (used by read skills)
// ─────────────────────────────────────────────────────────────

export interface ColumnValue {
  id: string;
  title: string;
  type: string;
  text: string | null;
  value: string | null;
}

export interface ItemWithColumns {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
  url: string;
  columns: Record<string, string>;
  updates: Array<{ text: string; createdAt: string }>;
}

export async function getItemWithColumns(
  itemId: string,
  opts?: { includeUpdates?: boolean },
): Promise<ItemWithColumns | null> {
  const updatesClause = opts?.includeUpdates
    ? `updates(limit: 3) { text_body created_at }`
    : "";
  const gql = `
    query ($id: [ID!]!) {
      items(ids: $id) {
        id
        name
        board { id name }
        column_values {
          id
          type
          text
          column {
            title
          }
        }
        ${updatesClause}
      }
    }
  `;
  const data = await graphql<{
    items: Array<{
      id: string;
      name: string;
      board: { id: string; name: string };
      column_values: Array<{
        id: string;
        type: string;
        text: string | null;
        column: { title: string };
      }>;
      updates?: Array<{ text_body: string; created_at: string }>;
    }>;
  }>(gql, { id: [itemId] });
  const item = data.items?.[0];
  if (!item) return null;

  const columns: Record<string, string> = {};
  for (const col of item.column_values) {
    if (col.text) columns[col.column.title] = col.text;
  }

  return {
    id: item.id,
    name: item.name,
    boardId: item.board.id,
    boardName: item.board.name,
    url: itemUrl(item.board.id, item.id),
    columns,
    updates: (item.updates ?? []).map((u) => ({
      text: u.text_body,
      createdAt: u.created_at,
    })),
  };
}

// (findAndLoad — the old limit-1 "take the top hit" wrapper — was removed
// with finding 5: every read skill now resolves candidates through
// resolveCandidates so ties and weak matches surface instead of
// auto-selecting.)

// ─────────────────────────────────────────────────────────────
// WRITE: create_update (the only mutation Marco is allowed)
// ─────────────────────────────────────────────────────────────

export interface CreateUpdateResult {
  updateId: string;
  itemId: string;
  itemName: string;
  boardId: string;
  boardName: string;
  url: string;
}

/**
 * Post an update (the yellow "updates" feed entry) to an existing Monday item.
 *
 * Guardrails:
 *  - itemId must exist
 *  - item's board must be in WRITE_ALLOWED_BOARDS
 *  - body must be non-empty and <= 10000 chars
 *  - body must already include the requester's signature (we don't append here —
 *    the draft task does that so the preview matches exactly what gets written)
 */
export async function createItemUpdate(args: {
  itemId: string;
  body: string;
}): Promise<CreateUpdateResult> {
  const body = args.body.trim();
  if (!body) throw new Error("create_update: empty body");
  if (body.length > 10000) throw new Error("create_update: body too long");

  const item = await getItem(args.itemId);
  if (!item) throw new Error(`create_update: item ${args.itemId} not found`);
  if (!WRITE_ALLOWED_BOARDS.has(item.boardId)) {
    throw new Error(
      `create_update: board ${item.boardId} is not in the write-allowed set`,
    );
  }

  const gql = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `;
  const data = await graphql<{ create_update: { id: string } }>(gql, {
    itemId: args.itemId,
    body,
  });

  const boardName = BOARD_NAMES[item.boardId] ?? item.boardId;
  return {
    updateId: data.create_update.id,
    itemId: item.id,
    itemName: item.name,
    boardId: item.boardId,
    boardName,
    url: itemUrl(item.boardId, item.id),
  };
}
