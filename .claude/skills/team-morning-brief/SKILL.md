---
name: team-morning-brief
description: Post the daily Oltre operational brief at 7:30 AM Pacific, Monday–Friday. Triggered by a Trigger.dev cron, not by a user. Pulls pipeline, AR, and production from Monday. No private info. DRY_RUN=1 sends a preview to Andrew's DM only; channel posting additionally requires the channel in the task's APPROVED_CHANNELS.
---

# team-morning-brief

## When
- **Cron:** `30 7 * * 1-5` (7:30 AM Pacific, Monday–Friday). Timezone `America/Los_Angeles`.
- **Trigger.dev task:** `comms/marco-team-morning-brief`.

## Audience
- **Current (2026-07-30):** Andrew's DM. Channel delivery is hard-gated in code — the target channel must be in the task's `APPROVED_CHANNELS` constant (currently empty), which only changes with a decisions/log.md entry. Andrew explicitly does not want the brief in `#oltre-office` yet (2026-07-14).
- **Scope:** Tier 2 and Tier 1 visible. No Andrew-only content.

## Contents
1. **Date header** — "Oltre — 2026-04-15"
2. **Pipeline headline** — deal counts per stage + total deals, computed in code.
3. **AR top 3** — client name, amount outstanding. No other financial detail. All AR numbers pre-computed in code from the AR 2026 board (never Claude arithmetic).
4. **Production** — OCD Schedule items flagged red OR with ship dates in the next 5 business days.
5. ~~**Wins since yesterday**~~ — not implemented; the brief is Monday-boards-only.
6. ~~**Today's focus**~~ — REMOVED 2026-07-14 on Andrew's instruction: the dashboard's `currentFocus` data was stale and inaccurate.

## Data sources (read-only)
- Monday Deals board `6466800590` — items, status column
- Monday AR 2026 board `18393591112` — items, amount column, aging
- Monday OCD Schedule board `5895399290` — items, status, ship date column
- ~~`GET https://oltre-dashboard.vercel.app/api/state` with `Authorization: Bearer $OLTRE_DASHBOARD_API_TOKEN (env)`~~ — dropped 2026-07-14 with the focus section; the brief no longer reads the dashboard.

## Guardrails
- **DRY_RUN=1 (or unset)** → DM Andrew a preview only. Do NOT post to any channel.
- **DRY_RUN=0** → post to a channel ONLY if it is listed in the task's `APPROVED_CHANNELS` constant (decisions/log.md entry required); otherwise still DM Andrew.
- Never mention: personnel status, client negotiation detail, cash balance beyond AR top 3, Uplift AI, Andrew's personal tasks.
- Never use exclamation marks or emojis (brand voice).
- Length cap: under 400 words.
- Output validation in code: a composed brief that breaks format rules or uses any number not present in the pre-computed facts block falls back to the raw-facts brief (`src/tasks/brief-validation.ts`).

## Output artifact
Saved to Redis via `lib/deliverables.ts` (`marco:deliverable:YYYY-MM-DD-morning-brief`, 30-day TTL), best-effort after delivery — Trigger.dev cloud's filesystem is ephemeral, so the local `deliverables/` folder from the original spec is not used. (Phase 9 heartbeat was dropped; nothing prepares an overnight draft.)

## Failure modes
- Monday board read fails → that section degrades to a plain "Monday unreachable" line; the rest of the brief still goes out.
- Claude composition fails or the composed brief fails validation → post the raw code-computed facts instead of nothing.
- Slack channel post fails → fall back to Andrew's DM with the error; the artifact is still saved to Redis.