/**
 * board-stats parser tests — pure logic only (no Monday calls).
 */

import { describe, it, expect } from "vitest";
import { parseBoardStatsQuestion } from "./board-stats.js";
import { isSameIsoWeek, startOfIsoWeekUtc } from "../../lib/dates.js";

describe("board-stats question parser", () => {
  it("defaults to the Deals board", () => {
    expect(parseBoardStatsQuestion("how many are closing this week?").board).toBe(
      "deals",
    );
  });

  it("picks the named board", () => {
    expect(parseBoardStatsQuestion("how many leads do we have?").board).toBe(
      "leads",
    );
    expect(parseBoardStatsQuestion("count the contacts").board).toBe("contacts");
    expect(parseBoardStatsQuestion("how many deals are open?").board).toBe(
      "deals",
    );
  });

  it("picks the first-mentioned board when several appear", () => {
    expect(
      parseBoardStatsQuestion("how many leads converted to deals?").board,
    ).toBe("leads");
  });

  it("detects closing-this-week", () => {
    expect(
      parseBoardStatsQuestion("what deals are closing this week?").closingThisWeek,
    ).toBe(true);
    expect(
      parseBoardStatsQuestion("deals due this week").closingThisWeek,
    ).toBe(true);
    expect(
      parseBoardStatsQuestion("how many deals do we have?").closingThisWeek,
    ).toBe(false);
  });
});

describe("ISO week helpers (lib/dates)", () => {
  it("groups Monday through Sunday into one week", () => {
    // 2026-07-27 is a Monday, 2026-08-02 the following Sunday.
    const mon = new Date("2026-07-27T12:00:00Z");
    const sun = new Date("2026-08-02T12:00:00Z");
    const nextMon = new Date("2026-08-03T12:00:00Z");
    expect(isSameIsoWeek(mon, sun)).toBe(true);
    expect(isSameIsoWeek(sun, nextMon)).toBe(false);
    expect(startOfIsoWeekUtc(sun).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
  });
});
