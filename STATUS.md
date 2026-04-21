# Marco — STATUS.md (pickup doc)

Last updated: **2026-04-21**. Read this first if you're picking up Marco development.

The three identity files ([SOUL.md](SOUL.md) / [COMPANY.md](COMPANY.md) / [AGENTS.md](AGENTS.md)) say who Marco is. This file says **what's built, what works, what's next, and where to look when something breaks**.

---

## Current deploy

| | |
|---|---|
| Trigger.dev staging | `v20260421.3` |
| Trigger.dev prod | **not yet promoted** — staging only |
| GitHub `main` | commit `d7ec542` |
| Trigger.dev project | `proj_rfghiguuzwfekcixcuux` (shared with oltre-agents) |
| Slack app | `A0ASRRXM7MM` in Oltre HQ |
| Vercel route | `https://oltre-dashboard.vercel.app/api/marco/slack` |

## What works today (verified in staging)

### Reads
- `/m` slash command — fast path for short queries
- DMs to the Marco app — long path for natural questions
- Five keyword-classified skills:
  - `deal-status` — Monday Deals + OCD Schedule + Contacts, 3-sentence summary with Monday link
  - `production-eta` — OCD Schedule, flags red items
  - `lead-check` — Monday Leads, flags stale leads >7 days
  - `agent-fleet-health` — Dashboard `/api/state`
  - `general-query` (the Claude fallback) — handles everything the keyword router misses
- Financial questions (cash, AR, contracted, invoiced, balance) — pre-computed aggregates from Monday AR 2026 board injected into Claude prompt; reports Total / By Status / By Month
- Per-DM conversation memory — 5 turns, 30m TTL in Upstash Redis; pronouns like "her" / "that project" resolve from prior turn
- Russian input — router catches Russian write keywords, all Claude prompts reply in English

### Writes (Level 2)
- `create_update` mutation on Monday Deals / Leads / Contacts boards
- Draft flow: parse → fuzzy match → preview DM → ✅-reaction → Monday write → confirmation
- Tier 1 (Andrew): 12h draft TTL, signature freedom
- Tier 2 (Bella / Alex T. / Alex P.): 2h TTL, forced `— Name via Marco` signature, one active draft at a time
- Russian input: `parseWriteIntent` translates Russian → English in the draft body

### Never-silent guarantees
Every error path now posts a visible message instead of letting Trigger.dev retry silently:
- Inbound task `runSkill()` → "I hit a snag running [skill]..."
- Inbound task `tasks.trigger()` for draft → "I couldn't kick off the draft..."
- Draft task full pipeline → "I hit a snag drafting that update..."
- Empty-text responses get a generic fallback

### Diagnostic
Hit `https://oltre-dashboard.vercel.app/api/marco/slack` in a browser any time Marco seems stuck. Returns JSON with env var presence, Vercel deployment id, and a live `tasks.trigger()` result. Takes ~3 seconds. Use before blaming code.

## Critical file map

### Identity / docs
- [SOUL.md](SOUL.md) — who Marco is
- [COMPANY.md](COMPANY.md) — who Marco serves (Oltre Castings & Design profile)
- [AGENTS.md](AGENTS.md) — operating manual + vault reading protocol
- [CLAUDE.md](CLAUDE.md) — Claude Code session index (<200 lines)
- [INSTALL.md](INSTALL.md) — Slack app + Trigger.dev env setup
- [.claude/rules/slack-allowlist.md](.claude/rules/slack-allowlist.md) — tiered Slack access (NON-NEGOTIABLE)

### Decisions log
- [decisions/log.md](decisions/log.md) — chronological architecture decisions
- [decisions/2026-04-15-phase-6a-level-2.md](decisions/2026-04-15-phase-6a-level-2.md) — Level 2 write policy spec
- Session notes in vault: `Oltre Vault/clients/oltre-castings/sessions/conversation-notes/2026-04-15 Marco Build + Phase 6a Level 2.md` and `2026-04-21 Marco Phase 6b + Polish.md`

### Code — libs
- [lib/slack.ts](lib/slack.ts) — outbound Slack Web API (zero imports from oltre-agents)
- [lib/redis.ts](lib/redis.ts) — Upstash client + draft storage with tier-based TTLs
- [lib/anthropic.ts](lib/anthropic.ts) — `parseWriteIntent()` — Claude call that extracts target + content from natural-language write intents (handles English + Russian → English)
- [lib/monday.ts](lib/monday.ts) — Monday client: fuzzy search, full board dump, `create_update` mutation, column collision handling
- [lib/conversation.ts](lib/conversation.ts) — per-DM Redis conversation history for general-query
- [lib/marco-persona.ts](lib/marco-persona.ts) — shared system-prompt persona (used by kb-query, can be used by future skills)
- [lib/kb.ts](lib/kb.ts) — knowledge base loader (for kb-query, feature-flagged with `ENABLE_KB=true`)

### Code — router
- [src/slack/router.ts](src/slack/router.ts) — tier check + `classifyIntent()` with write-intent-first-then-read-noun-override-then-keyword ordering
- [src/slack/allowlist.ts](src/slack/allowlist.ts) — compiled allowlist (mirror of `.claude/rules/slack-allowlist.md`)
- [src/slack/router.test.ts](src/slack/router.test.ts) — unit tests for allowlist + classifier + tier-3 rate limiter

### Code — tasks (Trigger.dev)
- [src/tasks/marco-slack-inbound.ts](src/tasks/marco-slack-inbound.ts) — receives normalized events from Vercel route, dispatches to skills, delegates write intents to draft task, wraps everything in try/catch
- [src/tasks/marco-monday-update-draft.ts](src/tasks/marco-monday-update-draft.ts) — Claude parse → Monday fuzzy match → preview DM → Redis draft storage
- [src/tasks/marco-reaction-handler.ts](src/tasks/marco-reaction-handler.ts) — listens for `reaction_added`, verifies reactor + ✅ + TTL, executes Monday write
- [src/tasks/marco-heartbeat.ts](src/tasks/marco-heartbeat.ts) — scheduled cron (not yet wired to real work)

### Code — skills
- [src/skills/deal-status.ts](src/skills/deal-status.ts)
- [src/skills/production-eta.ts](src/skills/production-eta.ts)
- [src/skills/lead-check.ts](src/skills/lead-check.ts)
- [src/skills/agent-fleet-health.ts](src/skills/agent-fleet-health.ts)
- [src/skills/general-query.ts](src/skills/general-query.ts) — the Claude-powered fallback with AR aggregates, conversation memory, multi-term search
- [src/skills/kb-query.ts](src/skills/kb-query.ts) — knowledge-base lookup (feature-flagged)

### External (not in this repo)
- `oltre-dashboard/app/api/marco/slack/route.ts` — Vercel Node-runtime webhook; GET = diagnostic, POST = verify → dispatch to Trigger.dev. Lives at `c:\Users\AndrewShpiruk\Oltre\oltre-dashboard\`. See the 2026-04-15 Option A decision.

---

## Open backlog (in priority order)

### Should build next

1. **Disambiguation resumption in draft task.**
   - When Marco offers "1. Brooke Bundy / 2. Brooke Aquino / 3. Rebecca Fraser" and the user replies `1`, Marco currently treats it as a fresh message.
   - Fix: persist the candidate list in Redis on the ambiguous-match branch; next message from the same user checks for a pending candidate list and handles numeric / name-match selection.
   - Effort: ~45 min.
   - Files: `src/tasks/marco-monday-update-draft.ts`, `lib/redis.ts` (new `storeCandidateList` / `getActiveCandidateList`).

2. **Conversation memory for keyword-matched skills.**
   - "What's the status of Schellenberg?" → "When does he ship?" — second message currently routes to `production-eta` with `query="he"` and fails.
   - Fix option A: extend conversation memory to all skills (pass prior turn to each skill's search).
   - Fix option B: detect pronouns in the router and always route pronoun-containing messages through `general-query`.
   - Recommend B — cleaner and leverages what we already built.
   - Effort: ~30 min.

3. **Promote Marco to Level 3 for `create_update`** (possibly — see decision below).
   - Per `decisions/2026-04-15-phase-6a-level-2.md`, Andrew reviews Marco's first-week updates on 2026-04-22 and decides whether to drop the ✅-reaction gate for Tier 1 only.
   - If promoted, Tier 2 stays at Level 2; only Andrew skips the ✅ step.
   - Implementation is trivial — add `create_update` to the Level-3 approved types list in the router and skip the preview-DM branch for Tier 1.

### Probably build later

4. **Scheduled skills need to be enabled.** `team-morning-brief`, `friday-weekly-rollup`, `production-alert`, `weekly-swot-company` are all scaffolded with DRY_RUN=1 since 2026-04-15. Each needs to be swapped to use the AR 2026 aggregate pattern for any financial figures (not Claude arithmetic). See `Marco/.claude/skills/*/SKILL.md` specs.

5. **kb-query in production.** Currently feature-flagged with `ENABLE_KB=true`. Reads a knowledge base markdown file via prompt caching. Works in theory, needs smoke-testing with real questions.

6. **Column-value writes.** NOT currently needed per Andrew's 2026-04-21 confirmation — he uses `create_update` notes and the team member with column-write access updates the column. If that changes, requires fresh decision + `change_column_value` mutation in `lib/monday.ts`'s `WRITE_ALLOWED` set.

7. **Promote to production.** Currently only staging. Prod deploy requires:
   - Deploy tasks to prod: `npx trigger deploy --env prod`
   - Update `TRIGGER_SECRET_KEY` in Vercel to a prod key (`tr_prod_...`)
   - Update `MARCO_SLACK_BOT_TOKEN` in Trigger.dev prod env (copy from staging or current Slack app)
   - Copy all shared env vars (MONDAY_API_KEY, ANTHROPIC_API_KEY, UPSTASH_REDIS_*, etc.) from staging to prod

### Presentation copy still to update (not code)

Slide `§ 04 · Plus Marco` in `Strategy/2026-04-14 Oltre Full-Lifecycle Presentation.html` still references FreshBooks. Two edits:
- Lede: *"Marco reads Monday — including the AR 2026 board — and answers."*
- "What Marco is": *"...reaches into Monday (deals, contacts, production, AR), SendBlue threads, and Outlook..."*

---

## Known quirks (bite you if you forget)

- **Vercel env var loading at cold start was historically flaky.** Fix deployed: `ensureTriggerConfigured()` runs per-request inside the POST handler. If you ever see silence AND the diagnostic GET shows `triggerTestResult: FAIL`, manually Redeploy. Haven't hit this in several days.
- **Slack bot token rotates on every app reinstall.** After adding scopes or events to the Slack app, Slack issues a new `xoxb-...` token. Update BOTH `MARCO_SLACK_BOT_TOKEN` env vars (Vercel + Trigger.dev staging). Old token stops working instantly.
- **Monday screenshots vs. board dumps.** A screenshot shows only the currently-expanded groups. The board has more items than you see. Don't trust screenshot sums for reality-checks — call the API.
- **Claude hallucinates arithmetic** across 30+ rows. Never let Claude do financial sums directly from row dumps — always pre-compute in code and pass as authoritative facts.
- **Monday formula columns don't parse cleanly via API.** Remaining Balance is computed = Contract - (Payment #1 + Payment #2) in code, not read from the formula cell.
- **AR 2026 has TWO columns both titled "Date".** `getBoardItems` stores values under the title (first non-empty wins) AND under `#<column_id>` so callers can disambiguate.
- **Monday API writes are authored by the API key owner.** Every `create_update` call shows as "Andrew Shpiruk" in Monday's activity feed regardless of who asked Marco. The `— {Name} via Marco` body signature is the attribution surface. Only workaround is giving Marco its own Monday account, deferred with Phase 2 dedicated email.

---

## Quick-reference commands

```bash
# From Marco/ folder.

# Typecheck
npx tsc --noEmit

# Run tests (router + allowlist)
npm test

# Deploy to staging
npx trigger deploy --env staging

# Deploy to prod (when we're ready — NOT today)
npx trigger deploy --env prod

# Health check
curl -s https://oltre-dashboard.vercel.app/api/marco/slack | jq

# Probe Slack signing + URL verification
curl -s -X POST https://oltre-dashboard.vercel.app/api/marco/slack \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test"}'
# Expected: {"error":"bad_signature"} HTTP 401 — signing secret is loaded; Slack's real signed challenge will return the echoed value.
```

---

## How to pick up a future session

1. Read [SOUL.md](SOUL.md), [COMPANY.md](COMPANY.md), [AGENTS.md](AGENTS.md).
2. Read this file (STATUS.md) — current state + open backlog.
3. Skim [decisions/log.md](decisions/log.md) for any non-obvious architecture calls.
4. If Marco is acting up, hit the diagnostic URL first.
5. The latest session notes are in the vault: `Oltre Vault/clients/oltre-castings/sessions/conversation-notes/` — they have the full narrative of what we decided and why.
