/**
 * Monday API contract test — pins the live behaviors Marco depends on
 * under the version in MONDAY_API_VERSION. Run this BEFORE and AFTER any
 * bump of that constant; if a pinned shape changes, the failing assertion
 * names exactly what Marco must adapt to.
 *
 * Requires MONDAY_API_KEY (process.env or Marco/.env). CI has no Monday
 * secret, so the whole suite SKIPS there — it runs locally via the
 * predeploy chain, which is the moment version drift actually matters.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MONDAY_API_VERSION } from "./monday.js";

const DEALS_BOARD = "6466800590";
const KB_DOC_ID = 40608915;
const MISSING_BOARD = "999999999";

function apiKey(): string | null {
  if (process.env.MONDAY_API_KEY) return process.env.MONDAY_API_KEY;
  try {
    const envPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      ".env",
    );
    const line = fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("MONDAY_API_KEY="));
    return line ? line.slice("MONDAY_API_KEY=".length).trim() : null;
  } catch {
    return null;
  }
}

const KEY = apiKey();

async function gql<T>(query: string): Promise<T> {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: KEY as string,
      "Content-Type": "application/json",
      "API-Version": MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (!json.data) {
    throw new Error(`contract query failed: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.data;
}

describe.skipIf(!KEY)("Monday API contract (live, pinned " + MONDAY_API_VERSION + ")", () => {
  it("serves the pinned version verbatim and it is not deprecated", async () => {
    const d = await gql<{ version: { kind: string; value: string } }>(
      "query { version { kind value } }",
    );
    // A reroute to a different value is exactly the silent drift this
    // test exists to catch.
    expect(d.version.value).toBe(MONDAY_API_VERSION);
    expect(["current", "maintenance"]).toContain(d.version.kind);
  });

  it("items_page: cursor pagination shape, column {title}, updated_at", async () => {
    const d = await gql<{
      boards: Array<{
        id: string;
        name: string;
        items_page: {
          cursor: string | null;
          items: Array<{
            id: string;
            name: string;
            updated_at: string;
            column_values: Array<{
              text: string | null;
              value: string | null;
              column: { title: string };
            }>;
          }>;
        };
      }>;
    }>(
      `query { boards(ids: [${DEALS_BOARD}]) { id name items_page(limit: 2) {
        cursor items { id name updated_at column_values { text value column { title } } } } } }`,
    );
    const board = d.boards[0];
    expect(board.id).toBe(DEALS_BOARD);
    const item = board.items_page.items[0];
    expect(item).toBeTruthy();
    // updated_at must stay a parseable ISO instant — freshness logic
    // (production-alert, fleet-health) depends on it.
    expect(Number.isFinite(new Date(item.updated_at).getTime())).toBe(true);
    // column { title } is how every skill maps values to human columns.
    expect(typeof item.column_values[0]?.column?.title).toBe("string");
    // cursor: string when more pages exist, null when not — either is a
    // legal shape, but it must be one of the two.
    expect(["string", "object"]).toContain(typeof board.items_page.cursor);
  });

  it("next_items_page resolves for a live cursor (when one exists)", async () => {
    const first = await gql<{
      boards: Array<{ items_page: { cursor: string | null } }>;
    }>(
      `query { boards(ids: [${DEALS_BOARD}]) { items_page(limit: 1) { cursor } } }`,
    );
    const cursor = first.boards[0].items_page.cursor;
    if (!cursor) return; // one-page board — nothing to pin
    const next = await gql<{
      next_items_page: { cursor: string | null; items: Array<{ id: string }> };
    }>(
      `query { next_items_page(cursor: "${cursor}", limit: 1) { cursor items { id } } }`,
    );
    expect(Array.isArray(next.next_items_page.items)).toBe(true);
  });

  it("missing board returns an empty boards array (throw-on-missing depends on it)", async () => {
    const d = await gql<{ boards: unknown[] }>(
      `query { boards(ids: [${MISSING_BOARD}]) { id name } }`,
    );
    expect(d.boards).toEqual([]);
  });

  it("docs blocks(page, limit): shape and space-cased types the KB loader normalizes", async () => {
    const d = await gql<{
      docs: Array<{ blocks: Array<{ id: string; type: string; position: number; content: string }> }>;
    }>(
      `query { docs(ids: [${KB_DOC_ID}]) { blocks(page: 1, limit: 10) { id type position content } } }`,
    );
    const blocks = d.docs[0].blocks;
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(typeof b.type).toBe("string");
      expect(typeof b.content).toBe("string");
      expect(typeof b.position).toBe("number");
    }
    // The KB renderer keys headings off type.replace(/\s+/g, "_") — verify
    // the doc still leads with a title block in EITHER casing, so a casing
    // flip breaks THIS test instead of silently un-heading the KB.
    const normalized = blocks.map((b) => b.type.replace(/\s+/g, "_"));
    expect(
      normalized.some((t) =>
        ["large_title", "medium_title", "small_title"].includes(t),
      ),
    ).toBe(true);
  });
});
