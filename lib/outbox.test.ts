import { describe, it, expect } from "vitest";
import {
  serializeOutboxEntry,
  parseOutboxEntry,
  triageOutboxEntry,
  outboxDoneKey,
  outboxStartedKey,
  OUTBOX_STALE_MS,
  OUTBOX_QUEUE_DELAY_MS,
  type OutboxEntry,
} from "./outbox.js";

const NOW = Date.parse("2026-07-30T12:00:00Z");

const entry: OutboxEntry = {
  lifecycleKey: "marco:evt:Ev123ABC",
  childRunId: "run_abc123",
  requester: "U077KFWGAPP",
  channel: "D0123456789",
  eventTs: "1753876800.000100",
  ts: "2026-07-30T11:50:00.000Z",
};

describe("outbox entry serialization", () => {
  it("round-trips through serialize → JSON.parse → parse", () => {
    const s = serializeOutboxEntry(entry);
    expect(parseOutboxEntry(JSON.parse(s))).toEqual(entry);
    expect(parseOutboxEntry(s)).toEqual(entry);
  });

  it("re-serializing a parsed entry reproduces the exact string (LREM match)", () => {
    // @upstash/redis auto-parses LRANGE elements; LREM matches by exact
    // string, so parse → serialize must be byte-identical to the LPUSH.
    const s = serializeOutboxEntry(entry);
    const parsed = parseOutboxEntry(JSON.parse(s));
    expect(parsed).not.toBeNull();
    expect(serializeOutboxEntry(parsed!)).toBe(s);
  });

  it("round-trips null lifecycleKey and eventTs", () => {
    const legacy: OutboxEntry = { ...entry, lifecycleKey: null, eventTs: null };
    const s = serializeOutboxEntry(legacy);
    const parsed = parseOutboxEntry(JSON.parse(s));
    expect(parsed).toEqual(legacy);
    expect(serializeOutboxEntry(parsed!)).toBe(s);
  });

  it("rejects garbage shapes", () => {
    expect(parseOutboxEntry(null)).toBeNull();
    expect(parseOutboxEntry("not json {")).toBeNull();
    expect(parseOutboxEntry(42)).toBeNull();
    expect(parseOutboxEntry({ requester: "U1" })).toBeNull(); // no childRunId
    expect(parseOutboxEntry({ ...entry, ts: undefined })).toBeNull();
  });
});

describe("outbox marker keys", () => {
  it("prefix the lifecycle key", () => {
    expect(outboxDoneKey("marco:evt:Ev123")).toBe(
      "marco:outbox-done:marco:evt:Ev123",
    );
    expect(outboxStartedKey("marco:evt:Ev123")).toBe(
      "marco:outbox-started:marco:evt:Ev123",
    );
  });
});

describe("watchdog triage", () => {
  const withAge = (ageMs: number): OutboxEntry => ({
    ...entry,
    ts: new Date(NOW - ageMs).toISOString(),
  });

  it("removes done entries immediately, at any age", () => {
    expect(
      triageOutboxEntry(withAge(1_000), { done: true, started: true }, NOW),
    ).toBe("remove_done");
    expect(
      triageOutboxEntry(withAge(60 * 60 * 1000), { done: true, started: false }, NOW),
    ).toBe("remove_done");
  });

  it("keeps a started child inside the 5-minute window", () => {
    expect(
      triageOutboxEntry(withAge(60_000), { done: false, started: true }, NOW),
    ).toBe("keep");
    expect(
      triageOutboxEntry(withAge(OUTBOX_STALE_MS), { done: false, started: true }, NOW),
    ).toBe("keep");
  });

  it("fails a started child past 5 minutes (died mid-run)", () => {
    expect(
      triageOutboxEntry(
        withAge(OUTBOX_STALE_MS + 1000),
        { done: false, started: true },
        NOW,
      ),
    ).toBe("fail");
  });

  it("keeps a never-started child up to 30 minutes (queue delay)", () => {
    expect(
      triageOutboxEntry(
        withAge(OUTBOX_STALE_MS + 1000),
        { done: false, started: false },
        NOW,
      ),
    ).toBe("keep");
    expect(
      triageOutboxEntry(
        withAge(OUTBOX_QUEUE_DELAY_MS),
        { done: false, started: false },
        NOW,
      ),
    ).toBe("keep");
  });

  it("fails a never-started child past 30 minutes", () => {
    expect(
      triageOutboxEntry(
        withAge(OUTBOX_QUEUE_DELAY_MS + 1000),
        { done: false, started: false },
        NOW,
      ),
    ).toBe("fail");
  });

  it("treats an unparseable ts as old (cannot prove youth)", () => {
    const bad: OutboxEntry = { ...entry, ts: "garbage" };
    expect(triageOutboxEntry(bad, { done: true, started: true }, NOW)).toBe(
      "remove_done",
    );
    expect(triageOutboxEntry(bad, { done: false, started: true }, NOW)).toBe("fail");
    expect(triageOutboxEntry(bad, { done: false, started: false }, NOW)).toBe("fail");
  });
});
