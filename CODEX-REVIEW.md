# Codex Review Brief — Marco Infrastructure Audit

You are reviewing **Marco**, Oltre Castings & Design's Slack-native AI company
secretary. Your job: cross-reference everything in this repo (plus the one
external file listed below), find the holes, and produce a prioritized,
actionable review that improves **speed, quality, and consistency** — with
special attention to silent-failure paths, because the #1 historical failure
mode of this system has been *saying nothing*.

---

## 1. Andrew's goals (the owner — this is the "why")

- **Vision:** Marco is a governed AI coworker for a ~10-person premium precast
  concrete manufacturer (Salem, OR; $2M/2026 target). Think "Viktor.com-class
  Slack teammate," but with per-user trust tiers, Monday.com as the system of
  record, and approval-gated writes. Marco is also the reference architecture
  Andrew's agency (Uplift AI) will productize — code quality and clean
  patterns matter beyond this one deployment.
- **Non-negotiables:**
  - Reply fast: 👀 acknowledgment within ~3s, answers ideally <10s, hard cap
    ~20s perceived. (It used to take 30 minutes; that root cause is fixed —
    see §3 — and must never regress.)
  - **Never silent.** Every inbound message from an authorized user gets
    *some* response — an answer, a clarification, or an error with a next
    step. Silence kills team adoption; the team already abandoned Marco once.
  - Tiered access is law: `.claude/rules/slack-allowlist.md`. Tier 1 (Andrew),
    Tier 2 (Bella, Alex T, Alex P), Tier 3 (everyone else: one refusal / 24h).
    Writes limited to Monday `create_update` on Deals/Leads/Contacts via a
    draft → preview → approval flow (trust Level 2).
  - Work app only: no personal/church content, no Andrew-private material, no
    "Uplift AI" methodology in team-visible output, never cite FreshBooks.
  - Brand voice: no exclamation marks, no emojis in prose, "six weeks" not
    "30 days".
- **Direction (approved roadmap — `ROADMAP.md`):** all 12 initiatives are
  approved. Highest-value next builds: Block Kit approval buttons replacing
  ✅ reactions, tier-scoped data redaction in code (not prompts), dealer
  pipeline nagging, per-client production status drafts, KB table repair,
  draft-verifier before Monday writes, template+rubric self-checks for
  scheduled skills.

## 2. System map (what talks to what)

```
Slack app A0ASRRXM7MM (bot U0ATL76PG9F, workspace "Oregon Five Star Enterprises")
  └─ Events API + slash cmd + reactions → POST https://oltre-dashboard.vercel.app/api/marco/slack
       (EXTERNAL FILE, in the oltre-dashboard repo: app/api/marco/slack/route.ts —
        signature verify, normalize, AWAITED tasks.trigger with idempotencyKey,
        GET = self-diagnostic probe)
  └─ Trigger.dev project proj_nvpgdhytpkikscybodkk, PROD env (deploy: npx trigger.dev deploy —
        a merged commit does NOTHING until deployed)
       ├─ comms/marco-slack-inbound   (src/tasks/marco-slack-inbound.ts — router → skills → reply)
       ├─ comms/marco-monday-update-draft, comms/marco-reaction-handler (Level-2 write flow)
       ├─ comms/marco-team-morning-brief (7:30a M-F), comms/marco-production-alert (*/30 biz hrs)
       └─ comms/marco-heartbeat (overnight; still stubbed)
  └─ Data: Monday GraphQL (lib/monday.ts — boards: Deals 6466800590, Leads 6466800613,
        Contacts 6466800570, OCD Schedule 5895399290, AR 2026 18393591112;
        KB = Monday Doc 40608915, ~2,035 blocks, loaded by lib/kb.ts)
     Upstash Redis (lib/redis.ts — conversation memory, drafts, KB cache marco:kb:v1,
        event dedup marco:evt:*, audit lists marco:log:*, deliverables, prodalert state)
     Anthropic API (lib/anthropic.ts + skills — claude-haiku-4-5 extraction/intent,
        claude-sonnet-5 composition/KB with thinking disabled + prompt caching)
```

Docs to trust: `STATUS.md` (2026-07-14 banner), `decisions/log.md`,
`ROADMAP.md`, `.claude/rules/slack-allowlist.md`. Older prose may lag code —
when docs and code disagree, the code + the 2026-07-14 decisions entries win,
and the mismatch itself is a finding.

## 3. Recent history you must know (so you don't re-litigate it)

- 2026-07-14: the "30-minute Marco" root cause was fixed — the Vercel route
  fired `tasks.trigger()` un-awaited and Vercel froze the lambda; all trigger
  sites are now awaited with idempotency keys + Redis dedup in-task.
- Same day: model tiering (Haiku 4.5 / Sonnet 5), parallelized Monday fan-out
  (`fuzzyFindItemsMulti`), KB ingest of sales sections 17–24, contacts→deals
  relation resolution (`getLinkedItems`), dealer-question routing, objection
  quick-draw, morning-brief + production-alert cron tasks (DRY_RUN=1),
  Redis audit logs. Deployed through v20260714.6.
- A Trigger.dev key mismatch briefly black-holed messages mid-day (fixed by
  re-pointing Vercel's MARCO_TRIGGER_SECRET_KEY at the canonical prod key).
  Note the failure was INVISIBLE — the route's catch returns 200 either way.

## 4. KNOWN OPEN BUGS — start here

1. **Channel mentions go silent (reported by Andrew 2026-07-14 ~1:31–1:37 PM).**
   He asked "What is his phone number?", then sent an image captioned
   "C26102 - Gene Brodsky what is his phone number", then "@Marco C26102 -
   Gene Brodsky what is his phone number" — three messages, zero responses.
   Suspected causes to verify in code:
   - `app_mention` in a channel Marco is not a member of: `chat.postMessage`
     and `reactions.add` both fail (`not_in_channel`), the never-silent catch
     posts to THE SAME channel and fails again → total silence. The bot HAS
     `channels:join` scope — evaluate auto-join for public channels, and a
     DM-the-asker fallback for private ones.
   - Messages whose `subtype` is `file_share` (image + caption): confirm the
     route passes them through and the caption reaches the router; there is
     no vision support, so decide the graceful answer ("I can't read images
     yet — paste the text").
   - Pronoun-only follow-up ("What is his phone number?") depends on
     conversation memory (lib/conversation.ts, DM-keyed, 5 turns/30 min) —
     channel threads have NO memory keying. Verify `thread_ts` handling
     end-to-end.
2. **Disambiguation dead-end:** when Marco lists "1. X / 2. Y — which one?",
   replying "1" starts a fresh classification and fails (STATUS.md backlog
   items 1–2). Also dedupe the candidate list (a real query returned
   "Christopher Stadler" three times — duplicate Leads rows).
3. **KB cold-load fragility:** lib/kb.ts pulls ~21 paginated Monday calls;
   under Monday rate-limit pressure the cold path times out and users see
   "couldn't load the knowledge base." Cache warming after doc writes, retry
   with backoff, and serving stale-on-error all need hardening.
4. **Trigger.dev runs LIST API lags** (direct GET by id works) — anything
   depending on run listing (diagnostics) should not trust list freshness.
5. **Phone-number-style column lookups:** verify a query like "C26102 — what
   is his phone number" actually routes somewhere that reads the Contacts
   phone column (deal code → linked contact → phone). If the deal-code path
   only reads Deals columns, the linked-contact hop is missing in reverse
   (deal → contact), mirroring the Kevin Stone fix (contact → deals).

## 5. Review mandate — what to examine

**A. Silent-failure sweep (top priority).** Trace EVERY inbound path
(DM, app_mention, slash, reaction, file_share, edited messages, thread
replies, Tier-3, bots) from Slack payload to posted reply. For each: what
happens when Slack retries? when the trigger fails? when Slack posting fails?
when the skill throws? when Monday/Redis/Anthropic are down or rate-limited?
Any path that can end with no user-visible output and no audit-log entry is a
Priority-1 finding.

**B. Speed.** p50/p95 budget per skill; remaining serial round-trips in
lib/monday.ts callers; cache-first opportunities (board snapshots in Redis,
Monday webhooks); prompt-cache hit verification (usage logging exists —
check the breakpoints are actually ≥ the per-model cacheable minimum);
`maxDuration` vs realistic worst cases.

**C. Consistency & correctness.** Router regex order and collisions (write
vs read vs dealer vs objection vs lead-check); the duplicated
`NormalizedSlackEvent` type across the two repos (drift risk by design —
suggest a checked mechanism); tier redaction is prompt-level only — design
the code-level enforcement (roadmap #4); Level-2 write flow race conditions
(reaction TTLs, one-draft rule, re-confirm >12h path); financial rule
"never let the model do arithmetic" — verify no path lets Claude sum rows.

**D. Security & hygiene.** Plaintext live credentials in `.env` (gitignored
but on disk — recommend rotation cadence + a secrets story); Slack signature
replay window; who can trigger what through the public route; audit-log
completeness for every write; the committed `scratch-kbwrite.mts` utility
(fine to keep, but check it can't run destructively by accident).

**E. Test coverage.** Only router tests exist (17). Propose the minimal
high-value harness: router table tests, skill-level tests with mocked Monday
fixtures, an idempotency/dedup test, and a smoke script (the repo pattern is
a signed synthetic Slack event POSTed to the route — see git history).

**F. Docs-vs-code cross-reference.** CLAUDE.md, STATUS.md, SKILL.md specs,
README, INSTALL vs actual code. Doc rot here has caused real outages (a
stale project ID nearly hid the trigger-key bug). Flag every remaining lie.

## 6. Output format

Produce `CODEX-FINDINGS.md`:
1. **P0 – silent-failure or data-integrity bugs** (repro path, file:line,
   fix sketch)
2. **P1 – speed/reliability** (expected user-visible gain)
3. **P2 – consistency/quality/tests**
4. **Quick wins** (≤1 hour each) vs **architectural** items, mapped to the
   ROADMAP.md numbering where they overlap
5. For each finding: severity, confidence, exact files, and a concrete fix —
   no "consider improving X" without saying how.

Constraints: do NOT print secrets from `.env` in your output. Do NOT change
`.claude/rules/slack-allowlist.md` semantics. Respect the decisions in
`decisions/log.md` (they are binding unless a finding proves one harmful —
then flag it explicitly as a decision-change proposal). The external Vercel
route file lives at `../oltre-dashboard/app/api/marco/slack/route.ts` if the
sibling repo is available; otherwise review its contract from this repo's
task headers and STATUS.md.
