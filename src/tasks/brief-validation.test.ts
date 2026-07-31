import { describe, it, expect } from "vitest";
import {
  isValidBrief,
  extractNumberTokens,
  normalizeNumberToken,
} from "./brief-validation.js";

// A realistic facts block, shaped like marco-team-morning-brief builds it.
const FACTS = [
  "DATE: 2026-07-30",
  "DEALS BY STAGE (count): Quote Sent: 12, Won: 7, Negotiation: 3",
  "TOTAL DEALS ON BOARD: 22",
  "AR TOTAL OUTSTANDING (authoritative): $181,586.50 across 24 items",
  "AR TOP 3 OUTSTANDING (authoritative): Schellenberg: $42,000.00 outstanding; Rivertop: $18,350.75 outstanding",
  "PRODUCTION (flagged or shipping within 5 business days):\nFLAGGED: Kevin Stone — status \"Red\", ship 2026-08-04",
];

const HEADER = "Oltre — 2026-07-30";

describe("normalizeNumberToken", () => {
  it("strips currency formatting and canonicalizes decimals", () => {
    expect(normalizeNumberToken("$181,586.50")).toBe("181586.5");
    expect(normalizeNumberToken("181586.5")).toBe("181586.5");
    expect(normalizeNumberToken("$42,000.00")).toBe("42000");
    expect(normalizeNumberToken("42000")).toBe("42000");
  });
});

describe("extractNumberTokens", () => {
  it("collects dollar amounts and counts, normalized", () => {
    const tokens = extractNumberTokens(FACTS.join("\n"));
    expect(tokens.has("181586.5")).toBe(true);
    expect(tokens.has("42000")).toBe(true);
    expect(tokens.has("24")).toBe(true);
    expect(tokens.has("22")).toBe(true);
    expect(tokens.has("5")).toBe(true);
  });

  it("excludes date-like tokens (ISO dates, MM-DD, times, bare years)", () => {
    const tokens = extractNumberTokens(
      "Oltre — 2026-07-30, brief for 07-30, posted at 7:30, year 2026",
    );
    expect(tokens.size).toBe(0);
  });
});

describe("isValidBrief numeric grounding", () => {
  it("passes a brief whose numbers all come from the facts", () => {
    const brief =
      `${HEADER}\n\n*Pipeline*\n22 deals on the board — Quote Sent: 12, Won: 7, Negotiation: 3.\n\n` +
      `*AR*\n$181,586.50 outstanding across 24 items. Top: Schellenberg $42,000.00, Rivertop $18,350.75.\n\n` +
      `*Production*\nKevin Stone flagged, ships 2026-08-04.`;
    expect(isValidBrief(brief, FACTS)).toBe(true);
  });

  it("catches a transposed digit in a dollar amount", () => {
    const brief = `${HEADER}\n\n*AR*\n$181,856.50 outstanding across 24 items.`;
    expect(isValidBrief(brief, FACTS)).toBe(false);
  });

  it("catches an invented count", () => {
    const brief = `${HEADER}\n\n*Pipeline*\n23 deals on the board.`;
    expect(isValidBrief(brief, FACTS)).toBe(false);
  });

  it("accepts reformatted but equal amounts ($42,000.00 vs 42000)", () => {
    const brief = `${HEADER}\n\n*AR*\nSchellenberg owes 42000 of the 24 open items.`;
    expect(isValidBrief(brief, FACTS)).toBe(true);
  });

  it("ignores date-like tokens not present in the facts", () => {
    // 2027, 08-15 and 9:00 appear nowhere in FACTS — dates are exempt.
    const brief = `${HEADER}\n\n*Production*\n24 items; next review 2027-08-15 at 9:00.`;
    expect(isValidBrief(brief, FACTS)).toBe(true);
  });
});

describe("isValidBrief format rules", () => {
  it("rejects a brief without the header", () => {
    expect(isValidBrief("Good morning, 22 deals.", FACTS)).toBe(false);
  });

  it("rejects exclamation marks and emoji (brand voice)", () => {
    expect(isValidBrief(`${HEADER}\n22 deals!`, FACTS)).toBe(false);
    expect(isValidBrief(`${HEADER}\n22 deals \u{1F389}`, FACTS)).toBe(false);
  });

  it("rejects an over-length brief", () => {
    expect(isValidBrief(`${HEADER}\n22 ${"x".repeat(3000)}`, FACTS)).toBe(false);
  });

  it("rejects a digit-free brief", () => {
    expect(isValidBrief("Oltre — brief\nAll quiet.", FACTS)).toBe(false);
  });
});
