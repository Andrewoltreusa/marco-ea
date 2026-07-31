# Marco

**Oltre Castings & Design's company secretary.**

Marco is a Slack app that answers the "what's the status of X?" questions the Oltre team asks all day, so nobody has to DM Andrew. Team-facing, shared, read-mostly: the only write is Monday `create_update` behind a draft + ✅-approval flow. NOT a personal executive assistant (see 07b for Andrew's personal EA).

## What Marco is
- A separate Slack app in the Oltre HQ workspace (not the existing `U0ALQ669ATB` automation bot)
- Six Trigger.dev tasks (`src/tasks/`): inbound event handler (`marco-slack-inbound`), Monday write-draft child (`marco-monday-update-draft`), ✅/❌ reaction handler (`marco-reaction-handler`), write watchdog (`marco-write-watchdog`), plus two scheduled crons — morning brief (`marco-team-morning-brief`) and production alert (`marco-production-alert`)
- Reads: Monday.com and the Oltre Dashboard (FreshBooks removed 2026-04-17). Writes: Level-2 `create_update` on Deals/Leads/Contacts only, via draft + approval
- Tier-gated: Andrew is Tier 1; Bella/Alex T./Alex P. are Tier 2 (all read skills + draft-gated Monday `create_update` since Phase 6a, with 2h TTL and forced self-signature); everyone else is Tier 3 (one refusal per 24h, then silence)

## What Marco isn't
- Not Andrew's personal EA — doesn't see his calendar, inbox, or personal tasks
- Not the Oltre HQ automation bot — separate identity, separate token
- Writes are limited to Level 2 (Draft & Wait): Monday `create_update` on Deals/Leads/Contacts via draft + approval (decisions/2026-04-15-phase-6a-level-2.md)

## Identity files
- [SOUL.md](SOUL.md) — who Marco is
- [COMPANY.md](COMPANY.md) — who Marco serves (Oltre profile)
- [AGENTS.md](AGENTS.md) — operating manual
- [CLAUDE.md](CLAUDE.md) — Claude Code index
- [.claude/rules/slack-allowlist.md](.claude/rules/slack-allowlist.md) — tiered access (non-negotiable)

## Skills

### Scheduled
- [team-morning-brief](.claude/skills/team-morning-brief/SKILL.md) — 7:30 AM Pacific M-F — implemented, DRY_RUN gated; goes to Andrew's DM until a channel is added to `APPROVED_CHANNELS` (currently empty) with a decisions/log.md entry
- [production-alert](.claude/skills/production-alert/SKILL.md) — every 30 min biz hours → Alex T. + Andrew DMs — implemented, DRY_RUN gated
- [friday-weekly-rollup](.claude/skills/friday-weekly-rollup/SKILL.md) — Friday 4 PM — **spec only, not built**
- [weekly-swot-company](.claude/skills/weekly-swot-company/SKILL.md) — Monday 9 AM, Andrew + Alex P only — **spec only, not built**

### Conversational (implemented in `src/skills/`)
- [deal-status](.claude/skills/deal-status/SKILL.md) — "what's the status of [client]?"
- [production-eta](.claude/skills/production-eta/SKILL.md) — "when does [client] ship?"
- [lead-check](.claude/skills/lead-check/SKILL.md) — "has [name] gotten back to us?"
- [agent-fleet-health](.claude/skills/agent-fleet-health/SKILL.md) — "is anything broken?"
- board-stats — "how many leads do we have?" — board aggregates counted in code, never by the model
- general-query — the Claude fallback for everything else, including cash/AR questions ([cash-position](.claude/skills/cash-position/SKILL.md) is folded into it — it injects code-computed AR 2026 aggregates) and "what do we know about [topic]?" ([find-in-vault](.claude/skills/find-in-vault/SKILL.md) has no vault indexer and routes here)
- kb-query — process/how-to questions from the Monday-hosted KB, feature-flagged `ENABLE_KB=true`; falls back to general-query with a disclosure line when unavailable

## Install

See [INSTALL.md](INSTALL.md).

## Status

| Phase | Status |
|---|---|
| 1 — Identity | ✅ Scaffolded |
| 2 — Dedicated email | ⏸ Deferred (Slack-first) |
| 3 — Read-only integrations | ✅ Smoke-tested (Monday + Dashboard) |
| 4 — Company interview | ✅ [decisions/2026-04-15-company-interview.md](decisions/2026-04-15-company-interview.md) |
| 5 — Scheduled workflows | 🟡 morning-brief + production-alert implemented (DRY_RUN gated); friday-weekly-rollup + weekly-swot spec only |
| 6 — Query skills | ✅ Implemented and deployed (deal-status, production-eta, lead-check, agent-fleet-health, board-stats, general-query, kb-query) |
| 7 — Trust ladder | ✅ Level 2 (Draft & Wait) since 2026-04-15 |
| 8 — Slack app wiring | ✅ Installed and live (`A0ASRRXM7MM`, bot user `U0ATL76PG9F`) |
| 9 — Overnight heartbeat | ❌ Dropped — no heartbeat task exists; crons cover scheduled work |

## Decisions
See [decisions/log.md](decisions/log.md) for every architecture call, including the 2-week Level-1 freeze and the email deferral.
