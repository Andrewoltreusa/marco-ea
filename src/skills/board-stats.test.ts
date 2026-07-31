/**
 * board-stats parser tests — pure logic only (no Monday calls).
 */

import { describe, it, expect } from "vitest";
import { parseBoardStatsQuestion, boardStats } from "./board-stats.js";
import { isSameIsoWeek, startOfIsoWeekUtc, addDays } from "../../lib/dates.js";

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

  it("maps this/current week to timeframe thisWeek", () => {
    expect(
      parseBoardStatsQuestion("what deals are closing this week?").timeframe,
    ).toBe("thisWeek");
    expect(
      parseBoardStatsQuestion("deals due in the current week").timeframe,
    ).toBe("thisWeek");
  });

  it("maps next week to timeframe nextWeek", () => {
    expect(
      parseBoardStatsQuestion("what deals are closing next week?").timeframe,
    ).toBe("nextWeek");
    expect(parseBoardStatsQuestion("deals due next week").timeframe).toBe(
      "nextWeek",
    );
    expect(
      parseBoardStatsQuestion("deals closing next week").closingThisWeek,
    ).toBe(false);
  });

  it("flags every other closing timeframe as unsupported", () => {
    for (const q of [
      "what deals are closing in june?",
      "deals due by q3",
      "how many deals close this month?",
      "deals closing in two weeks",
      "what's expected to close by 12/31?",
      "deals closing in 2026",
      "which deals close by may 15?",
    ]) {
      expect(parseBoardStatsQuestion(q).timeframe, q).toBe("unsupported");
    }
  });

  it("leaves timeframe null without a closing verb or without a timeframe", () => {
    expect(parseBoardStatsQuestion("how many deals do we have?").timeframe).toBe(
      null,
    );
    expect(parseBoardStatsQuestion("what deals are closing?").timeframe).toBe(
      null,
    );
    // "may" as a modal verb is not a month reference.
    expect(
      parseBoardStatsQuestion("which deals may close soon?").timeframe,
    ).toBe(null);
  });
});

describe("unsupported-timeframe refusal", () => {
  it("replies with the explicit range limitation, no board read", async () => {
    // Returns BEFORE getBoardItems — no Monday credentials needed.
    const reply = await boardStats("which deals are closing in June?");
    expect(reply).toBe(
      "I can slice closings by this week or next week right now — for other ranges check the Deals board directly.",
    );
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

  it("addDays(+7) shifts the reference into the NEXT ISO week (Mon–Sun)", () => {
    // Thursday 2026-07-30; next week runs Mon 2026-08-03 .. Sun 2026-08-09.
    const now = new Date("2026-07-30T12:00:00Z");
    const ref = addDays(now, 7);
    expect(startOfIsoWeekUtc(ref).toISOString()).toBe(
      "2026-08-03T00:00:00.000Z",
    );

    const nextTue = new Date("2026-08-04T12:00:00Z");
    const nextSun = new Date("2026-08-09T12:00:00Z");
    const thisFri = new Date("2026-07-31T12:00:00Z");
    const weekAfterMon = new Date("2026-08-10T12:00:00Z");
    expect(isSameIsoWeek(nextTue, ref)).toBe(true);
    expect(isSameIsoWeek(nextSun, ref)).toBe(true);
    expect(isSameIsoWeek(thisFri, ref)).toBe(false);
    expect(isSameIsoWeek(weekAfterMon, ref)).toBe(false);
    // ...and the shifted reference never overlaps the current week.
    expect(isSameIsoWeek(now, ref)).toBe(false);
  });

  it("addDays crosses a Sunday boundary correctly", () => {
    // Sunday 2026-08-02 + 7d = Sunday 2026-08-09, ISO week of Mon 08-03.
    const sun = new Date("2026-08-02T12:00:00Z");
    expect(startOfIsoWeekUtc(addDays(sun, 7)).toISOString()).toBe(
      "2026-08-03T00:00:00.000Z",
    );
  });
});
