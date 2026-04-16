# Marco — Decisions Log

Append-only record of architectural and trust decisions. Every entry: date, decision, rationale.

---

## 2026-04-15 — Initial bootstrap

**Decision:** Marco is a standalone Slack app in Oltre HQ, separate from the existing bot `U0ALQ669ATB`. New Bot Token, new Signing Secret, new identity.

**Rationale:** The existing Oltre HQ bot handles automation notifications. Marco handles conversational Q&A. Mixing the two would conflate trust postures — the automation bot runs pre-approved write tasks, Marco starts at Level 1 read-only.

---

## 2026-04-15 — Dedicated email deferred

**Decision:** Marco does NOT get a dedicated email address in this build. Slack is the exclusive channel.

**Rationale:** Klaus Phase 2 prescribes a dedicated Google Workspace account for the EA. For a team-facing company secretary, the cost (new domain user, forwarding rules, inbox management) exceeds the value in v1. Slack already reaches every stakeholder. Revisit if the team asks Marco questions outside Slack hours.

**Revisit trigger:** More than 3 instances of a team member emailing Andrew asking a question Marco could have answered.

---

## 2026-04-15 — Trigger.dev for webhook + heartbeat, not /loop

**Decision:** Marco's Slack inbound webhook runs as the Trigger.dev task `comms/marco-slack-inbound`. Overnight heartbeat runs as a Trigger.dev cron, not `/loop`.

**Rationale:** Aligns with the existing cron decision for the Oltre fleet (Q16). Trigger.dev gives us visibility, retries, and a single ops surface. `/loop` is fine for ad-hoc local work but not for a production Slack listener that needs 24/7 availability and audit logs.

---

## 2026-04-15 — Trust ladder frozen at Level 1 until Andrew promotes in writing

**Decision:** Marco ships at Level 1 (Read & Report) and stays there for a minimum of 2 weeks. Promotion to Level 2 requires Andrew to add an entry to this file that explicitly says "Marco is now Level 2 for Tier-1 drafts." No verbal promotions. No inferred promotions.

**Rationale:** The whole point of the ladder is that trust is earned through observable behavior. If Marco can self-promote or interpret casual remarks as promotions, the ladder is theater. Written decisions in this file are the only valid promotion path.

**Tier 2 ceiling:** Bella, Alex T., Alex P. stay at read-only forever. They never graduate to write access through Marco.

---

## 2026-04-15 — Locked answers to bootstrap CONFIRMs

Andrew's replies to the Phase-1 confirmations:

1. **Team morning brief delivery** → post to `#oltre-office` channel (not DMs). Channel is visible to the full team; keeps it lightweight.
2. **Alex Polkhovskiy tier** → Tier 2. Slack user ID `U04DKJV7SAV` (corrected from an initially-pasted DM channel ID).
3. **Slash command** → `/marco`.
4. **AFK handling for Tier-1 writes** → **async-with-catch-up, 12-hour draft expiry.** Marco drafts to `projects/drafts/`, DMs Andrew a preview immediately, sends when Andrew ✅s. If a draft is older than 12 hours when Andrew reacts, Marco re-confirms ("still want this? the context may be stale") before sending. Expired drafts move to `projects/drafts/expired/`.
5. **`deal-won-announce` skill** → **DROPPED.** Monday already handles this automation. Marco stays out of it. The skill file is not created.
6. **Avatar** → Marco generates a spec for the Oltre Craftsman brand (single cobalt accent on white) and Andrew or Alex renders it later. Not a launch blocker.
7. **GitHub repo** → authorized. Name: `marco-ea`. Private. Owner: Andrewoltreusa.
8. **FreshBooks creds** → reuse from `oltre-agents/.env`. Marco reads that `.env` at runtime; it does not copy credentials into its own repo.
9. **Trigger.dev project** → share existing project `proj_rfghiguuzwfekcixcuux` ("Oltre Castings & Design"). Marco's tasks live under a new `src/triggers/marco/` folder in the oltre-agents repo OR in Marco's own `src/triggers/` deployed to the same project — default to the latter unless deployment friction forces the former.

---

## 2026-04-15 — Phase 6a: Marco promoted to Level 2 (Draft & Wait)

**Decision:** Marco graduates from Level 1 (Read & Report) to Level 2 (Draft & Wait) six hours after going live. Both Tier 1 and Tier 2 users can now request Monday `create_update` writes through a draft → preview DM → ✅-reaction → execute flow. No other write mutations are allowed.

**Tier 1 (Andrew):** 12-hour draft TTL, signature freedom, re-confirm on drafts older than 12h at ✅ time.

**Tier 2 (Bella, Alex T., Alex P.):** 2-hour draft TTL, signature forced to `— {OwnName} via Marco` (no impersonation), expired drafts silently discarded, one active draft per user at a time.

**What's allowed:** `create_update` mutation on existing items in Deals (`6466800590`), Leads (`6466800613`), or Contacts (`6466800570`) only.

**What's still forbidden:** creating items, changing columns, moving items, deleting, writing to any other board, writing to any non-Monday system.

**Rationale:** Level 1 stubs proved the full plumbing works end-to-end in 6 hours. The 2-week freeze was insurance against unknown integration risk — that insurance paid out already. The "Tier 2 never writes" rule was designed before we had a signature-based attribution pattern; with `— {Name} via Marco` body signatures and the ✅-reaction gate, Tier 2 writes have the same audit trail and blast radius as Tier 2 users typing the update themselves, just faster.

**Full spec:** [decisions/2026-04-15-phase-6a-level-2.md](2026-04-15-phase-6a-level-2.md)

**Revisit trigger:** 2026-04-22 (7-day review), or immediately on first write error / misinterpretation.

---

## 2026-04-15 — Option A: Slack webhook front door lives in oltre-dashboard

**Decision:** The Slack Request URL points at a Node-runtime route in the oltre-dashboard Next.js app: `oltre-dashboard/app/api/marco/slack/route.ts`. That route verifies the Slack signature, handles the `url_verification` challenge inline, parses form-urlencoded (slash commands) vs JSON (events), and fires `tasks.trigger("comms/marco-slack-inbound", payload)` on the shared Trigger.dev project. The actual skill work runs inside the Trigger.dev task.

**Rationale:** Trigger.dev v4 tasks are not HTTP servers — they're invoked via `tasks.trigger()` from somewhere with a public URL. Three options were considered: (A) Node-runtime route in oltre-dashboard, (B) standalone Hono server on Fly/Railway, (C) add an HTTP server to oltre-agents. Andrew picked A: the original "don't touch oltre-dashboard" rule was about not needing a UI dashboard component, not about forbidding a forwarding route. This is the fastest path to live and reuses existing Vercel infra.

**What this costs:**
- One new file in oltre-dashboard: `app/api/marco/slack/route.ts` (~150 lines, auth + routing only, no business logic).
- One new dependency in oltre-dashboard: `@trigger.dev/sdk@4.4.3`.
- Three new env vars in Vercel + in the Trigger.dev project: `MARCO_SLACK_SIGNING_SECRET`, `MARCO_SLACK_BOT_TOKEN`, `TRIGGER_SECRET_KEY`.

**What this does NOT change:**
- Marco's identity, tasks, skills, and allowlist still live in `c:\Users\AndrewShpiruk\Oltre\Marco\`.
- The Trigger.dev task still does all the work. The dashboard route is ~50 executable lines.
- Marco's repo still has zero runtime imports from oltre-dashboard or oltre-agents.

---

## 2026-04-15 — Trigger.dev SDK bumped to 4.4.3

**Decision:** Marco initially scaffolded with `@trigger.dev/sdk@^3.0.0` (wrong — my default). Bumped to `4.4.3` to match oltre-agents. Renamed `src/triggers` → `src/tasks` to match oltre-agents convention. `trigger.config.ts` points `dirs: ["src/tasks"]`.

**Rationale:** Marco and oltre-agents share the Trigger.dev project `proj_rfghiguuzwfekcixcuux`. Aligned SDK versions prevent the two deploys from stepping on each other during runtime registration.

---

## 2026-04-15 — Outbound Slack client is standalone, zero imports from oltre-agents

**Decision:** `lib/slack.ts` reimplements the Slack Web API wrapper from scratch (copying the pattern from `oltre-agents/src/lib/slack.ts` but without sharing a module).

**Rationale:** Marco is a separate repo with its own deploy cadence. Importing from oltre-agents would couple two deploys and two dependency trees. The code is ~50 lines — duplication is cheaper than coupling.
