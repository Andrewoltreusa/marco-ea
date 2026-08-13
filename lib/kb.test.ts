/**
 * KB completeness-gate tests (finding 7 residuals) — pure validation
 * logic only; no Redis or Monday calls.
 */

import { describe, it, expect } from "vitest";
import {
  validateKbText,
  validateCachedEntry,
  KB_TAIL_SECTION_NUMBER as TAIL,
} from "./kb.js";

/**
 * Synthesize a KB text with numbered sections 1..`sections`, padded so
 * the char-size gate passes whenever the section set is the variable
 * under test.
 */
function syntheticKb(sections: number, padPerSection = 3_000): string {
  const parts = ["# Marco Knowledge Base"];
  for (let i = 1; i <= sections; i++) {
    const title = i === 1 ? "Lead Workflow" : `Some Process ${i}`;
    parts.push(`## ${i}. ${title}`);
    parts.push(`Body for section ${i}. ` + "x".repeat(padPerSection));
  }
  return parts.join("\n\n");
}

describe("validateKbText", () => {
  it("accepts a complete KB (tail section present)", () => {
    expect(validateKbText(syntheticKb(TAIL))).toBeNull();
  });

  it("rejects a too-short text before anything else", () => {
    expect(validateKbText("Marco Knowledge Base")).toMatch(/too short/);
  });

  it("rejects a missing title", () => {
    const text = syntheticKb(TAIL).replace("Marco Knowledge Base", "Some Doc");
    expect(validateKbText(text)).toMatch(/title/);
  });

  it("rejects a truncated read via the section COUNT (pagination broke mid-doc)", () => {
    // 17 sections was the OLD tail sentinel — it must fail now.
    const problem = validateKbText(syntheticKb(17, 4_000));
    expect(problem).toMatch(/distinct numbered sections/);
  });

  it("rejects a doc missing the tail section even when the count passes", () => {
    // TAIL-1 sections satisfy the minimum count, but the tail sentinel is gone.
    const problem = validateKbText(syntheticKb(TAIL - 1));
    expect(problem).toMatch(new RegExp(`section "${TAIL}\\." tail sentinel`));
  });

  it("numbered list items cannot inflate the section count", () => {
    // 10 real sections + hundreds of "1. item" list lines: distinct
    // section numbers stay at 10, so the gate still fails.
    const lists = Array.from({ length: 400 }, () => "1. a list item").join(
      "\n",
    );
    const problem = validateKbText(`${syntheticKb(10, 6_000)}\n${lists}`);
    expect(problem).toMatch(/distinct numbered sections/);
  });

  it("accepts headings with and without markdown # prefixes", () => {
    const bare = syntheticKb(TAIL).replace(/^## /gm, "");
    expect(validateKbText(bare)).toBeNull();
  });
});

describe("validateCachedEntry (validate-on-read)", () => {
  const validEntry = {
    text: syntheticKb(TAIL),
    fetchedAt: Date.now(),
    sourceUpdatedAt: "2026-07-30T00:00:00Z",
  };

  it("returns a valid cached entry", () => {
    expect(validateCachedEntry("marco:kb:v1", validEntry)).toBe(validEntry);
  });

  it("treats a truncated cached text as a miss", () => {
    const poisoned = { ...validEntry, text: syntheticKb(17, 4_000) };
    expect(validateCachedEntry("marco:kb:lkg", poisoned)).toBeNull();
  });

  it("treats malformed values as a miss", () => {
    expect(validateCachedEntry("marco:kb:v1", null)).toBeNull();
    expect(validateCachedEntry("marco:kb:v1", "just a string")).toBeNull();
    expect(validateCachedEntry("marco:kb:v1", { fetchedAt: 1 })).toBeNull();
    expect(validateCachedEntry("marco:kb:v1", { text: 42 })).toBeNull();
  });
});
