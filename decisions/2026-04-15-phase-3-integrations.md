# Phase 3 — Read-only integrations smoke test (2026-04-15)

Verified Marco can read every source it needs before building Phase 5/6 skills.

## Results

| Source | Access path | Smoke test | Result |
|---|---|---|---|
| **Oltre Vault** | Filesystem read of `c:\Users\AndrewShpiruk\Oltre Vault\` | Read `CLAUDE.md`, `clients/oltre-castings/context/team.md`, `clients/oltre-castings/context/key-ids.md` | ✅ All readable. Vault structure matches COMPANY.md. |
| **Monday.com** | `POST https://api.monday.com/v2` with `Authorization: $MONDAY_API_KEY` from `oltre-agents/.env` | `query { me { name email } }` | ✅ Returned `Andrew Shpiruk / andrews@oregonfivestar.com`. Request ID `dc4d5987-a5a1-9308-9fa1-de05e8cc1612`. |
| **Oltre Dashboard** | `GET https://oltre-dashboard.vercel.app/api/state` with `Authorization: Bearer oltre-api-2026` | State pull | ✅ Returned live state: `currentFocus: "Amanda Gilliland follow-up + strategic planning"`, non-empty `completedToday` array. |
| **FreshBooks** | OAuth refresh-token flow using `FRESHBOOKS_CLIENT_ID/SECRET/REFRESH_TOKEN/ACCOUNT_ID` from `oltre-agents/.env` | **Not yet exercised in this session** — credentials present in env, token refresh implementation deferred to Phase 6 `cash-position` skill. |
| **Slack** | Marco's own Slack app (not yet created) | **Deferred to Phase 8** — Marco app install is the next manual Andrew action. |

## Env vars confirmed present in `oltre-agents/.env`

`TRIGGER_SECRET_KEY`, `ANTHROPIC_API_KEY`, `MONDAY_API_KEY`, `SLACK_BOT_TOKEN` (Oltre HQ bot — Marco will NOT reuse), `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REFRESH_TOKEN`, `TWILIO_*`, `FRESHBOOKS_CLIENT_ID`, `FRESHBOOKS_CLIENT_SECRET`, `FRESHBOOKS_REFRESH_TOKEN`, `FRESHBOOKS_ACCOUNT_ID`.

## Required new env vars for Marco (Phase 8)

Marco must NOT reuse `SLACK_BOT_TOKEN` from oltre-agents. It gets its own:

```
MARCO_SLACK_BOT_TOKEN=xoxb-...   # created when Andrew installs the Marco Slack app
MARCO_SLACK_SIGNING_SECRET=...   # from the Marco app's Basic Information page
MARCO_SLACK_APP_ID=A...          # from the Marco app's Basic Information page
```

These will be added to `oltre-agents/.env` alongside the existing vars (since Marco's Trigger.dev tasks share the project and therefore the env store).

## Outcome

Phase 3 is green enough to build Phases 4–7. Phase 6 `cash-position` will exercise the FreshBooks OAuth flow end-to-end and close the one remaining unknown.
