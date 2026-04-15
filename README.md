# Marco

**Oltre Castings & Design's company secretary.**

Marco is a Slack app that answers the "what's the status of X?" questions the Oltre team asks all day, so nobody has to DM Andrew. Team-facing, shared, read-only. NOT a personal executive assistant (see 07b for Andrew's personal EA).

## What Marco is
- A separate Slack app in the Oltre HQ workspace (not the existing `U0ALQ669ATB` automation bot)
- A set of Trigger.dev tasks: one inbound webhook, one overnight heartbeat, four scheduled broadcasts
- Read-only: Oltre Vault, Monday.com, Oltre Dashboard, FreshBooks
- Tier-gated: Andrew is Tier 1 (commands), Bella/Alex T./Alex P. are Tier 2 (read-only queries), everyone else is Tier 3 (silent refusal)

## What Marco isn't
- Not Andrew's personal EA — doesn't see his calendar, inbox, or personal tasks
- Not the Oltre HQ automation bot — separate identity, separate token
- Not a write system — v1 is frozen at trust Level 1 (Read & Report) for a minimum of 2 weeks

## Identity files
- [SOUL.md](SOUL.md) — who Marco is
- [COMPANY.md](COMPANY.md) — who Marco serves (Oltre profile)
- [AGENTS.md](AGENTS.md) — operating manual
- [CLAUDE.md](CLAUDE.md) — Claude Code index
- [.claude/rules/slack-allowlist.md](.claude/rules/slack-allowlist.md) — tiered access (non-negotiable)

## Skills

### Scheduled
- [team-morning-brief](.claude/skills/team-morning-brief/SKILL.md) — 7:30 AM Pacific M-F → `#oltre-office`
- [friday-weekly-rollup](.claude/skills/friday-weekly-rollup/SKILL.md) — Friday 4 PM → `#oltre-office`
- [production-alert](.claude/skills/production-alert/SKILL.md) — every 30 min biz hours → Alex T. + Andrew DMs
- [weekly-swot-company](.claude/skills/weekly-swot-company/SKILL.md) — Monday 9 AM → Andrew + Alex P DMs

### Conversational
- [deal-status](.claude/skills/deal-status/SKILL.md) — "what's the status of [client]?"
- [cash-position](.claude/skills/cash-position/SKILL.md) — "what's AR at?" / "who owes us the most?"
- [production-eta](.claude/skills/production-eta/SKILL.md) — "when does [client] ship?"
- [lead-check](.claude/skills/lead-check/SKILL.md) — "has [name] gotten back to us?"
- [agent-fleet-health](.claude/skills/agent-fleet-health/SKILL.md) — "is anything broken?"
- [find-in-vault](.claude/skills/find-in-vault/SKILL.md) — "what do we know about [topic]?"

## Install

See [INSTALL.md](INSTALL.md).

## Status

| Phase | Status |
|---|---|
| 1 — Identity | ✅ Scaffolded |
| 2 — Dedicated email | ⏸ Deferred (Slack-first) |
| 3 — Read-only integrations | ✅ Smoke-tested (Monday + Dashboard) |
| 4 — Company interview | ✅ [decisions/2026-04-15-company-interview.md](decisions/2026-04-15-company-interview.md) |
| 5 — Scheduled workflows | ✅ 4 skills scaffolded, DRY_RUN gated |
| 6 — Query skills | ✅ 6 skills scaffolded; implementations stubbed |
| 7 — Trust ladder | ✅ Level 1, AFK async-with-catch-up documented |
| 8 — Slack app wiring | 🟡 Code scaffolded, manual install pending (see INSTALL.md) |
| 9 — Overnight heartbeat | ✅ Cron task scaffolded |

## Decisions
See [decisions/log.md](decisions/log.md) for every architecture call, including the 2-week Level-1 freeze and the email deferral.
