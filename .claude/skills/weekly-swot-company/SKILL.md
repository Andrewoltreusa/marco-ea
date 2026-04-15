---
name: weekly-swot-company
description: Weekly one-page SWOT on Oltre Castings & Design. Posted as DMs to Andrew and Alex P only. Monday 9 AM Pacific. Strategic content — not team-visible.
---

# weekly-swot-company

## When
- **Cron:** `0 9 * * 1` (9 AM Pacific, Monday). Timezone `America/Los_Angeles`.
- **Trigger.dev task:** `comms/marco-weekly-swot`.

## Audience
- DMs to:
  - Andrew Shpiruk — Slack `U04D9BPK8H2`
  - Aleksandr Polkhovskiy — Slack `U04DKJV7SAV`
- **NEVER** posted to a channel. **NEVER** sent to Bella or Alex T.

## Contents
One page, four sections. Short, specific, strategic.

1. **Strengths** — 3 bullets. What moved the needle last week. Reputation wins, capacity gains, a pattern in winning deals.
2. **Weaknesses** — 3 bullets. What tripped us. A pattern in losing deals, a capacity shortfall, a lead-time slip.
3. **Opportunities** — 3 bullets. Something surfaced by a conversation, a market signal, a repeat request from multiple clients, a dealer lead.
4. **Threats** — 3 bullets. Competitor moves, cash risk, supply risk, a single client representing too much pipeline concentration.

Keep each bullet under 25 words. No preamble, no conclusion, no brand-voice fluff.

## Data sources
- Monday Deals `6466800590` — 30-day window, status column, owner
- Monday AR 2026 `18393591112` — top 10 balances, aging
- Monday OCD Schedule `5895399290` — last week's shipped count and any slips
- Dashboard `/api/state` — Andrew's recent priority notes
- Oltre Vault `clients/oltre-castings/sessions/daily-briefings/` — last 7 days only

## Guardrails
- DRY_RUN=1 → write to `deliverables/YYYY-MM-DD-swot.md` and DM Andrew. Do NOT DM Alex P.
- DRY_RUN=0 → DM both.
- Never mention Uplift AI. This is about Oltre only.
- Never include individual team member performance. Systemic observations only.
- Length cap: 300 words.

## Output artifact
`deliverables/YYYY-MM-DD-swot.md`.
