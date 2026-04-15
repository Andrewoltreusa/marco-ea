# Marco — Install Guide

## Repo location

Marco lives at `c:\Users\AndrewShpiruk\Oltre\Marco\` (moved here on 2026-04-15, alongside `oltre-agents` and `oltre-dashboard`). The GitHub remote is <https://github.com/Andrewoltreusa/marco-ea>.

---



Marco is a Slack app + a set of Trigger.dev tasks. This doc covers the manual steps Andrew must do to bring Marco online. The code scaffolding is already in this repo.

## Prerequisites
- Admin on the Oltre HQ Slack workspace
- Access to the Trigger.dev project `proj_rfghiguuzwfekcixcuux`
- `oltre-agents/.env` available locally (Marco reads creds from there)

---

## Step 1 — Create the Marco Slack app ✅ DONE 2026-04-15

App exists in Oltre HQ. Credentials live in `.env` (gitignored). **Never commit them to this file or any other tracked file.**

Env var keys used throughout Marco:
- `MARCO_SLACK_APP_ID`
- `MARCO_SLACK_SIGNING_SECRET`
- `MARCO_SLACK_BOT_TOKEN`

Granted Bot Token Scopes:
- `app_mentions:read`, `channels:history`, `channels:join`, `channels:read`, `chat:write`, `commands`, `files:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, `users:read`

Installed to workspace. App Home Messages Tab enabled with slash-command + DM input allowed.

### Icon + display name
- Display name: **Marco**
- Short description: "Oltre's company secretary. Ask me what's going on."
- Icon: Oltre Craftsman brand-compliant. Single cobalt accent on white, square. _(Phase-1 placeholder — Andrew or Alex renders the final asset.)_

---

## Step 2 — Register the slash command

Under **Slash Commands** → **Create New Command**:
- **Command:** `/marco`
- **Request URL:** *(set after Step 4 — the Trigger.dev HTTP endpoint for `comms/marco-slack-inbound`)*
- **Short description:** "Ask Marco, the Oltre company secretary."
- **Usage hint:** "what's the status of [client]?"
- **Escape channels, users, and links sent to your app** — **checked.**

---

## Step 3 — Subscribe to events

Under **Event Subscriptions** → **Enable Events**:
- **Request URL:** same Trigger.dev endpoint as the slash command (Slack pings both through the same task).
- **Subscribe to bot events:**
  - `app_mention`
  - `message.im`
- Reinstall the app when prompted (events require a new install).

---

## Step 4 — Add Marco's env vars to Trigger.dev

In the Trigger.dev dashboard for project `proj_rfghiguuzwfekcixcuux`, open **Environment Variables** and add:

```
MARCO_SLACK_BOT_TOKEN=xoxb-...
MARCO_SLACK_SIGNING_SECRET=...
MARCO_SLACK_APP_ID=A...
```

The Monday, FreshBooks, and Anthropic keys are already present from the oltre-agents deploy — Marco reuses them at read scope.

---

## Step 5 — Deploy Marco's Trigger.dev tasks

From this repo:

```bash
bun install        # or: npm install
bun run typecheck  # sanity check
bun test           # runs router + allowlist unit tests — MUST pass
npx trigger.dev@latest deploy --project-ref proj_rfghiguuzwfekcixcuux
```

The deploy registers two tasks:
- `comms/marco-slack-inbound` — webhook for `/marco` + DMs + mentions
- `comms/marco-heartbeat` — overnight 30-min cron

---

## Step 6 — Wire the Request URL

Once the deploy succeeds, Trigger.dev gives you an HTTP endpoint for `comms/marco-slack-inbound`. Copy that URL and paste it into:
- **Slash Commands → /marco → Request URL**
- **Event Subscriptions → Request URL**

Slack will ping the endpoint with a `url_verification` challenge. The task handler must respond `200` with the echoed `challenge` value. _(Add this branch in Phase 6b if the default Trigger.dev handler doesn't cover it.)_

---

## Step 7 — Invite Marco to channels

In Slack:
```
/invite @Marco
```

Invite Marco to:
- `#oltre-office` — required for `team-morning-brief` and `friday-weekly-rollup`

Do NOT invite Marco to:
- `#stone-operations`, `#warehouse-deliveries` — Marco doesn't need read access there
- Any personal DM threads that aren't with an allowlisted user

---

## Step 8 — Smoke test

1. **Tier 1 test:** Andrew DMs Marco `cash`. Expected: a cash-position stub reply (v1) or a real AR top-5 (after Phase 6b).
2. **Tier 2 test:** Bella DMs Marco `when does [test client] ship?`. Expected: `production-eta` stub reply with tier-2 scoping.
3. **Tier 3 test:** ask someone outside the allowlist to DM Marco. Expected: the polite refusal message, logged to `memory/access-denials.md`.
4. **Scheduled test:** set `DRY_RUN=1` and manually trigger `comms/marco-team-morning-brief` from the Trigger.dev dashboard. Expected: a draft in `deliverables/` and a preview DM to Andrew. No post to `#oltre-office`.

If all four pass, Marco is live at Level 1 (Read & Report).

---

## Step 9 — Nothing else writes

Until Andrew writes an entry in `decisions/log.md` promoting Marco to Level 2, **no skill may call Slack `chat:write` against any channel except as a reply to a user's message**. Scheduled briefs running with `DRY_RUN=1` is the hard default for the first 2 weeks.

The router + allowlist tests (`bun test`) block any deploy where:
- An allowlist user has the wrong tier
- Tier 3 can hit a non-refuse skill
- The Oltre HQ bot `U0ALQ669ATB` is anywhere except Tier 3
