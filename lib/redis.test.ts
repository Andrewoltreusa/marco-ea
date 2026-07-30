import { describe, it, expect } from "vitest";
import {
  buildTakeoverArgs,
  isStaleProcessing,
  userDraftPointerTs,
  DELEGATED_STALE_MS,
  type RequestState,
} from "./redis.js";

describe("takeover CAS arg construction", () => {
  const state: RequestState = {
    status: "processing",
    startedAt: "2026-07-30T12:00:00.000Z",
  };

  it("passes the exact startedAt read as the compare value", () => {
    const [expected] = buildTakeoverArgs("2026-07-30T11:00:00.000Z", state);
    expect(expected).toBe("2026-07-30T11:00:00.000Z");
  });

  it("serializes the new record exactly as @upstash/redis SET would", () => {
    // The client stores objects via JSON.stringify — the Lua script's SET
    // of ARGV[2] must produce a value redis().get() parses identically.
    const [, recordJson] = buildTakeoverArgs("x", state);
    expect(recordJson).toBe(JSON.stringify(state));
    expect(JSON.parse(recordJson)).toEqual(state);
  });

  it("carries the lifecycle TTL as a numeric string", () => {
    const [, , ttl] = buildTakeoverArgs("x", state);
    expect(ttl).toBe("900");
  });

  it("uses the empty sentinel for the missing-key claim path", () => {
    const [expected] = buildTakeoverArgs("", state);
    expect(expected).toBe("");
  });
});

describe("lifecycle staleness (F8 — delegated phase)", () => {
  const NOW = Date.parse("2026-07-30T12:00:00Z");
  const processing = (agoMs: number, phase?: "delegated"): RequestState => ({
    status: "processing",
    startedAt: new Date(NOW - agoMs).toISOString(),
    ...(phase ? { phase } : {}),
  });

  it("in-process claim goes stale after 120s", () => {
    expect(isStaleProcessing(processing(60_000), NOW)).toBe(false);
    expect(isStaleProcessing(processing(121_000), NOW)).toBe(true);
  });

  it("delegated claim survives well past 120s (child may take minutes)", () => {
    expect(isStaleProcessing(processing(121_000, "delegated"), NOW)).toBe(false);
    expect(isStaleProcessing(processing(10 * 60 * 1000, "delegated"), NOW)).toBe(
      false,
    );
  });

  it("delegated claim goes stale after 15 minutes", () => {
    expect(
      isStaleProcessing(processing(DELEGATED_STALE_MS + 1000, "delegated"), NOW),
    ).toBe(true);
  });

  it("unparseable startedAt is stale (a corrupt claim must not suppress redeliveries)", () => {
    expect(
      isStaleProcessing({ status: "processing", startedAt: "garbage" }, NOW),
    ).toBe(true);
  });
});

describe("tier-2 user-draft pointer decoding (F6)", () => {
  it("reads the object form and preserves trailing zeros", () => {
    // A bare numeric-string ts would be JSON.parsed to a NUMBER by
    // @upstash/redis and lose its trailing zero — the object wrapper
    // keeps it a string end to end.
    expect(userDraftPointerTs({ ts: "1753900000.123450" })).toBe(
      "1753900000.123450",
    );
  });

  it("treats reserving tokens as no-draft", () => {
    expect(userDraftPointerTs("reserving:run_abc123")).toBeNull();
    expect(userDraftPointerTs("reserving")).toBeNull();
  });

  it("coerces legacy bare values defensively", () => {
    expect(userDraftPointerTs("1753900000.123456")).toBe("1753900000.123456");
    expect(userDraftPointerTs(1753900000.12345)).toBe("1753900000.12345");
  });

  it("returns null for empty slots", () => {
    expect(userDraftPointerTs(null)).toBeNull();
    expect(userDraftPointerTs(undefined)).toBeNull();
    expect(userDraftPointerTs({ ts: null })).toBeNull();
    expect(userDraftPointerTs("")).toBeNull();
  });
});
