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
| 3 | Block Kit approval buttons replacing ✅ reactions (wait-tokens, draftId-bound) | M | BLOCKED-ANDREW — Slack app needs Interactivity request URL set to the webhook URL; code ships once configured |
| 4 | Tier-scoped hydration (redact Monday data in code before the model sees it) | M | QUEUED |
| 5 | Flip scheduled skills live (DRY_RUN=0) | S | BLOCKED-ANDREW — say go when the DM previews look right; also choose a destination (explicitly NOT #oltre-office per 2026-07-14) |
| 7 | Decision-debt block in weekly SWOT (Q2 break-point, Day-0 response move, $65K reactivation, anchor tier, COGS, MAP) | S | QUEUED — ships with weekly-swot task |
| 8 | Draft-verifier before Level-2 writes (rule checks first, fresh-context LLM critique second) | S | QUEUED |
| 9 | Per-client production status drafts (weekly, Bella-approved via draft flow) | M | QUEUED — after #3 (buttons make approval clean) |
| 10 | #oltre-help listening channel + tier-scoped suggested prompts | M | BLOCKED-ANDREW — needs Agents & AI Apps toggle in the Slack app + a channel decision |
| 11 | Weekly "what I asked Marco" adoption ritual | S | BLOCKED-ANDREW — human ritual; Marco can post the weekly prompt once a channel exists |
| 12 | template.md + scoring.md per scheduled skill with self-check before posting | S | QUEUED — ships with the next scheduled-skill pass |

Also queued from earlier phases: friday-weekly-rollup + weekly-swot tasks,
conversation-continuity fixes (reply "1" to a disambiguation list; the
Christopher Stadler triple-duplicate shows Leads data hygiene is needed too),
bilingual team announcement, credential rotation for Marco/.env.

Andrew's standing decisions recorded 2026-07-14 (see decisions/log.md):
no dry-run or live posts to #oltre-office until he picks a destination; the
dashboard "Today's focus" section is removed from the brief (stale data);
"Installed" is a terminal production status (ship date interchangeable with
install date); no church/KJV/personal content anywhere in Marco — work app only.
