# Marco — Decisions Log

Append-only record of architectural and trust decisions. Every entry: date, decision, rationale.

---

## 2026-04-15 — Initial bootstrap

**Decision:** Marco is a standalone Slack app in Oltre HQ, separate from the existing bot `U0ALQ669ATB`. New Bot Token, new Signing Secret, new identity.

**Rationale:** The existing Oltre HQ bot handles automation notifications. Marco handles conversational Q&A. Mixing the two would conflate trust postures — the automation bot runs pre-approved write tasks, Marco starts at Level 1 read-only.

---

## 2026-04-15 — Dedicated email deferred

**Decision:** Marco does NOT get a dedicated email address in this build. Slack is the exclusive channel.

**Rationale:** Klaus Phase 2 prescribes a dedicated Google Workspace account for the EA. For a team-facing company secretary, the cost (new domain user, forwarding rules, inbox management) exceeds the value in v1. Slack already reaches every stakeholder. Revisit if the team asks Marco questions outside Slack hours.

**Revisit trigger:** More than 3 instances of a team member emailing Andrew asking a question Marco could have answered.

---

## 2026-04-15 — Trigger.dev for webhook + heartbeat, not /loop

**Decision:** Marco's Slack inbound webhook runs as the Trigger.dev task `comms/marco-slack-inbound`. Overnight heartbeat runs as a Trigger.dev cron, not `/loop`.

**Rationale:** Aligns with the existing cron decision for the Oltre fleet (Q16). Trigger.dev gives us visibility, retries, and a single ops surface. `/loop` is fine for ad-hoc local work but not for a production Slack listener that needs 24/7 availability and audit logs.

---

## 2026-04-15 — Trust ladder frozen at Level 1 until Andrew promotes in writing

**Decision:** Marco ships at Level 1 (Read & Report) and stays there for a minimum of 2 weeks. Promotion to Level 2 requires Andrew to add an entry to this file that explicitly says "Marco is now Level 2 for Tier-1 drafts." No verbal promotions. No inferred promotions.

**Rationale:** The whole point of the ladder is that trust is earned through observable behavior. If Marco can self-promote or interpret casual remarks as promotions, the ladder is theater. Written decisions in this file are the only valid promotion path.

**Tier 2 ceiling:** Bella, Alex T., Alex P. stay at read-only forever. They never graduate to write access through Marco.

---

## 2026-04-15 — Outbound Slack client is standalone, zero imports from oltre-agents

**Decision:** `lib/slack.ts` reimplements the Slack Web API wrapper from scratch (copying the pattern from `oltre-agents/src/lib/slack.ts` but without sharing a module).

**Rationale:** Marco is a separate repo with its own deploy cadence. Importing from oltre-agents would couple two deploys and two dependency trees. The code is ~50 lines — duplication is cheaper than coupling.
