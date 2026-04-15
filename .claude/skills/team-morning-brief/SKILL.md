---
name: team-morning-brief
description: Post the daily Oltre operational brief to #oltre-office at 7:30 AM Pacific, Monday–Friday. Triggered by a Trigger.dev cron, not by a user. Pulls pipeline, AR, production, wins, and today's focus from Monday and the Oltre Dashboard. No private info. Skip if DRY_RUN=1.
---

# team-morning-brief

## When
- **Cron:** `30 7 * * 1-5` (7:30 AM Pacific, Monday–Friday). Timezone `America/Los_Angeles`.
- **Trigger.dev task:** `comms/marco-team-morning-brief`.

## Audience
- **Primary:** Slack channel `#oltre-office` (Marco must be invited by Andrew).
- **Scope:** Tier 2 and Tier 1 visible. No Andrew-only content.

## Contents
1. **Date header** — "Oltre — 2026-04-15"
2. **Pipeline headline** — open deals count + total value, deals flipped this week, expected closes this week.
3. **AR top 3** — client name, amount outstanding, days aged. No other financial detail.
4. **Production** — OCD Schedule items flagged red OR with ship dates in the next 5 business days.
5. **Wins since yesterday** — deals won, invoices paid, orders shipped. Pulled from Monday activity + dashboard `completedToday`.
6. **Today's focus** — Andrew's `currentFocus` field from `oltre-dashboard.vercel.app/api/state`, plus up to 3 items from `priorities[]`.

## Data sources (read-only)
- Monday Deals board `6466800590` — items, status column
- Monday AR 2026 board `18393591112` — items, amount column, aging
- Monday OCD Schedule board `5895399290` — items, status, ship date column
- `GET https://oltre-dashboard.vercel.app/api/state` with `Authorization: Bearer oltre-api-2026`

## Guardrails
- **DRY_RUN=1** → write the brief to `deliverables/YYYY-MM-DD-morning-brief.md` and DM Andrew a preview. Do NOT post to `#oltre-office`.
- **DRY_RUN=0** → also post to `#oltre-office` via `lib/slack.ts`.
- Never mention: personnel status, client negotiation detail, cash balance beyond AR top 3, Uplift AI, Andrew's personal tasks.
- Never use exclamation marks or emojis (brand voice).
- Length cap: under 400 words.

## Output artifact
Always write `deliverables/YYYY-MM-DD-morning-brief.md` regardless of DRY_RUN. The Phase 9 heartbeat prepares a draft overnight; this skill refines and posts it.

## Failure modes
- Monday API 5xx → retry once, then post a minimal brief using only dashboard state + a line "Monday unreachable, pipeline numbers unavailable."
- Dashboard 5xx → retry once, then skip the "today's focus" section with a line "Focus source unreachable."
- Slack post fails → artifact is still written to `deliverables/`; log the failure to today's `memory/YYYY-MM-DD.md` and DM Andrew the failure.