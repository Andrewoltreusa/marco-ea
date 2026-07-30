import { describe, it, expect } from "vitest";
import { anthropicCallBounds } from "./anthropic.js";

describe("anthropicCallBounds", () => {
  it("uses the full 45s timeout with one retry when no budget is active", () => {
    expect(anthropicCallBounds(Number.POSITIVE_INFINITY)).toEqual({
      timeoutMs: 45_000,
      maxRetries: 1,
    });
  });

  it("keeps the retry when the budget fits two attempts plus backoff", () => {
    // 45s timeout needs > 99s (2.2 ×) to justify a retry.
    expect(anthropicCallBounds(100_000)).toEqual({
      timeoutMs: 45_000,
      maxRetries: 1,
    });
  });

  it("drops the retry when the budget is tight", () => {
    expect(anthropicCallBounds(98_000)).toEqual({
      timeoutMs: 45_000,
      maxRetries: 0,
    });
  });

  it("shrinks the timeout to the remaining budget", () => {
    expect(anthropicCallBounds(20_000)).toEqual({
      timeoutMs: 20_000,
      maxRetries: 0,
    });
  });

  it("never lets the timeout fall below the 3s floor", () => {
    expect(anthropicCallBounds(500)).toEqual({
      timeoutMs: 3_000,
      maxRetries: 0,
    });
  });
});
