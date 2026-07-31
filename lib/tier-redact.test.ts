/**
 * Tier-2 redaction tests — code-level financial filtering (finding 2).
 */

import { describe, it, expect } from "vitest";
import {
  isTier2BlockedColumn,
  stripFinancialColumns,
  redactMatchesForTier2,
} from "./tier-redact.js";
import { BOARDS } from "./monday.js";

describe("isTier2BlockedColumn", () => {
  it("blocks the AR financial columns", () => {
    expect(isTier2BlockedColumn("Contract $")).toBe(true);
    expect(isTier2BlockedColumn("Payment #1")).toBe(true);
    expect(isTier2BlockedColumn("Payment #2")).toBe(true);
    expect(isTier2BlockedColumn("Remaining Balance")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isTier2BlockedColumn("contract $")).toBe(true);
    expect(isTier2BlockedColumn(" Remaining Balance ")).toBe(true);
  });

  it("leaves non-financial columns alone", () => {
    expect(isTier2BlockedColumn("Status")).toBe(false);
    expect(isTier2BlockedColumn("Deal Value")).toBe(false);
    expect(isTier2BlockedColumn("Close Date")).toBe(false);
  });
});

describe("stripFinancialColumns", () => {
  it("removes financial columns and keeps the rest", () => {
    const stripped = stripFinancialColumns({
      "Contract $": "$12,000.00",
      "Payment #1": "$6,000.00",
      "Payment #2": "$3,000.00",
      "Remaining Balance": "$3,000.00",
      Status: "Deposit",
      Location: "Napa",
    });
    expect(stripped).toEqual({ Status: "Deposit", Location: "Napa" });
  });

  it("does not mutate the input", () => {
    const columns = { "Contract $": "$1.00", Status: "Paid" };
    stripFinancialColumns(columns);
    expect(columns).toEqual({ "Contract $": "$1.00", Status: "Paid" });
  });
});

describe("redactMatchesForTier2", () => {
  const arMatch = {
    item: {
      boardId: BOARDS.AR_2026,
      columns: { "Contract $": "$9,000.00", Status: "Deposit" },
    },
    query: "acme",
  };
  const dealMatch = {
    item: {
      boardId: BOARDS.DEALS,
      columns: {
        Stage: "Negotiation",
        "Contract $": "$9,000.00",
        "Payment #1": "$4,500.00",
      },
    },
    query: "acme",
  };

  it("drops AR 2026 rows entirely", () => {
    const out = redactMatchesForTier2([arMatch, dealMatch]);
    expect(out).toHaveLength(1);
    expect(out[0].item.boardId).toBe(BOARDS.DEALS);
  });

  it("strips financial columns from surviving rows", () => {
    const out = redactMatchesForTier2([dealMatch]);
    expect(out[0].item.columns).toEqual({ Stage: "Negotiation" });
  });

  it("preserves non-column props (query, extra item fields)", () => {
    const rich = {
      item: {
        boardId: BOARDS.DEALS,
        boardName: "Deals",
        name: "C26100",
        url: "https://example.invalid",
        columns: { Stage: "Won", "Payment #2": "$1.00" },
      },
      query: "c26100",
    };
    const out = redactMatchesForTier2([rich]);
    expect(out[0].query).toBe("c26100");
    expect(out[0].item.name).toBe("C26100");
    expect(out[0].item.url).toBe("https://example.invalid");
    expect(out[0].item.columns).toEqual({ Stage: "Won" });
  });

  it("returns everything untouched when nothing is financial", () => {
    const clean = {
      item: { boardId: BOARDS.LEADS, columns: { Status: "New lead" } },
      query: "bob",
    };
    expect(redactMatchesForTier2([clean])[0].item.columns).toEqual({
      Status: "New lead",
    });
  });
});
