# Marco — Decisions Log

Append-only record of architectural and trust decisions. Every entry: date, decision, rationale.

---

## 2026-07-14 (evening) — Andrew's content & destination rulings; KB goes to sales-ready

**Decisions (Andrew, verbal via chat):**
1. **All 12 roadmap items approved** — tracked in ROADMAP.md with per-item status.
2. **No posts to #oltre-office** — dry-run previews and (future) live briefs stay in Andrew's DM until he explicitly picks a destination channel.
3. **Dashboard "Today's focus" removed from the morning brief** — the /api/state currentFocus data is stale; the brief is Monday-boards-only.
4. **"Installed" is a terminal production status** — ship date is interchangeable with install date; Installed items past their ship date are done, not flagged (fix was already live in v20260714.4's DONE_STATUS list).
5. **No church/KJV/personal content in Marco, anywhere** — Marco is a work app. Purged from the live KB: the KJV brand-voice rule, the KJV glossary entry, three "Andrew Personal Tasks" glossary rows; two personal phrasings rephrased. (The vault's KJV house rule still applies to non-Marco Oltre content work.)
6. **KB now carries the sales canon** — sections 17-24 (ICP + selling principles, phone inquiry flow, 3A objection playbook, tier ladder w/ pending-review caveat, cadence v3 supersession, production-to-delivery office SOP, dealer program overview, dealer reply workflow) ingested from the canonical sources and verified live.
7. **Contacts→Deals resolution follows relation columns** — deals are named by code, so deal-status now walks `contact_deal` links (getLinkedItems) instead of declaring "no deal found" (the Kevin Stone bug).
8. **Dealer-process questions route to the KB**, not lead-check (live misroute 2026-07-14: "a dealer just replied, what should I do?" matched lead-check's "reply" keyword).

---

## 2026-07-14 — Await-the-trigger fix, Redis-not-files, model tiering, broadcast implementation

**Decision (root-cause fix):** The Vercel webhook must `await` every `tasks.trigger()` call. The fire-and-forget pattern froze the un-sent HTTP call with the lambda when the response returned — the root cause of Marco's "30-minute or never" replies (verified live: a 17:12Z DM produced its Trigger.dev run at 17:25:25Z, 2ms after a diagnostic GET thawed the instance). All three trigger sites now awaited with `idempotencyKey` (15m TTL); enqueue failures notify the user via `after()`; reaction events are filtered to draft-approval emojis route-side.

**Decision (UX):** Marco acks every Tier-1/2 DM/mention with 👀 within ~2-3s (task start), swapping to ✅ on answer, ⚠️ on error, 📝 when a draft preview is coming. Tier-3 messages are never reacted to.

**Decision (runtime state):** All runtime artifacts live in Upstash Redis, never local files — Trigger.dev cloud's filesystem is ephemeral, which is why `memory/` and `deliverables/` stayed empty for three months. Keys: `marco:deliverable:*` (30d TTL), `marco:log:access-denials` / `marco:log:write-incidents` (LPUSH, cap 500), `marco:prodalert:*` (24h dedup), `marco:evt:*` (15m inbound dedup).

**Decision (models):** Tiered — `claude-haiku-4-5` for extraction/intent parsing (Russian spot-check passed before the swap), `claude-sonnet-5` with thinking explicitly disabled for composition/KB/brief, Opus-class reserved for future SWOT/rollup synthesis. Voice is load-bearing: any future model change must re-run the Russian write-intent spot-check and a tone check.

**Decision (retries):** `maxAttempts: 1` on inbound/reaction/draft tasks — platform retries risk double-posts/double-writes; the in-code never-silent catches own error surfacing. Scheduled tasks keep the global default except production-alert (spec forbids in-slot retries).

**Decision (broadcasts):** `comms/marco-production-alert` and `comms/marco-team-morning-brief` implemented as Trigger.dev cron tasks, deployed with `DRY_RUN=1` (Andrew previews via DM). Flip `DRY_RUN=0` in the Trigger.dev prod env after a clean preview cycle; morning brief also needs `MARCO_OFFICE_CHANNEL_ID` set once Marco is invited to #oltre-office.

**Decision (research verdicts, from the 2026-07-14 research round):** Keep building Marco rather than buying Viktor (no per-user tiers, no Monday support, unpredictable credit costs; Marco is Uplift AI's reference architecture). Do NOT move the KB to Notion — cache-first Redis makes source latency irrelevant; humans edit in Monday, Marco reads from cache. No replatform off Vercel+Trigger.dev — adopt Slack's native AI-app primitives (assistant pane, streaming, Block Kit approval buttons) in a follow-up phase.

**Rationale:** See the plan + verification evidence in the 2026-07-14 session; latency went from 13+ minutes (or never) to 3-12s end-to-end, verified against production with signed synthetic events.

---

## 2026-04-17 — FreshBooks removed, Monday AR 2026 is source of truth for cash/AR

**Decision:** Marco no longer references FreshBooks (or Xero, QuickBooks) in any answer. The Monday AR 2026 board (`18393591112`) is the single authoritative source for all financial questions: cash position, AR, contracted amounts, invoiced amounts, payments, remaining balance.

**Rationale:** FreshBooks is invoicing software only, its API is unreliable, and — critically — Shopify orders land in Monday, not FreshBooks. FreshBooks doesn't have the full picture. Monday AR 2026 is the authoritative record. Previously Marco's system prompt said "Accounting / invoicing / cash / AR → FreshBooks" which caused Marco to redirect financial questions away from the answer.

**What changed in code:**
- `lib/monday.ts`: added `getBoardItems()` to dump an entire board with column values (needed for aggregate questions).
- `src/skills/general-query.ts`:
  - Added `isFinancialQuestion()` detector.
  - Added AR_2026 to `ALL_SEARCH_BOARDS` for per-entity search.
  - When the question is financial, injects the full AR 2026 board as context into Claude's prompt so aggregate questions (monthly contracted totals, etc.) can be answered.
  - System prompt rewritten: Monday AR 2026 is the source of truth for cash/AR, FreshBooks is never mentioned.
- `src/slack/router.ts`: Cash/AR/contracted/invoiced/balance keywords now route directly to `general-query` (not the dead-end `cash-position` skill) so they pick up the AR board dump.
- `COMPANY.md`: FreshBooks row removed from "Systems I read" table.

**Revisit trigger:** FreshBooks API becomes reliable AND we need data that's not in Monday. Until then, stay Monday-only.

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
