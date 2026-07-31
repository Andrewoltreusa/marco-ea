import { describe, it, expect } from "vitest";
import {
  classifyMondayFailure,
  resolveCandidates,
  formatCandidateList,
  itemUrl,
  type MondayItem,
} from "./monday.js";

describe("classifyMondayFailure", () => {
  it("Monday GraphQL error envelope → definitive", () => {
    expect(
      classifyMondayFailure("Monday GraphQL error: ColumnValueException; nope"),
    ).toBe("definitive");
  });

  it("Monday error envelope → definitive", () => {
    expect(classifyMondayFailure("Monday error: Not Authenticated")).toBe(
      "definitive",
    );
  });

  it("Monday returned no data → definitive", () => {
    expect(classifyMondayFailure("Monday returned no data")).toBe("definitive");
  });

  it("create_update pre-send guards → definitive (F10)", () => {
    expect(classifyMondayFailure("create_update: item 123 not found")).toBe(
      "definitive",
    );
    expect(
      classifyMondayFailure("create_update: board 999 is not in the write-allowed set"),
    ).toBe("definitive");
    expect(classifyMondayFailure("create_update: empty body")).toBe("definitive");
  });

  it("undici fetch failed (may have been sent) → ambiguous", () => {
    expect(classifyMondayFailure("fetch failed")).toBe("ambiguous");
  });

  it("timeout/abort → ambiguous", () => {
    expect(classifyMondayFailure("The operation was aborted due to timeout")).toBe(
      "ambiguous",
    );
    expect(classifyMondayFailure("TimeoutError: signal timed out")).toBe(
      "ambiguous",
    );
    expect(classifyMondayFailure("This operation was aborted")).toBe("ambiguous");
  });

  it("HTTP 5xx / JSON parse noise → ambiguous", () => {
    expect(
      classifyMondayFailure("Unexpected token '<', \"<html>\" is not valid JSON"),
    ).toBe("ambiguous");
  });

  it("everything else defaults to ambiguous, even mentioning Monday mid-string", () => {
    expect(classifyMondayFailure("request to Monday failed")).toBe("ambiguous");
    expect(classifyMondayFailure("")).toBe("ambiguous");
  });
});

// ─────────────────────────────────────────────────────────────
// resolveCandidates — the ONE tie-break policy (finding 5)
// ─────────────────────────────────────────────────────────────

function cand(name: string, score: number, id = name): MondayItem {
  return { id, name, boardId: "6466800590", boardName: "Deals", score };
}

describe("resolveCandidates", () => {
  it("empty list → none", () => {
    expect(resolveCandidates([])).toEqual({ kind: "none" });
  });

  it("lone weak match (0.2) → none, even on the primary path", () => {
    expect(resolveCandidates([cand("Acme", 0.2)])).toEqual({ kind: "none" });
  });

  it("clean 0.9 over 0.5 → match", () => {
    const res = resolveCandidates([cand("Acme", 0.9), cand("Acme Two", 0.5)]);
    expect(res.kind).toBe("match");
    if (res.kind === "match") expect(res.top.name).toBe("Acme");
  });

  it("exact-score duplicates at 1.0 → ambiguous (kills the <0.8 escape)", () => {
    const res = resolveCandidates([
      cand("Kevin Stone", 1.0, "1"),
      cand("Kevin Stone", 1.0, "2"),
    ]);
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.candidates).toHaveLength(2);
  });

  it("runner-up inside the tie margin → ambiguous regardless of top score", () => {
    const res = resolveCandidates([cand("A", 0.95), cand("B", 0.85)]);
    expect(res.kind).toBe("ambiguous");
  });

  it("margin exactly at tieMargin is NOT a tie", () => {
    const res = resolveCandidates([cand("A", 0.9), cand("B", 0.75)]);
    expect(res.kind).toBe("match");
  });

  it("a sub-minScore runner-up cannot manufacture a tie", () => {
    const res = resolveCandidates([cand("A", 0.35), cand("B", 0.25)]);
    expect(res.kind).toBe("match");
    if (res.kind === "match") expect(res.top.name).toBe("A");
  });

  it("ambiguous set contains only viable (>= minScore) candidates, sorted", () => {
    const res = resolveCandidates([
      cand("Weak", 0.2),
      cand("B", 0.95),
      cand("A", 1.0),
    ]);
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      expect(res.candidates.map((c) => c.name)).toEqual(["A", "B"]);
    }
  });

  it("lone strong match → match", () => {
    const res = resolveCandidates([cand("Solo", 0.9)]);
    expect(res.kind).toBe("match");
  });

  it("honors custom thresholds", () => {
    expect(
      resolveCandidates([cand("A", 0.25)], { minScore: 0.2 }).kind,
    ).toBe("match");
    expect(
      resolveCandidates([cand("A", 0.9), cand("B", 0.7)], { tieMargin: 0.25 })
        .kind,
    ).toBe("ambiguous");
  });
});

describe("formatCandidateList / itemUrl", () => {
  it("lists board name and Monday URL per candidate", () => {
    const list = formatCandidateList([cand("Kevin Stone", 1.0, "42")]);
    expect(list).toContain("*Kevin Stone*");
    expect(list).toContain("(Deals)");
    expect(list).toContain(itemUrl("6466800590", "42"));
  });

  it("builds the canonical pulse URL", () => {
    expect(itemUrl("123", "456")).toBe(
      "https://oregonfivestar-company.monday.com/boards/123/pulses/456",
    );
  });
});
