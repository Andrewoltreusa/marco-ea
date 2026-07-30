import { describe, it, expect } from "vitest";
import { classifyMondayFailure } from "./monday.js";

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
