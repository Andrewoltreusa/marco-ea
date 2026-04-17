/**
 * Router unit tests. These are assertions the allowlist + classifier
 * must satisfy. If any of these fail, the deploy is blocked.
 *
 * Run via: `bun test` or `vitest run`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { routeInbound, classifyIntent, __resetTier3State } from "./router.js";
import { tierFor } from "./allowlist.js";

describe("allowlist", () => {
  it("Andrew is Tier 1", () => {
    expect(tierFor("U04D9BPK8H2")).toBe(1);
  });

  it("Bella, Alex T., Alex P. are Tier 2", () => {
    expect(tierFor("U077KFWGAPP")).toBe(2);
    expect(tierFor("U04J52R155H")).toBe(2);
    expect(tierFor("U04DKJV7SAV")).toBe(2);
  });

  it("Oltre HQ bot is Tier 3 (never promoted)", () => {
    expect(tierFor("U0ALQ669ATB")).toBe(3);
  });

  it("unknown user is Tier 3", () => {
    expect(tierFor("U000000RANDOM")).toBe(3);
  });
});

describe("classifier", () => {
  it("routes cash questions", () => {
    expect(classifyIntent("what's AR at").skill).toBe("cash-position");
    expect(classifyIntent("who owes us the most?").skill).toBe("cash-position");
  });

  it("routes production ETA", () => {
    expect(classifyIntent("when does Schellenberg ship?").skill).toBe("production-eta");
  });

  it("routes lead check", () => {
    expect(classifyIntent("has Amanda gotten back to us?").skill).toBe("lead-check");
  });

  it("routes fleet health", () => {
    expect(classifyIntent("is anything broken").skill).toBe("agent-fleet-health");
  });

  it("routes deal status", () => {
    expect(classifyIntent("what's the status of Rivertop").skill).toBe("deal-status");
  });

  it("routes how-to questions to kb-query", () => {
    expect(classifyIntent("how do we handle custom colors").skill).toBe("kb-query");
    expect(classifyIntent("how do I send a Sendblue follow-up").skill).toBe("kb-query");
    expect(classifyIntent("what's our brand voice for church work").skill).toBe("kb-query");
  });

  it("falls back to vault search for non-process queries", () => {
    // Use a phrase that doesn't match any process keyword.
    expect(classifyIntent("random text about Alex").skill).toBe("find-in-vault");
  });
});

describe("router tier gating", () => {
  beforeEach(() => __resetTier3State());

  it("Tier 3 first message → refuse (not rate-limited)", () => {
    const r = routeInbound({
      slackUserId: "U000000RANDOM",
      channel: "D123",
      text: "hi",
      isDM: true,
    });
    expect(r.skill).toBe("refuse");
    expect(r.tier).toBe(3);
    expect(r.rateLimited).toBe(false);
  });

  it("Tier 3 second message within 24h → rate-limited refusal", () => {
    const evt = {
      slackUserId: "U000000RANDOM",
      channel: "D123",
      text: "hi",
      isDM: true,
    };
    routeInbound(evt);
    const second = routeInbound(evt);
    expect(second.skill).toBe("refuse");
    expect(second.rateLimited).toBe(true);
  });

  it("Andrew routes to a real skill, not refuse", () => {
    const r = routeInbound({
      slackUserId: "U04D9BPK8H2",
      channel: "D123",
      text: "cash",
      isDM: true,
    });
    expect(r.skill).toBe("cash-position");
    expect(r.tier).toBe(1);
  });

  it("Bella can query, stays Tier 2", () => {
    const r = routeInbound({
      slackUserId: "U077KFWGAPP",
      channel: "D123",
      text: "when does Schellenberg ship?",
      isDM: true,
    });
    expect(r.skill).toBe("production-eta");
    expect(r.tier).toBe(2);
  });
});
