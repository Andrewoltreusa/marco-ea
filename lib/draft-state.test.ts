import { describe, it, expect } from "vitest";
import {
  decideReaction,
  decideReconcileAbsent,
  computeBodyHash,
  normalizeUpdateBody,
  sanitizeSlackMarkup,
  matchUpdateBody,
  slackTsToMs,
  EXECUTING_STALE_MS,
  RECONFIRM_AGE_MS,
  RECONCILE_MIN_AGE_MS,
  type DraftState,
} from "./draft-state.js";

const NOW = Date.parse("2026-07-30T12:00:00Z");

function state(
  s: DraftState["state"],
  opts: { atAgoMs?: number; reconfirmedAt?: string } = {},
): Pick<DraftState, "state" | "at" | "reconfirmedAt"> {
  return {
    state: s,
    at: new Date(NOW - (opts.atAgoMs ?? 1000)).toISOString(),
    reconfirmedAt: opts.reconfirmedAt,
  };
}

function draft(opts: { tier?: 1 | 2; ageMs?: number } = {}) {
  return {
    createdAt: new Date(NOW - (opts.ageMs ?? 60_000)).toISOString(),
    requesterTier: opts.tier ?? 2,
  };
}

describe("decideReaction transition table", () => {
  // ─── pending ───────────────────────────────────────────────
  it("pending + reject → cancel", () => {
    expect(decideReaction(state("pending"), draft(), "reject", NOW)).toEqual({
      action: "cancel",
    });
  });

  it("pending + approve (fresh draft) → execute", () => {
    expect(decideReaction(state("pending"), draft(), "approve", NOW)).toEqual({
      action: "execute",
    });
  });

  it("pending + approve, Tier 1, >=12h, unconfirmed → reconfirm", () => {
    const d = draft({ tier: 1, ageMs: RECONFIRM_AGE_MS + 1000 });
    expect(decideReaction(state("pending"), d, "approve", NOW)).toEqual({
      action: "reconfirm",
    });
  });

  it("pending + approve, Tier 1, >=12h, already reconfirmed → execute", () => {
    const d = draft({ tier: 1, ageMs: RECONFIRM_AGE_MS + 1000 });
    const s = state("pending", { reconfirmedAt: new Date(NOW).toISOString() });
    expect(decideReaction(s, d, "approve", NOW)).toEqual({ action: "execute" });
  });

  // F9: the second ✅ must be a strictly newer EVENT than the stamp.
  it("reconfirmed + eventTs newer than the stamp → execute", () => {
    const d = draft({ tier: 1, ageMs: RECONFIRM_AGE_MS + 1000 });
    const s = state("pending", {
      reconfirmedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(decideReaction(s, d, "approve", NOW, NOW - 30_000)).toEqual({
      action: "execute",
    });
  });

  it("reconfirmed + replayed stamping event (eventTs == stamp) → reconfirm again, never execute", () => {
    const stamp = NOW - 60_000;
    const d = draft({ tier: 1, ageMs: RECONFIRM_AGE_MS + 1000 });
    const s = state("pending", {
      reconfirmedAt: new Date(stamp).toISOString(),
    });
    expect(decideReaction(s, d, "approve", NOW, stamp)).toEqual({
      action: "reconfirm",
    });
  });

  it("reconfirmed + eventTs older than the stamp → reconfirm again", () => {
    const stamp = NOW - 60_000;
    const d = draft({ tier: 1, ageMs: RECONFIRM_AGE_MS + 1000 });
    const s = state("pending", {
      reconfirmedAt: new Date(stamp).toISOString(),
    });
    expect(decideReaction(s, d, "approve", NOW, stamp - 5_000)).toEqual({
      action: "reconfirm",
    });
  });

  it("reconfirmed + missing eventTs (legacy route) → execute (pre-gate behavior)", () => {
    const d = draft({ tier: 1, ageMs: RECONFIRM_AGE_MS + 1000 });
    const s = state("pending", {
      reconfirmedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(decideReaction(s, d, "approve", NOW, null)).toEqual({
      action: "execute",
    });
  });

  it("pending + approve, Tier 1, just under 12h → execute", () => {
    const d = draft({ tier: 1, ageMs: RECONFIRM_AGE_MS - 1000 });
    expect(decideReaction(state("pending"), d, "approve", NOW)).toEqual({
      action: "execute",
    });
  });

  it("pending + approve, Tier 2 old draft → execute (no re-confirm tier gate)", () => {
    const d = draft({ tier: 2, ageMs: RECONFIRM_AGE_MS + 1000 });
    expect(decideReaction(state("pending"), d, "approve", NOW)).toEqual({
      action: "execute",
    });
  });

  // ─── executing ─────────────────────────────────────────────
  it("executing (fresh) + approve → already_processing reply", () => {
    const s = state("executing", { atAgoMs: 5_000 });
    expect(decideReaction(s, draft(), "approve", NOW)).toEqual({
      action: "reply",
      reply: "already_processing",
    });
  });

  it("executing (stale — owner died) + approve → reconcile", () => {
    const s = state("executing", { atAgoMs: EXECUTING_STALE_MS + 1000 });
    expect(decideReaction(s, draft(), "approve", NOW)).toEqual({
      action: "reconcile",
    });
  });

  it("executing with unparseable at + approve → reconcile (treated stale)", () => {
    const s = { state: "executing" as const, at: "garbage" };
    expect(decideReaction(s, draft(), "approve", NOW)).toEqual({
      action: "reconcile",
    });
  });

  it("executing + reject → executing_cannot_cancel reply (fresh and stale)", () => {
    const fresh = state("executing", { atAgoMs: 5_000 });
    const stale = state("executing", { atAgoMs: EXECUTING_STALE_MS + 1000 });
    expect(decideReaction(fresh, draft(), "reject", NOW)).toEqual({
      action: "reply",
      reply: "executing_cannot_cancel",
    });
    expect(decideReaction(stale, draft(), "reject", NOW)).toEqual({
      action: "reply",
      reply: "executing_cannot_cancel",
    });
  });

  // ─── posted ────────────────────────────────────────────────
  it("posted + approve/reject → already_posted reply", () => {
    expect(decideReaction(state("posted"), draft(), "approve", NOW)).toEqual({
      action: "reply",
      reply: "already_posted",
    });
    expect(decideReaction(state("posted"), draft(), "reject", NOW)).toEqual({
      action: "reply",
      reply: "already_posted",
    });
  });

  // ─── cancelled ─────────────────────────────────────────────
  it("cancelled + approve/reject → already_cancelled reply", () => {
    expect(decideReaction(state("cancelled"), draft(), "approve", NOW)).toEqual({
      action: "reply",
      reply: "already_cancelled",
    });
    expect(decideReaction(state("cancelled"), draft(), "reject", NOW)).toEqual({
      action: "reply",
      reply: "already_cancelled",
    });
  });

  // ─── unknown ───────────────────────────────────────────────
  it("unknown + approve/reject → reconcile", () => {
    expect(decideReaction(state("unknown"), draft(), "approve", NOW)).toEqual({
      action: "reconcile",
    });
    expect(decideReaction(state("unknown"), draft(), "reject", NOW)).toEqual({
      action: "reconcile",
    });
  });

  // F4: the found-path posted transition carries an expectedAt CAS; a
  // lost race re-reads and re-decides. These are the only legal landing
  // decisions — never a second posted stamp over a fresher state.
  it("F4 lost-CAS landings: posted → already_posted, fresh executing → already_processing / cannot_cancel", () => {
    expect(decideReaction(state("posted"), draft(), "approve", NOW)).toEqual({
      action: "reply",
      reply: "already_posted",
    });
    const fresh = state("executing", { atAgoMs: 5_000 });
    expect(decideReaction(fresh, draft(), "approve", NOW)).toEqual({
      action: "reply",
      reply: "already_processing",
    });
    expect(decideReaction(fresh, draft(), "reject", NOW)).toEqual({
      action: "reply",
      reply: "executing_cannot_cancel",
    });
  });
});

describe("computeBodyHash", () => {
  it("is a stable sha256 hex of itemId + body", () => {
    const h = computeBodyHash("123", "Called them.\n\n— Bella via Marco");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeBodyHash("123", "Called them.\n\n— Bella via Marco")).toBe(h);
  });

  it("changes when itemId or body changes", () => {
    const h = computeBodyHash("123", "body");
    expect(computeBodyHash("124", "body")).not.toBe(h);
    expect(computeBodyHash("123", "body.")).not.toBe(h);
  });
});

describe("reconciliation matcher", () => {
  const createdAt = "2026-07-30T12:00:00Z";
  const body = "Spoke with them today.\n\n— Bella via Marco";

  it("matches on normalized whitespace equality within the window", () => {
    const updates = [
      {
        id: "u1",
        text_body: "Spoke with them today. — Bella via Marco",
        created_at: "2026-07-30T12:01:00Z",
      },
    ];
    expect(matchUpdateBody(updates, body, createdAt)).toEqual({ id: "u1" });
  });

  it("normalizes runs of whitespace and trims", () => {
    expect(normalizeUpdateBody("  a \n\n b\t c  ")).toBe("a b c");
  });

  it("rejects a different body", () => {
    const updates = [
      { id: "u1", text_body: "Something else", created_at: "2026-07-30T12:01:00Z" },
    ];
    expect(matchUpdateBody(updates, body, createdAt)).toBeNull();
  });

  it("rejects an identical update created before the slack window", () => {
    const updates = [
      {
        id: "old",
        text_body: body,
        created_at: "2026-07-30T11:50:00Z", // 10 min before createdAt
      },
    ];
    expect(matchUpdateBody(updates, body, createdAt)).toBeNull();
  });

  it("accepts an update created just inside the 5-minute slack", () => {
    const updates = [
      { id: "u1", text_body: body, created_at: "2026-07-30T11:56:00Z" },
    ];
    expect(matchUpdateBody(updates, body, createdAt)).toEqual({ id: "u1" });
  });

  it("skips updates with unparseable created_at", () => {
    const updates = [{ id: "u1", text_body: body, created_at: "not-a-date" }];
    expect(matchUpdateBody(updates, body, createdAt)).toBeNull();
  });

  it("returns the first matching update among several", () => {
    const updates = [
      { id: "u0", text_body: "noise", created_at: "2026-07-30T12:02:00Z" },
      { id: "u1", text_body: body, created_at: "2026-07-30T12:01:00Z" },
      { id: "u2", text_body: body, created_at: "2026-07-30T12:00:30Z" },
    ];
    expect(matchUpdateBody(updates, body, createdAt)).toEqual({ id: "u1" });
  });

  it("never matches when the draft createdAt is unparseable", () => {
    const updates = [
      { id: "u1", text_body: body, created_at: "2026-07-30T12:01:00Z" },
    ];
    expect(matchUpdateBody(updates, body, "garbage")).toBeNull();
  });

  // F1b: Monday HTML-sanitizes tag-like tokens out of text_body.
  it("matches a legacy body with Slack link markup against a sanitized text_body", () => {
    const legacyBody =
      "See <https://x.com/q|quote> for detail.\n\n— Bella via Marco";
    const updates = [
      {
        id: "u1",
        // Monday removed the whole <...> token.
        text_body: "See for detail. — Bella via Marco",
        created_at: "2026-07-30T12:01:00Z",
      },
    ];
    expect(matchUpdateBody(updates, legacyBody, createdAt)).toEqual({ id: "u1" });
  });

  it("matches when Monday entity-encodes an ampersand", () => {
    const ampBody = "Called AT&T about the order.\n\n— Bella via Marco";
    const updates = [
      {
        id: "u1",
        text_body: "Called AT&amp;T about the order. — Bella via Marco",
        created_at: "2026-07-30T12:01:00Z",
      },
    ];
    expect(matchUpdateBody(updates, ampBody, createdAt)).toEqual({ id: "u1" });
  });
});

describe("normalizeUpdateBody HTML hardening (F1b)", () => {
  it("strips tag-like tokens on either side", () => {
    expect(normalizeUpdateBody("a <https://x.com|link> b")).toBe("a b");
    expect(normalizeUpdateBody("a <p>b</p> c")).toBe("a b c");
  });

  it("decodes named and numeric entities", () => {
    expect(normalizeUpdateBody("AT&amp;T &quot;quote&quot; it&#39;s")).toBe(
      'AT&T "quote" it\'s',
    );
    expect(normalizeUpdateBody("caf&#233; &#x2014; open")).toBe("café — open");
  });

  it("decodes double-encoded ampersands one level only", () => {
    expect(normalizeUpdateBody("&amp;lt;")).toBe("&lt;");
  });

  it("collapses whitespace after stripping and decoding", () => {
    expect(normalizeUpdateBody("  a\n\n<b>   c&nbsp;&nbsp;d ")).toBe("a c d");
  });
});

describe("sanitizeSlackMarkup (F1a, compose-time)", () => {
  it("unwraps a labeled Slack link into label (url)", () => {
    expect(sanitizeSlackMarkup("see <https://x.com/q|quote> today")).toBe(
      "see quote (https://x.com/q) today",
    );
  });

  it("unwraps a bare wrapped URL", () => {
    expect(sanitizeSlackMarkup("docs at <https://x.com/docs>")).toBe(
      "docs at https://x.com/docs",
    );
  });

  it("collapses a self-labeled mailto to just the address", () => {
    expect(sanitizeSlackMarkup("email <mailto:a@b.com|a@b.com>")).toBe(
      "email a@b.com",
    );
  });

  it("drops brackets on any other wrapped token", () => {
    expect(sanitizeSlackMarkup("ping <@U04D9BPK8H2> and <!here>")).toBe(
      "ping @U04D9BPK8H2 and !here",
    );
  });

  it("leaves plain text untouched", () => {
    const s = "Spoke with them today. Sending contract Friday.";
    expect(sanitizeSlackMarkup(s)).toBe(s);
  });

  it("produces a tag-free body (sanitizer-stable for Monday)", () => {
    const out = sanitizeSlackMarkup(
      "quote <https://x.com/q|here>, docs <https://x.com/d> <@U1>",
    );
    expect(out).not.toMatch(/[<>]/);
  });
});

describe("decideReconcileAbsent cool-down (F2)", () => {
  const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();

  it("young unknown state → settling (no retry, no cancel)", () => {
    expect(decideReconcileAbsent(at(10_000), NOW)).toBe("settling");
    expect(decideReconcileAbsent(at(RECONCILE_MIN_AGE_MS - 1), NOW)).toBe(
      "settling",
    );
  });

  it("state at or past the 120s cool-down → retry allowed", () => {
    expect(decideReconcileAbsent(at(RECONCILE_MIN_AGE_MS), NOW)).toBe("retry");
    expect(decideReconcileAbsent(at(10 * 60 * 1000), NOW)).toBe("retry");
  });

  it("stale-executing entry ages (>=180s) always clear the gate", () => {
    expect(decideReconcileAbsent(at(EXECUTING_STALE_MS + 1000), NOW)).toBe(
      "retry",
    );
  });

  it("unparseable stamp → retry (a corrupt stamp must not deadlock the draft)", () => {
    expect(decideReconcileAbsent("garbage", NOW)).toBe("retry");
  });
});

describe("slackTsToMs", () => {
  it("converts Slack seconds.micros to epoch ms", () => {
    expect(slackTsToMs("1753900000.123456")).toBeCloseTo(1753900000123.456, 2);
  });

  it("returns null for missing or unparseable values", () => {
    expect(slackTsToMs(undefined)).toBeNull();
    expect(slackTsToMs(null)).toBeNull();
    expect(slackTsToMs("")).toBeNull();
    expect(slackTsToMs("not-a-ts")).toBeNull();
  });
});
