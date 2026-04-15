---
name: production-alert
description: Poll the OCD Schedule board every 30 minutes during business hours. If any item is flagged red or has a missed ship date, DM Alex T. and Andrew. Triggered by Trigger.dev cron. DRY_RUN respected.
---

# production-alert

## When
- **Cron:** `*/30 7-18 * * 1-5` (every 30 min, 7 AM–6 PM Pacific, Monday–Friday). Timezone `America/Los_Angeles`.
- **Trigger.dev task:** `comms/marco-production-alert`.

## Audience
- DMs to:
  - Alex Tretiakov — Slack `U04J52R155H`
  - Andrew Shpiruk — Slack `U04D9BPK8H2`
- **Not** Tier-2 visible in general. Bella and Alex P do not get paged by this.

## Trigger conditions
Fire a DM if any of these are true since the last run:
1. An OCD Schedule item's status changed to a red/blocker value (`Red`, `Blocked`, `Delayed`, etc.).
2. An OCD Schedule item's ship date passed without status moving to `Shipped` or `Done`.
3. An item's ship date moved forward (slipped) by more than 3 business days.

## De-duplication
- Maintain a cache at `memory/production-alert-state.json` mapping `item_id → last_alerted_state_hash`.
- Do not re-alert on the same item + state combo within 24 hours.
- Reset cache at midnight Pacific.

## Data sources
- Monday OCD Schedule board `5895399290` — columns: status, ship date, last update timestamp.

## Guardrails
- DRY_RUN=1 → write the alert body to `deliverables/YYYY-MM-DD-production-alert-HH-MM.md` and DM Andrew only. Do NOT DM Alex T.
- DRY_RUN=0 → DM both Alex T. and Andrew.
- Message format: "OCD flag: [item name] — [reason in one sentence]. Last update: [timestamp]. Monday link: [url]."
- Never include customer financial info.
- Never fire more than 5 alerts per run. If more than 5 items trip, post a summary ("7 items flagged — see dashboard") instead of spamming.

## Failure modes
- Monday 5xx → skip this run, log to `memory/YYYY-MM-DD.md`. Do NOT retry inside the same cron slot.