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
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query, variables }),
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
  const limit = opts.limit ?? 5;
  const boards = opts.boards ?? [BOARDS.DEALS, BOARDS.LEADS, BOARDS.CONTACTS];

  // Monday supports items_page with query_params.rules for text filtering,
  // but the simplest path for fuzzy "contains" is to pull recent items and
  // score locally. Good enough for v1 — Oltre boards are small (<500 items).
  const gql = `
    query ($boardIds: [ID!]!) {
      boards(ids: $boardIds) {
        id
        name
        items_page(limit: 500) {
          items {
            id
            name
          }
        }
      }
    }
  `;
  const data = await graphql<{
    boards: Array<{
      id: string;
      name: string;
      items_page: { items: Array<{ id: string; name: string }> };
    }>;
  }>(gql, { boardIds: boards });

  const q = query.trim().toLowerCase();
  const qTokens = q.split(/\s+/).filter(Boolean);

  const candidates: MondayItem[] = [];
  for (const board of data.boards) {
    for (const item of board.items_page.items) {
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
  return candidates.slice(0, limit);
}

/**
 * Simple token overlap scorer. 1.0 = exact match, 0.0 = no overlap.
 * Weights: exact substring > all-tokens-present > some-tokens-present.
 */
function scoreMatch(name: string, q: string, qTokens: string[]): number {
  if (!q) return 0;
  if (name === q) return 1.0;
  if (name.includes(q)) return 0.9;

  const nameTokens = name.split(/\s+/).filter(Boolean);
  const hits = qTokens.filter((t) => nameTokens.some((n) => n.includes(t)));
  if (hits.length === 0) return 0;
  if (hits.length === qTokens.length) return 0.75;
  return 0.4 * (hits.length / qTokens.length);
}

// ─────────────────────────────────────────────────────────────
// Board dump — fetch ALL items on a board with column values
// ─────────────────────────────────────────────────────────────

export interface BoardItemRow {
  id: string;
  name: string;
  url: string;
  columns: Record<string, string>;
}

/**
 * Fetch every item on a board with selected columns. Used for
 * filter/aggregate questions like "What's my contracted amount for
 * April?" where there's no single entity to search by name.
 *
 * Warning: boards with >500 items will hit the pagination limit.
 * Oltre boards are all <500 items as of 2026-04-17 so this is fine.
 */
export async function getBoardItems(
  boardId: string,
  opts?: { limit?: number },
): Promise<{ boardName: string; items: BoardItemRow[] }> {
  const limit = opts?.limit ?? 500;
  const gql = `
    query ($boardId: [ID!]!, $limit: Int!) {
      boards(ids: $boardId) {
        id
        name
        items_page(limit: $limit) {
          items {
            id
            name
            column_values {
              id
              type
              text
              column { title }
            }
          }
        }
      }
    }
  `;
  const data = await graphql<{
    boards: Array<{
      id: string;
      name: string;
      items_page: {
        items: Array<{
          id: string;
          name: string;
          column_values: Array<{
            id: string;
            type: string;
            text: string | null;
            column: { title: string };
          }>;
        }>;
      };
    }>;
  }>(gql, { boardId: [boardId], limit });

  const board = data.boards?.[0];
  if (!board) return { boardName: "unknown", items: [] };

  const items: BoardItemRow[] = board.items_page.items.map((item) => {
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
      url: `https://oregonfivestar-company.monday.com/boards/${board.id}/pulses/${item.id}`,
      columns,
    };
  });

  return { boardName: board.name, items };
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
    url: `https://oregonfivestar-company.monday.com/boards/${item.board.id}/pulses/${item.id}`,
    columns,
    updates: (item.updates ?? []).map((u) => ({
      text: u.text_body,
      createdAt: u.created_at,
    })),
  };
}

/**
 * Fuzzy-find items and return the top match with full column values.
 * Convenience wrapper used by read skills.
 */
export async function findAndLoad(
  query: string,
  opts?: { boards?: string[]; includeUpdates?: boolean },
): Promise<{ item: ItemWithColumns; score: number } | null> {
  const candidates = await fuzzyFindItems(query, {
    limit: 1,
    boards: opts?.boards,
  });
  if (candidates.length === 0 || candidates[0].score < 0.3) return null;
  const full = await getItemWithColumns(candidates[0].id, {
    includeUpdates: opts?.includeUpdates,
  });
  if (!full) return null;
  return { item: full, score: candidates[0].score };
}

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
    url: `https://oregonfivestar-company.monday.com/boards/${item.boardId}/pulses/${item.id}`,
  };
}
