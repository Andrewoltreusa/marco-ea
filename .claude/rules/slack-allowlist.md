# Slack Allowlist — NON-NEGOTIABLE

This file is the single source of truth for who can talk to Marco and what they can do. The Slack router (`src/slack/router.ts`) MUST consult this file (or a compiled copy of it) before any other logic.

Do not edit without an explicit written decision from Andrew Shpiruk in `decisions/`. Changes to this file are append-only in git history — the reviewer must see what changed and why.

---

## Tier 1 — Full command authority

| Name | Slack ID | Current level |
|---|---|---|
| Andrew Shpiruk | `U04D9BPK8H2` | **Level 2 (Draft & Wait)** |

Tier 1 capabilities at Level 2:
- Every read skill (deal-status, production-eta, lead-check, agent-fleet-health, find-in-vault once wired).
- **Monday `create_update` writes** via the draft-and-react-✅ flow. Target boards: Deals (`6466800590`), Leads (`6466800613`), Contacts (`6466800570`).
- **12-hour draft TTL.** If Andrew reacts ✅ on a draft older than 12 hours, Marco re-confirms before firing.
- Full signature freedom — Tier 1 drafts can be signed with any attribution Andrew wants, including `— Andrew via Marco` (default).
- Receives all scheduled broadcasts and alerts.

Tier 1 **cannot** (still deferred to Level 3):
- Create new Monday items, change column values, move items between groups, delete anything
- Write outside Monday (no FreshBooks writes, no Gmail sends, no vault file writes)
- Promote Marco up the trust ladder — that takes a written decision in `decisions/log.md`

---

## Tier 2 — Read + Conversational Monday Updates (Level 2 scoped)

Tier 2 users can ask any read-only query AND request Monday `create_update` writes through the same draft-and-react-✅ flow as Tier 1, with additional guardrails.

| Name | Slack ID | Role |
|---|---|---|
| Bella Babere | `U077KFWGAPP` | Customer Service / Follow-ups |
| Alex Tretiakov | `U04J52R155H` | Daily Operations Manager |
| Aleksandr Polkhovskiy | `U04DKJV7SAV` | Owner |

Tier 2 capabilities:
- All Phase-6 read skills (deal-status, lead-check, production-eta, agent-fleet-health, find-in-vault when wired).
- Receive scheduled broadcasts (team-morning-brief, friday-weekly-rollup).
- **Monday `create_update` writes**, same mutation Tier 1 gets, but with these extra rules:
  - **2-hour draft TTL** (vs 12 hours for Tier 1). Expired Tier 2 drafts are silently discarded — no re-confirm flow.
  - **Signature is forced to the requester's own name.** Bella cannot post an update signed "— Andrew via Marco". The router derives the signature from the Slack sender ID; the skill injects it; Tier 2 users cannot override it.
  - **Only one active draft per user at a time.** If Bella asks Marco to draft a second update before reacting to her first, Marco tells her the first is still pending and asks her to ✅ or ❌ it first. This prevents mis-reactions on the wrong preview.
- Cannot: trigger scheduled runs on demand, write to any board outside Deals/Leads/Contacts, request column value changes, create new Monday items, or do anything else beyond the `create_update` mutation.

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
| 2026-04-15 | **Phase 6a** — Marco promoted to **Level 2 (Draft & Wait)**. Tier 1 + Tier 2 can request Monday `create_update` writes gated by ✅ reaction. Tier 2 gets 2h TTL and forced self-signature; Tier 1 gets 12h TTL and signature freedom. See `decisions/2026-04-15-phase-6a-level-2.md`. | Andrew verbal decision in Slack |