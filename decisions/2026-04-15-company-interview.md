# Phase 4 — Company Interview (2026-04-15)

Self-run of the Klaus proactivity interview, scoped to the company (Oltre Castings & Design), not any individual. Output seeds the Phase 5 skill backlog and tunes the Phase 6 intent classifier.

---

## Prompt 1 — Proactive help for the whole team

> "Based on everything you know about Oltre Castings & Design, the team, and the current operational state — what are all the ways I could proactively help anyone on this team?"

### Candidates

1. **Morning operational brief to `#oltre-office`.** Pipeline state, AR top 3, production red flags, yesterday's wins, today's focus. Saves 4 people from DMing Andrew "what's going on?" each morning. → Phase 5 `team-morning-brief`.

2. **Friday weekly rollup.** Wins, blockers, next-week focus. One post, team-visible. Preserves weekly rhythm without requiring Andrew to write it. → Phase 5 `friday-weekly-rollup`.

3. **Production red-flag alerting.** OCD Schedule board poll every 30 min during business hours. If anything goes red or misses a deadline, DM Alex T. and Andrew. The same info exists on the board, but nobody checks boards proactively. → Phase 5 `production-alert`.

4. **Weekly company SWOT.** Monday 9 AM. Strategic snapshot for Andrew + Alex P only. Keeps the owner informed without requiring a meeting. → Phase 5 `weekly-swot-company`.

5. **Deal status on demand.** "What's up with [client]?" is the single most frequent question in a small shop. A 3-sentence answer pulling Monday + FreshBooks + OCD saves every team member from three clicks. → Phase 6 `deal-status`.

6. **Lead follow-up check on demand.** "Has [name] gotten back to us?" — Bella asks this constantly. Monday Leads + MS Graph reply detection can answer it in <3s. → Phase 6 `lead-check`.

7. **Cash position on demand.** "Who owes us the most?" / "What's AR at?" — Alex P will ask this. FreshBooks + Monday AR 2026. → Phase 6 `cash-position`.

8. **Agent fleet health.** "Is anything broken?" — Andrew asks this when something feels off. `/ai` route on the dashboard answers it. → Phase 6 `agent-fleet-health`.

9. **Production ETA on demand.** "When does [client] ship?" — Bella asks this when clients press her. OCD Schedule board answers it. → Phase 6 `production-eta`.

10. **Vault semantic search.** "What do we know about [topic]?" — answers strategy and context questions without opening Obsidian. → Phase 6 `find-in-vault`.

### The single question to answer in under 3 seconds

> **"What's the status of [deal / client]?"**

This is the highest-leverage query in the shop. Everything else is an extension of it. If `deal-status` works well end-to-end, Marco is already paying rent.

---

## Prompt 2 — Whole-team vs. Andrew-DM content

> "Assume Andrew, Bella, Alex T., and Alex P. are all reading you. What belongs in a good morning update to the whole team? What belongs only in Andrew's personal DM?"

### Belongs in `#oltre-office` team morning brief

- **Pipeline headline** — deals open, deals moving, deals expected to close this week. Team-visible because every person influences the pipeline.
- **AR top 3** — which three clients owe the most, by how much, how overdue. Everyone benefits from knowing what Bella/accounting are chasing.
- **Production bottlenecks** — anything red on OCD Schedule that affects ship dates. Alex T. needs to know, but so does Bella so she can set client expectations.
- **Yesterday's wins** — deals won, invoices paid, orders shipped. Morale fuel.
- **Today's focus** — the 1-3 things Andrew has flagged on the dashboard as "today's priority." Keeps everyone aligned.
- **Weather on shipping routes** — optional, only when severe.

### Belongs only in Andrew's personal DM (NOT in the team brief)

- **Raw financial numbers beyond AR top 3** — cash balance, margin, payroll lead time. Owner + Andrew territory.
- **Personnel issues.** Anything about a team member's performance, absence, or conflict. Never in a team channel.
- **Client negotiation detail.** What a prospect's budget is, how aggressive to be on pricing, fallback terms. Team-visible risk is too high.
- **Uplift AI methodology or roadmap.** That's agency context, not Oltre operational state. Marco doesn't touch it at all — it's in a forbidden path.
- **Strategic bets.** "Should we take on the Napa job at cost to get the reference?" — Andrew + Alex P only.
- **Anything Andrew is still chewing on.** Draft decisions, not-yet-committed plans. If Andrew hasn't said it out loud, Marco doesn't surface it.

### Belongs only in the Andrew + Alex P DM (`weekly-swot-company`)

- **Strategic SWOT.** Company-level strengths, weaknesses, opportunities, threats. Owner-and-operator audience.
- **Competitor movement** that matters to strategy, not to daily ops.
- **Capital allocation signals.** "We're going to need another pour table by Q3." Owner decision, not team announcement.

---

## Policy Marco derives from this

1. **Default to team-visible.** When in doubt about whether something goes in the team brief or a DM, ask: "Would a team member be annoyed if they found out this was happening without them?" If yes → team brief. If the information is operational, it's almost always team-visible.

2. **Redact aggressively for Tier 2.** If a Tier-1-only field slips into a shared report, Marco removes it before posting. Better to post less than to leak.

3. **Never surface a draft.** If Andrew is mid-decision on something, Marco never references it in a team-facing post until Andrew explicitly commits.

4. **Personnel is off-limits.** Marco does not comment on any individual team member's performance, mood, or availability in team channels. "Bella is out Thursday" is fine; "Bella has been slower with follow-ups this week" is not.

5. **Cash detail scales with audience.** AR top 3 (team). AR full board + aging (Andrew + Alex P). Cash balance + projections (Andrew only).

---

## Seed for Phase 5 and Phase 6

Phase 5 skills (in build order):
1. `team-morning-brief` → `#oltre-office`
2. `production-alert` → DMs Alex T. + Andrew
3. `weekly-swot-company` → Andrew + Alex P DMs
4. `friday-weekly-rollup` → `#oltre-office`
5. ~~`deal-won-announce`~~ — **dropped per Andrew decision** (Monday handles it)

Phase 6 skills (in build order):
1. `deal-status` — highest leverage
2. `cash-position` — most frequent Alex P / Andrew question
3. `production-eta` — most frequent Bella question
4. `lead-check` — frequent Bella question
5. `find-in-vault` — generalist fallback
6. `agent-fleet-health` — niche but important
