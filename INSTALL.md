# Marco — Install & Runbook

Rewritten 2026-07-29 (the old guide predated the project split, the Vercel
front door, Level 2, and four of the six tasks — following it could not
reproduce the running system).

## Architecture

```
Slack app A0ASRRXM7MM  ──events/slash/reactions──►  Vercel route (oltre-dashboard repo)
                                                    app/api/marco/slack/route.ts
                                                        │ awaited tasks.trigger + idempotency keys
                                                        ▼
                                    Trigger.dev project proj_nvpgdhytpkikscybodkk (PROD env)
                                    ├─ comms/marco-slack-inbound        (Q&A + routing)
                                    ├─ comms/marco-monday-update-draft  (Level-2 draft)
                                    ├─ comms/marco-reaction-handler     (✅/❌ approval)
                                    ├─ comms/marco-team-morning-brief   (cron 7:30a M-F)
                                    └─ comms/marco-production-alert     (cron */30 biz hrs)
                                    Data: Monday GraphQL · Upstash Redis · Anthropic API
```

## 1. Slack app configuration (api.slack.com/apps → A0ASRRXM7MM)

- **Event Subscriptions** → Request URL: `https://oltre-dashboard.vercel.app/api/marco/slack`
  - Bot events: `app_mention`, `message.im`, `reaction_added`
- **Slash command** `/marco` → same URL
- **OAuth scopes (bot)**: `app_mentions:read, channels:history, channels:join,
  channels:read, chat:write, commands, groups:history, groups:read, im:history,
  im:read, im:write, mpim:history, reactions:read, reactions:write, users:read,
  files:read, files:write, groups:write`
- Reinstalling the app ROTATES the bot token — update `MARCO_SLACK_BOT_TOKEN`
  in BOTH Vercel and Trigger.dev prod in the same window.
- Marco answers channels only where he's a member: `/invite @Marco`.

## 2. Environment matrix (names only — values live in the respective vaults)

| Variable | Vercel (route) | Trigger.dev prod (tasks) |
|---|---|---|
| `MARCO_SLACK_SIGNING_SECRET` | ✅ | — |
| `MARCO_SLACK_BOT_TOKEN` | ✅ (failure notes) | ✅ |
| `MARCO_TRIGGER_SECRET_KEY` | ✅ (must equal the prod env key) | — |
| `MARCO_BOT_USER_ID` (`U0ATL76PG9F`) | ✅ | — |
| `MARCO_SLACK_TEAM_ID` (`T04CSBJ7YVD`) | ✅ | — |
| `MARCO_DIAG_TOKEN` | ✅ | — |
| `ANTHROPIC_API_KEY` | — | ✅ |
| `MONDAY_API_KEY` | — | ✅ |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | — | ✅ |
| `ENABLE_KB` (`true`) + `MARCO_KB_DOC_ID` (`40608915`) | — | ✅ |
| `OLTRE_DASHBOARD_API_TOKEN` | — | ✅ |
| `DRY_RUN` (`1` until go-live decision) | — | ✅ |
| `MARCO_OFFICE_CHANNEL_ID` | — | optional; publishing ALSO requires the in-code approved list |

Local dev: `Marco/.env` mirrors the Trigger.dev set (gitignored — rotate if
exposed).

## 3. Deploy

```
npm ci && npm run typecheck && npm test     # or: npm run deploy (runs all three)
npx trigger deploy                          # bin is `trigger`, not `trigger.dev`
```

**A merged commit does nothing until `trigger deploy` runs.** Check the live
version via the runs API (`version` field on any recent run). The Vercel route
deploys automatically from oltre-dashboard `main`.

## 4. Post-deploy verification

1. `curl -H "Authorization: Bearer $MARCO_DIAG_TOKEN" https://oltre-dashboard.vercel.app/api/marco/slack`
   → `triggerTestResult: SUCCESS` and the run visible in the prod env.
2. DM Marco: a deal question (expects 👀 → answer → ✅ in seconds), a KB
   question ("how do we handle custom colors"), and a financial question.
3. Write flow: "Note that [deal code] … Update it in Monday." → preview in
   your DM with the card URL → ✅ → exactly one Monday update + confirmation.
4. Duplicate delivery and unsupported events: covered by the signed-event
   E2E pattern (see repo history / scratchpad e2e scripts).

## 5. Where runtime state lives

Upstash Redis (`marco:*`): request lifecycle (`marco:evt:*`), drafts +
approval markers (`marco:draft*`), conversation memory (`marco:conv:*`),
KB cache (`marco:kb:v1` + `marco:kb:lkg`), production-alert dedup
(`marco:prodalert*`), deliverables (`marco:deliverable:*`), audit lists
(`marco:log:access-denials`, `marco:log:write-incidents`).

## 6. Governance

Trust tiers and write scope: `.claude/rules/slack-allowlist.md` (canonical) +
`decisions/log.md` (binding history). Current level: 2 — Draft & Wait;
approval is exactly ✅, rejection exactly ❌, forced self-signature.
