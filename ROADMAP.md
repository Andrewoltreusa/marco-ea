# Marco Roadmap — the 12 (approved by Andrew 2026-07-14)

Andrew approved implementing all 12 recommendations from the 2026-07-14 research
round. Status legend: DONE / READY (code ships next session) / BLOCKED-ANDREW
(needs an Andrew action first) / QUEUED.

| # | Item | Effort | Status |
|---|---|---|---|
| 6 | Objection quick-draw ("objection: too expensive" → 3A script from KB §19) | S | **DONE 2026-07-14** (router + kb-query, deployed v20260714.5) |
| — | Kevin Stone class of bug: contacts→deals relation resolution in deal-status | S | **DONE 2026-07-14** (getLinkedItems in lib/monday.ts) |
| — | Dealer-process questions route to KB §23-24, not lead-check | S | **DONE 2026-07-14** |
| 1 | KB repair: rebuild the ~40% destroyed table debris (glossary, redirects, workflow registry), refresh Section 12 (April snapshot) | M | QUEUED — content pipeline like the §17-24 ingest; needs a working session |
| 2 | Dealer Partners flip-nagger (4 PM check: reply logged but status not flipped → DM Bella) + "where is [store] in the dealer pipeline?" | S-M | BLOCKED-ANDREW — the Monday Dealer Partners board must exist first (dealer v2 build; Bella's template pack awaits approval) |
| 3 | Block Kit approval buttons replacing ✅ reactions (wait-tokens, draftId-bound) | M | QUEUED — blocker likely cleared 2026-07 (a Slack Interactivity endpoint now exists in the dashboard); verify the app's Interactivity URL points at it, then code ships. Note: the Wave-5 draft state machine already gives reactions exactly-once semantics, so this is now UX polish, not a safety fix |
| 4 | Tier-scoped hydration (redact Monday data in code before the model sees it) | M | **DONE 2026-07-30** (Wave 6: lib/tier-redact.ts — AR rows excluded pre-hydration, financial columns stripped pre-prompt; decisions/log.md) |
| 5 | Flip scheduled skills live (DRY_RUN=0) | S | **DONE 2026-07-31** — DRY_RUN=0 in Trigger prod; brief + alerts run live to DMs. Channel destination still pending: APPROVED_CHANNELS stays empty until the 2026-08-07 review (decisions/log.md) |
| 7 | Decision-debt block in weekly SWOT (Q2 break-point, Day-0 response move, $65K reactivation, anchor tier, COGS, MAP) | S | QUEUED — ships with weekly-swot task |
| 8 | Draft-verifier before Level-2 writes (rule checks first, fresh-context LLM critique second) | S | QUEUED |
| 9 | Per-client production status drafts (weekly, Bella-approved via draft flow) | M | QUEUED — after #3 (buttons make approval clean) |
| 10 | #oltre-help listening channel + tier-scoped suggested prompts | M | BLOCKED-ANDREW — needs Agents & AI Apps toggle in the Slack app + a channel decision |
| 11 | Weekly "what I asked Marco" adoption ritual | S | BLOCKED-ANDREW — human ritual; Marco can post the weekly prompt once a channel exists |
| 12 | template.md + scoring.md per scheduled skill with self-check before posting | S | QUEUED — ships with the next scheduled-skill pass |

Also queued from earlier phases: friday-weekly-rollup + weekly-swot tasks,
conversation-continuity fixes (reply "1" to a disambiguation list),
bilingual team announcement. Done since: credential rotation for Marco/.env
(2026-07-31); exact-duplicate rows now always disambiguate instead of
auto-selecting (Wave 6 resolveCandidates). The Monday Leads duplicate-row
data hygiene itself (Christopher Stadler class) is under separate
investigation in oltre-agents — not Marco's.

Post-audit remediation status (Waves 1–6, 2026-07-29 → 07-31) lives in
CODEX-FINDINGS.md's disposition table + decisions/log.md.

Andrew's standing decisions recorded 2026-07-14 (see decisions/log.md):
no dry-run or live posts to #oltre-office until he picks a destination; the
dashboard "Today's focus" section is removed from the brief (stale data);
"Installed" is a terminal production status (ship date interchangeable with
install date); no church/KJV/personal content anywhere in Marco — work app only.
