/**
 * Router unit tests. These are assertions the allowlist + classifier
 * must satisfy. If any of these fail, the deploy is blocked.
 *
 * Run via: `bun test` or `vitest run`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  routeInbound,
  classifyIntent,
  tier3ShouldPost,
  __resetTier3State,
} from "./router.js";
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
  it("routes cash questions to general-query (AR 2026 board dump)", () => {
    // Cash/AR routes to general-query on purpose — it injects the AR 2026
    // aggregates. The standalone cash-position skill was folded into
    // general-query when FreshBooks was removed (decisions/log.md 2026-04-17).
    expect(classifyIntent("what's AR at").skill).toBe("general-query");
    expect(classifyIntent("who owes us the most?").skill).toBe("general-query");
  });

  it("routes production ETA", () => {
    expect(classifyIntent("when does Schellenberg ship?").skill).toBe("production-eta");
  });

  it("strips trailing verbs from extracted subjects", () => {
    // "Schellenberg ship" would never fuzzy-match the board item.
    expect(classifyIntent("when does Schellenberg ship?").args.query).toBe(
      "Schellenberg",
    );
    expect(classifyIntent("when does Rivertop close?").args.query).toBe(
      "Rivertop",
    );
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

  it("routes dealer-process questions to kb-query, not lead-check", () => {
    expect(
      classifyIntent("I had a dealer just reply to me. What should I be doing?").skill,
    ).toBe("kb-query");
    expect(classifyIntent("has Amanda gotten back to us?").skill).toBe("lead-check");
  });

  it("routes objection quick-draw to kb-query", () => {
    expect(classifyIntent("objection: too expensive").skill).toBe("kb-query");
    expect(classifyIntent("Objection - they want to think about it").skill).toBe("kb-query");
  });

  it("routes how-to questions to kb-query", () => {
    expect(classifyIntent("how do we handle custom colors").skill).toBe("kb-query");
    expect(classifyIntent("how do I send a Sendblue follow-up").skill).toBe("kb-query");
    expect(classifyIntent("what's our brand voice for follow-ups").skill).toBe("kb-query");
  });

  it("routes explicit 'log on <item>' commands to monday-update", () => {
    // Live incident 2026-07: this exact phrasing hit the read path and
    // the model claimed a write it never performed.
    expect(classifyIntent("Log on C26100: pickup confirmed").skill).toBe(
      "monday-update",
    );
    expect(
      classifyIntent("log this on C26100 — installer confirmed pickup").skill,
    ).toBe("monday-update");
    expect(
      classifyIntent("log this against C26100: deposit received").skill,
    ).toBe("monday-update");
  });

  it("routes Russian 'запиши на' commands to monday-update", () => {
    expect(
      classifyIntent("запиши на C26100: самовывоз подтверждён").skill,
    ).toBe("monday-update");
  });

  it("read-noun override does not swallow explicit log commands", () => {
    // Body contains "the latest update" — the determiner+noun read
    // heuristic must not reroute an explicit log command.
    expect(
      classifyIntent(
        "Log on C26100: sent them the latest update from the installer",
      ).skill,
    ).toBe("monday-update");
  });

  it("still routes read-noun 'update' phrasings to general-query", () => {
    expect(classifyIntent("pull up the latest update on Rivertop").skill).toBe(
      "general-query",
    );
    // "the log on X" is a read of the updates feed, not a write.
    expect(classifyIntent("show me the log on C26100").skill).toBe(
      "general-query",
    );
  });

  it("routes board-aggregate questions to board-stats", () => {
    expect(classifyIntent("how many leads do we have?").skill).toBe(
      "board-stats",
    );
    expect(classifyIntent("how many deals are in the pipeline?").skill).toBe(
      "board-stats",
    );
    expect(classifyIntent("can you count the contacts?").skill).toBe(
      "board-stats",
    );
  });

  it("routes closing-this-week to board-stats with the raw query", () => {
    const r = classifyIntent("what deals are closing this week?");
    expect(r.skill).toBe("board-stats");
    expect(r.args.query).toBe("what deals are closing this week?");
  });

  it("falls back to general-query for non-process queries", () => {
    // find-in-vault was only ever a label for this path — the fallback
    // now says what actually runs (CODEX finding 19).
    expect(classifyIntent("random text about Alex").skill).toBe("general-query");
    expect(classifyIntent("what do we know about polymer sealants?").skill).toBe(
      "general-query",
    );
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

  it("Tier 3 second message within 24h → rate-limited refusal (in-memory fallback layer)", () => {
    // Process-local only: this Map verdict is the FALLBACK. The durable
    // cross-run 24h window is the inbound task's Redis SET NX on
    // marco:tier3:refused:<userId> — see tier3ShouldPost below.
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
    expect(r.skill).toBe("general-query");
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

describe("tier3ShouldPost (durable Redis gate + in-memory fallback)", () => {
  it("Redis SET won the 24h key → post, regardless of the Map", () => {
    expect(
      tier3ShouldPost({ inMemoryRateLimited: false, redisSetOk: true }),
    ).toBe(true);
    // Long-lived process where the Map remembers a refusal whose Redis
    // key has since expired: Redis is authoritative — 24h have passed.
    expect(
      tier3ShouldPost({ inMemoryRateLimited: true, redisSetOk: true }),
    ).toBe(true);
  });

  it("Redis key already held → silent, regardless of the Map", () => {
    // Fresh process (empty Map) but another run refused within 24h —
    // exactly the cross-run case the Map alone could never catch.
    expect(
      tier3ShouldPost({ inMemoryRateLimited: false, redisSetOk: false }),
    ).toBe(false);
    expect(
      tier3ShouldPost({ inMemoryRateLimited: true, redisSetOk: false }),
    ).toBe(false);
  });

  it("Redis unavailable → fall back to the router's in-memory verdict", () => {
    expect(
      tier3ShouldPost({ inMemoryRateLimited: false, redisSetOk: null }),
    ).toBe(true);
    expect(
      tier3ShouldPost({ inMemoryRateLimited: true, redisSetOk: null }),
    ).toBe(false);
  });
});
