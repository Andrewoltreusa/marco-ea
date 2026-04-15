# Slack Allowlist — NON-NEGOTIABLE

This file is the single source of truth for who can talk to Marco and what they can do. The Slack router (`src/slack/router.ts`) MUST consult this file (or a compiled copy of it) before any other logic.

Do not edit without an explicit written decision from Andrew Shpiruk in `decisions/`. Changes to this file are append-only in git history — the reviewer must see what changed and why.

---

## Tier 1 — Full command authority

| Name | Slack ID | Current level |
|---|---|---|
| Andrew Shpiruk | `U04D9BPK8H2` | Level 1 (Read & Report) |

Tier 1 capabilities (by trust level):
- **Level 1 — current.** Can ask any query. Marco answers from reads only. No writes anywhere.
- **Level 2 — not yet promoted.** Can request drafts (messages, tasks, emails). Marco drafts to `projects/drafts/` and DMs Andrew for ✅ reaction. Andrew confirms → Marco executes.
- **Level 3 — deferred.** Execute on pre-approved action types without per-instance confirmation. List of approved types is currently empty. Promotion requires written decision in `decisions/`.

---

## Tier 2 — Read-only queries, forever

Tier 2 users can ask any read-only query. They **cannot** trigger writes. They do not graduate to write access through Marco — if they need to change something, they use their own accounts.

| Name | Slack ID | Role |
|---|---|---|
| Bella Babere | `U077KFWGAPP` | Customer Service / Follow-ups |
| Alex Tretiakov | `U04J52R155H` | Daily Operations Manager |
| Aleksandr Polkhovskiy | `U04DKJV7SAV` | Owner |

Tier 2 capabilities:
- All Phase-6 query skills (deal-status, lead-check, cash-position, agent-fleet-health, production-eta, find-in-vault).
- Receive scheduled broadcasts (team-morning-brief, friday-weekly-rollup, deal-won-announce).
- Cannot: trigger scheduled runs on demand, draft messages for review, modify any external system.

**Scoping rule:** Tier 2 users never see Tier-1-only output. `weekly-swot-company` is Andrew + Alex P only. `production-alert` DMs go to Alex T. and Andrew only. If a skill's output includes a field that is Tier-1-only, Marco redacts that field for Tier 2.

---

## Tier 3 — Silent with one polite refusal

Everyone else. Unknown users who DM Marco or mention Marco in a channel get exactly one reply per 24 hours:

> "I'm Marco, Oltre's company secretary. I'm not configured to respond to you — please ask Andrew Shpiruk directly if you need something from the company."

After that one reply, Marco is silent for the rest of the 24-hour window. Every Tier-3 incident is logged to `memory/access-denials.md` with:

- ISO timestamp
- Slack user ID
- Channel or DM
- Verbatim message (truncated at 200 chars)
- Action taken (reply sent / rate-limited silence)

---

## Enforcement

- The router checks this file (or compiled copy) FIRST, before any intent classification.
- If a Slack ID is ambiguous or missing from this file, it is Tier 3 by default.
- Bot users (app IDs starting with `U0AL…` such as the Oltre HQ bot `U0ALQ669ATB`) are NEVER promoted to Tier 1 or 2. If a bot-like event arrives, it is ignored with no reply.
- The file `src/slack/router.ts` has unit tests that assert every user in this list maps to the expected tier. Tests run in CI. If the test file is missing the test, the test suite fails.

---

## Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-15 | Initial allowlist: Andrew Tier 1, Bella + Alex T Tier 2, Alex P pending Slack ID | Marco bootstrap |
| 2026-04-15 | Alex P Slack ID resolved to `U04DKJV7SAV`, promoted to Tier 2 active | Andrew confirmation |