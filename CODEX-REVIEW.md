# Codex Review — Marco

Review everything in this repository (and the Slack webhook route it depends
on: `../oltre-dashboard/app/api/marco/slack/route.ts`, if the sibling repo is
available).

## What Marco is and what I want (Andrew, owner)

I want a Slack app for my company, Oltre Castings & Design (~10-person
premium precast concrete manufacturer), that works like a real team member:

- Anyone on the team can ask it questions in Slack — about deals, leads,
  contacts, production schedules, AR/cash, our standard operating procedures,
  our sales playbook — and get a fast, accurate answer. Seconds, not minutes.
- It acknowledges immediately and never goes silent. If it can't answer, it
  says so and says what to do instead.
- It can log updates to Monday.com for us, but only through a draft-and-
  approve flow, and only what each person's trust tier allows
  (`.claude/rules/slack-allowlist.md` is non-negotiable).
- It proactively keeps the team informed: a daily morning brief, production
  alerts when something is flagged or slipping, weekly rollups.
- It's a work app only — no personal content — and it speaks in our brand
  voice (no exclamation marks, no emojis, "six weeks" not "30 days").
- It should be reliable and consistent enough that the team actually uses it
  every day, and clean enough architecturally that it can serve as a
  reference build for future deployments.

The stack: Slack Events API → Vercel webhook → Trigger.dev tasks (project
`proj_nvpgdhytpkikscybodkk`, deployed with `npx trigger.dev deploy` — merged
code does nothing until deployed) → Anthropic API + Monday.com GraphQL +
Upstash Redis. The knowledge base is a Monday doc (id 40608915). Current
state and history: `STATUS.md`, `decisions/log.md`, `ROADMAP.md`.

## The ask

Review everything. Cross-reference the code, the docs, the skills, the
scheduled tasks, the routing, the data layer, the error handling, the tests.
Find the issues, the missing pieces, the gaps, and the inconsistencies —
anything that hurts speed, quality, or reliability, or that would stop the
team from trusting and using it daily. Pay attention to paths where a user
could message Marco and get nothing back — silence has been the most damaging
failure mode historically.

Write your findings to `CODEX-FINDINGS.md`, prioritized (worst first), each
with the file/location, why it matters, and a concrete fix.

Constraints: don't print secrets from `.env`; don't weaken the tier/allowlist
rules; treat `decisions/log.md` as binding context (if you think a decision
is wrong, flag it as a proposal rather than ignoring it).
