---
name: friday-weekly-rollup
description: Post the weekly team rollup to #oltre-office at 4:00 PM Pacific on Friday. Week wins, blockers, next-week focus. Triggered by Trigger.dev cron. DRY_RUN respected.
---

# friday-weekly-rollup

## When
- **Cron:** `0 16 * * 5` (4:00 PM Pacific, Friday). Timezone `America/Los_Angeles`.
- **Trigger.dev task:** `comms/marco-friday-rollup`.

## Audience
- Slack channel `#oltre-office`. Tier 1 + Tier 2 visible.

## Contents
1. **Week header** — "Week of 2026-04-13 → 2026-04-17"
2. **Wins** — deals won this week (name + value), big invoices paid, major shipments.
3. **Blockers** — OCD Schedule items that stayed red all week, AR accounts aging past 60 days, any deal that stalled.
4. **Next week focus** — top 3 items from the dashboard `priorities[]`, plus any deal flagged "close target next week."
5. **Closing line** — one sentence, brand voice. E.g. "Have a good weekend. See you Monday."

## Data sources
- Monday Deals `6466800590` — activity in the last 7 days (filter by `updated_at >= weekStart`)
- Monday AR 2026 `18393591112` — aging column, filter aging > 60 days
- Monday OCD Schedule `5895399290` — items currently flagged
- `GET https://oltre-dashboard.vercel.app/api/state`

## Guardrails
- DRY_RUN=1 → write to `deliverables/YYYY-MM-DD-friday-rollup.md` and DM Andrew. No post.
- DRY_RUN=0 → also post to `#oltre-office`.
- Length cap: under 500 words.
- Never name a team member in a negative context. "Two quotes pending from the shop" ✅, "Alex is behind on quotes" ❌.
- No exclamation marks or emojis.

## Output artifact
`deliverables/YYYY-MM-DD-friday-rollup.md`.