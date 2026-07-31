import { describe, it, expect } from "vitest";
import {
  shipKeyPrefix,
  evaluateSlips,
  triageShipWrites,
  type Flag,
  type ShipWrite,
} from "./marco-production-alert.js";
import type { BoardItemRow } from "../../lib/monday.js";

// 2026-07-01 is a Wednesday. Business days from it:
//   → 2026-07-06 (Mon) = 3 (boundary, NOT a slip)
//   → 2026-07-07 (Tue) = 4 (slip)
//   → 2026-07-08 (Wed) = 5 (slip)
const WED = "2026-07-01";
const MON_PLUS3 = "2026-07-06";
const TUE_PLUS4 = "2026-07-07";
const WED_PLUS5 = "2026-07-08";

const LIVE_PREFIX = "marco:prodship:";
const DRY_PREFIX = "marco:prodship-dry:";

function row(id: string, status: string, shipDate: string): BoardItemRow {
  return {
    id,
    name: `Item ${id}`,
    url: `https://example.monday.com/boards/1/pulses/${id}`,
    columns: { Status: status, "Ship. Date": shipDate },
  };
}

function slipFlag(item: BoardItemRow, from: string, to: string): Flag {
  return {
    item,
    reason: `ship date slipped from ${from} to ${to}`,
    stateHash: `slip|${from}|${to}`,
    dedupId: `${item.id}:slip`,
  };
}

function statusFlag(item: BoardItemRow): Flag {
  return {
    item,
    reason: `status is "Red"`,
    stateHash: "Red|",
    dedupId: item.id,
  };
}

function write(
  itemId: string,
  current: string,
  isSlip: boolean,
  prefix = LIVE_PREFIX,
): ShipWrite {
  return { key: `${prefix}${itemId}`, itemId, current, isSlip };
}

describe("shipKeyPrefix (DRY_RUN ship-state isolation)", () => {
  it("selects the live prefix for real runs", () => {
    expect(shipKeyPrefix(false)).toBe("marco:prodship:");
  });

  it("selects a separate dry prefix so previews never consume real state", () => {
    expect(shipKeyPrefix(true)).toBe("marco:prodship-dry:");
    expect(shipKeyPrefix(true)).not.toBe(shipKeyPrefix(false));
  });
});

describe("evaluateSlips", () => {
  it("first sight: seeds a non-slip write, no flag", () => {
    const items = [row("101", "In Production", WED_PLUS5)];
    const { flags, shipWrites } = evaluateSlips(items, new Map(), LIVE_PREFIX);
    expect(flags).toEqual([]);
    expect(shipWrites).toEqual([write("101", WED_PLUS5, false)]);
  });

  it("unchanged date: non-slip write (TTL refresh), no flag", () => {
    const items = [row("101", "In Production", WED)];
    const { flags, shipWrites } = evaluateSlips(
      items,
      new Map([["101", WED]]),
      LIVE_PREFIX,
    );
    expect(flags).toEqual([]);
    expect(shipWrites).toEqual([write("101", WED, false)]);
  });

  it("move of exactly 3 business days is NOT a slip but still updates state", () => {
    const items = [row("101", "In Production", MON_PLUS3)];
    const { flags, shipWrites } = evaluateSlips(
      items,
      new Map([["101", WED]]),
      LIVE_PREFIX,
    );
    expect(flags).toEqual([]);
    expect(shipWrites).toEqual([write("101", MON_PLUS3, false)]);
  });

  it("move of more than 3 business days is a slip flag with a gated write", () => {
    const item = row("101", "In Production", TUE_PLUS4);
    const { flags, shipWrites } = evaluateSlips(
      [item],
      new Map([["101", WED]]),
      LIVE_PREFIX,
    );
    expect(flags).toEqual([slipFlag(item, WED, TUE_PLUS4)]);
    expect(shipWrites).toEqual([write("101", TUE_PLUS4, true)]);
  });

  it("date moving earlier is not a slip; write carries the new date", () => {
    const items = [row("101", "In Production", WED)];
    const { flags, shipWrites } = evaluateSlips(
      items,
      new Map([["101", WED_PLUS5]]),
      LIVE_PREFIX,
    );
    expect(flags).toEqual([]);
    expect(shipWrites).toEqual([write("101", WED, false)]);
  });

  it("skips terminal items and unparseable dates entirely — no writes", () => {
    const items = [
      row("101", "Installed", WED_PLUS5),
      row("102", "Shipped", WED_PLUS5),
      row("103", "In Production", "TBD"),
      row("104", "In Production", ""),
    ];
    const { flags, shipWrites } = evaluateSlips(
      items,
      new Map([["101", WED]]),
      LIVE_PREFIX,
    );
    expect(flags).toEqual([]);
    expect(shipWrites).toEqual([]);
  });

  it("builds keys with the prefix it is given (dry-run shadow state)", () => {
    const item = row("101", "In Production", WED_PLUS5);
    const { shipWrites } = evaluateSlips(
      [item],
      new Map([["101", WED]]),
      DRY_PREFIX,
    );
    expect(shipWrites).toEqual([write("101", WED_PLUS5, true, DRY_PREFIX)]);
  });
});

describe("triageShipWrites (two-phase commit)", () => {
  const itemA = row("201", "In Production", TUE_PLUS4);
  const itemB = row("202", "In Production", WED);
  const itemC = row("203", "Red", WED);
  const slipA = slipFlag(itemA, WED, TUE_PLUS4);
  const writes = [
    write("201", TUE_PLUS4, true),
    write("202", WED, false),
  ];

  it("commits everything, slips included, when no DM failed", () => {
    const fresh = new Map([
      ["U_ANDREW", [slipA]],
      ["U_ALEX", [slipA]],
    ]);
    expect(triageShipWrites(writes, fresh, new Set())).toEqual(writes);
  });

  it("holds a slip's key when a recipient owed its DM failed; non-slip writes still commit", () => {
    const fresh = new Map([
      ["U_ANDREW", [slipA]],
      ["U_ALEX", [slipA]],
    ]);
    const committed = triageShipWrites(writes, fresh, new Set(["U_ALEX"]));
    expect(committed).toEqual([write("202", WED, false)]);
  });

  it("commits a slip when the failed recipient was already de-duped for it (not in their fresh set)", () => {
    // Alex got the slip DM on a previous run (de-dup) — this run their
    // fresh set holds only an unrelated status flag, and their DM failed.
    const fresh = new Map([
      ["U_ANDREW", [slipA]],
      ["U_ALEX", [statusFlag(itemC)]],
    ]);
    const committed = triageShipWrites(writes, fresh, new Set(["U_ALEX"]));
    expect(committed).toEqual(writes);
  });

  it("status flags in a failed DM never hold ship writes", () => {
    const fresh = new Map([["U_ANDREW", [statusFlag(itemC)]]]);
    const committed = triageShipWrites(writes, fresh, new Set(["U_ANDREW"]));
    expect(committed).toEqual(writes);
  });

  it("commits a slip fresh for nobody (all recipients already notified)", () => {
    // E.g. a previous run delivered both DMs but crashed before the
    // commit phase — the re-detected slip is stale for everyone.
    const committed = triageShipWrites(writes, new Map(), new Set());
    expect(committed).toEqual(writes);
  });

  it("holds only the failed slip when multiple slips are in flight", () => {
    const slipB = slipFlag(itemB, WED, WED_PLUS5);
    const both = [write("201", TUE_PLUS4, true), write("202", WED_PLUS5, true)];
    // Andrew (failed) was owed only slip A; Alex (delivered) got both.
    const fresh = new Map([
      ["U_ANDREW", [slipA]],
      ["U_ALEX", [slipA, slipB]],
    ]);
    const committed = triageShipWrites(both, fresh, new Set(["U_ANDREW"]));
    expect(committed).toEqual([write("202", WED_PLUS5, true)]);
  });
});
