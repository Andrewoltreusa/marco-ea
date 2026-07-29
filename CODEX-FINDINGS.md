# Codex Findings — Marco

Reviewed 2026-07-29.

## Scope and verdict

This review covered every tracked file in the Marco repository, including the
identity and decision documents, skill specifications, runtime libraries,
Slack routing, Trigger.dev tasks, scheduled work, tests, dependency lockfile,
and the image asset. It also covered the available sibling webhook at
`../oltre-dashboard/app/api/marco/slack/route.ts` and its Vercel cron.

I did not read `.env`, call a live write API, change the allowlist, or deploy
anything. `npm test` passes 17 tests in one router test file and
`npm run typecheck` passes. Those checks do not exercise Slack, Redis, Monday,
Anthropic, Trigger.dev, the sibling webhook, scheduled work, or any write
approval path.

Marco has several good foundations: Slack signatures are verified, the
webhook now awaits Trigger enqueueing, Monday write scope is rechecked at
execution time, financial arithmetic is computed in code, and many ordinary
exceptions are converted into user-facing messages. It is not yet reliable
enough to call “never silent,” safe enough to call the Monday flow exactly
once, or complete enough to match the conversational and proactive product
described in `CODEX-REVIEW.md`.

The P0 findings should block broader adoption and any expansion of write
authority. They do not require weakening the allowlist or changing the
binding `maxAttempts: 1` decision.

## P0 — Critical

### 1. An inbound event can be consumed before Marco acknowledges or answers it

**Locations:** `src/tasks/marco-slack-inbound.ts:66-79,109-122`;
`lib/redis.ts:42-44`;
`../oltre-dashboard/app/api/marco/slack/route.ts:254-272`;
`STATUS.md:43-48`.

**Why it matters:** `claimEvent()` runs before tier classification, before the
visible acknowledgement, and outside a top-level error boundary. If Redis is
unavailable, the one-attempt task ends with no acknowledgement. If the claim
succeeds and the worker is then killed, a later delivery returns
`deduped: true` even though no response was delivered. Trigger-level
idempotency and the route’s unconditional HTTP 200 can suppress other recovery
attempts as well. A delegated draft child can similarly leave the original
message at “drafting” forever. This is a direct reproduction class for the
historical silence failure.

**Concrete fix:** Replace the one-bit dedup key with a request lifecycle record
such as `received -> processing -> responded|failed`, plus a short processing
lease. Only `responded` is terminal. Classify tier before any state access,
make dedup failure non-fatal for Tier 1/2, and have an independent delayed
watchdog post a generic recovery message when no terminal delivery appears.
Record the final Slack message timestamp in that lifecycle. Keep
`maxAttempts: 1`; recovery should be explicit and idempotent rather than a
blind whole-task retry.

### 2. Network calls can outlive their task, so the “never silent” catches never run

**Locations:** `lib/anthropic.ts:15-24`;
`src/skills/general-query.ts:145-160,209-218`;
`src/skills/kb-query.ts:114-124`;
`lib/monday.ts:24-46`;
`lib/kb.ts:41-69`;
`lib/slack.ts:24-40`;
`src/skills/agent-fleet-health.ts:19-31`;
task limits at `src/tasks/marco-slack-inbound.ts:50-58`,
`src/tasks/marco-monday-update-draft.ts:51-57`, and
`src/tasks/marco-reaction-handler.ts:65-71`.

**Why it matters:** The installed Anthropic SDK defaults to a ten-minute
request timeout and two retries, while Marco’s tasks stop after 30, 60, or 120
seconds. The raw `fetch` calls have no abort deadline. Trigger.dev stops a run
that reaches `maxDuration`; code after the stopped await, including the
user-facing catch, does not execute. A slow Anthropic, Monday, Slack, dashboard,
or Trigger call can therefore leave no final response.

**Concrete fix:** Build central clients with an end-to-end deadline budget.
Set Anthropic `timeout` and `maxRetries` explicitly, use
`AbortSignal.timeout()` for fetches, honor `Retry-After` only when the remaining
budget permits, and reserve several seconds for the fallback Slack delivery.
Put a sub-three-second timeout around webhook enqueueing because Slack requires
the HTTP acknowledgement within three seconds. Trigger.dev’s hard-stop
behavior is documented in its
[max-duration guide](https://trigger.dev/docs/runs/max-duration), and Slack’s
acknowledgement/retry contract is in the
[Events API documentation](https://docs.slack.dev/apis/events-api/).

### 3. Tier-sensitive data is filtered by prompt, not by code, and conversation state crosses users

**Locations:** `src/skills/general-query.ts:40-46,87-112,219-290,335-340`;
`src/skills/kb-query.ts:119-148`;
`lib/conversation.ts:23-43`;
`src/tasks/marco-slack-inbound.ts:234-269`;
`../oltre-dashboard/app/api/marco/slack/route.ts:242-252,278-325`;
`.claude/skills/cash-position/SKILL.md:30-45`;
`ROADMAP.md:15`.

**Why it matters:** General query gives Claude all matched columns and updates,
and for a financial question the complete raw AR board plus full aggregates.
Tier 2 receives the same data and only a one-line instruction not to reveal
it. KB content is handled the same way. The function receives only `tier`, so
it cannot enforce the documented difference between Alex P and Bella/Alex T.
Conversation history is keyed only by Slack channel and is enabled for shared
channels, not just DMs, allowing users and threads to contaminate one another.
Slash and mention answers are posted back to the originating channel, where
the audience may be broader than the requester’s tier. This violates the
non-negotiable rule before model behavior is considered.

**Concrete fix:** Derive a capability object from the canonical Slack user,
then code-filter boards, rows, columns, update text, and KB sections before
they enter a model prompt. Do not hydrate unauthorized data. Key memory by
workspace, user, DM channel, thread, and policy version; disable it in shared
channels. Route sensitive results to the requester’s DM, and use a separately
validated team-safe response schema for channel replies. This is the queued
“tier-scoped hydration” item and should be promoted to P0.

### 4. The approval path is not exactly once

**Locations:** `src/tasks/marco-reaction-handler.ts:54-63,82-182`;
`lib/redis.ts:91-112`;
`../oltre-dashboard/app/api/marco/slack/route.ts:40-51,201-234`;
binding decision at
`decisions/2026-04-15-phase-6a-level-2.md:52-58`.

**Why it matters:** Two accepted reactions can read the same pending draft and
both call `create_update`. Different accepted emoji names use different route
idempotency keys. More seriously, Monday mutation, Slack confirmation, draft
deletion, and audit logging share one `try`. If Monday succeeds but Slack or
Redis fails afterward, the handler records “failed,” leaves the draft
reusable, and can post the same update again. The code also accepts thumbs-up
and several alternate checkmarks even though the binding decision authorizes
only `white_check_mark`.

**Concrete fix:** Atomically compare-and-set `pending -> executing` in Redis,
with requester, preview channel, current tier, and exact reaction validation in
the same operation. Only the winner may call Monday. Persist
`posted + updateId + bodyHash` immediately after mutation success, then deliver
confirmation independently. Treat an ambiguous Monday timeout as
`outcome_unknown` and reconcile before permitting another write. Accept only
`white_check_mark` until a new written decision says otherwise.

### 5. A high-scoring duplicate can select the wrong Monday item, and attribution is not server-verified

**Locations:** `src/tasks/marco-monday-update-draft.ts:134-186`;
`lib/anthropic.ts:43-124`;
`ROADMAP.md:24-26`;
binding attribution rule at
`decisions/2026-04-15-phase-6a-level-2.md:69-73`.

**Why it matters:** The draft code considers a top score of at least 0.9
confident even when the second candidate has the identical score. The roadmap
already records a real triple-duplicate case. Selection order then decides
which card receives the update. The preview shows only name and board, which
may not distinguish duplicates. Separately, Tier-2 self-signature is enforced
only by appending the canonical signature. Model-produced content is not
rejected if it already contains a conflicting “via Marco” attribution, so a
Tier-2 user can produce misleading double attribution despite the documented
server-side override. The same unconditional signature code also removes Tier
1’s binding freedom to choose another attribution.

**Concrete fix:** Never auto-select when another candidate is close or exact,
regardless of the top score. Show item link, item ID/deal code, company, and
other safe distinguishing fields; persist the candidate list and support the
documented numeric continuation. Before preview and again before execution,
run deterministic validation that removes or rejects signatures,
impersonation language, forbidden mutation requests, and out-of-scope content.
For current Tier 1 only, parse and display an explicit requested attribution;
continue forcing the canonical self-signature for Tier 2.

## P1 — High

### 6. Reaction failure and Tier-1 reconfirmation still contain silence paths

**Locations:** `src/tasks/marco-reaction-handler.ts:82-138,164-183`;
`lib/redis.ts:77-89`;
`../oltre-dashboard/app/api/marco/slack/route.ts:215-234`.

**Why it matters:** Reaction enqueue failure is deliberately log-only while
the route returns 200, so Slack does not retry. Redis lookup, cancellation,
reconfirmation, and several notification calls have no outer error boundary.
Tier-1 drafts expire from Redis at exactly 12 hours, making the “older than 12
hours” branch normally unreachable. If a draft does survive, the comment says
`createdAt` is reset but no state is written, so reconfirmation loops.

**Concrete fix:** Add an outer reaction-handler boundary after the reactor tier
check and notify the requester in the preview DM when approval could not be
processed. Keep a longer-lived Tier-1 tombstone while retaining the 12-hour
execution window, and create a new reconfirmation message/draft ID with an
explicit `reconfirmedAt`. Preserve the binding silent-expiry behavior for
Tier 2.

### 7. Draft previews and Tier-2 single-draft enforcement do not match the binding flow

**Locations:** `src/tasks/marco-slack-inbound.ts:124-154`;
`src/tasks/marco-monday-update-draft.ts:31-38,93-105,188-223`;
`lib/redis.ts:77-88`;
binding flow at `decisions/2026-04-15-phase-6a-level-2.md:35-58`.

**Why it matters:** The child receives the originating reply channel and posts
the exact draft there. A mention or slash write can expose the draft in a
channel instead of DMing the requester. The Tier-2 “one active draft” check
and later two-key write are not atomic, so simultaneous requests can both
create valid previews. The preview is posted before it is stored, leaving a
small but real unapprovable window. The child also trusts tier and name values
from its payload instead of re-deriving them.

**Concrete fix:** Either require write intents to originate in DM or always
open a requester DM and post the preview there. Pass only the Slack user ID
across the child-task boundary and re-derive identity/tier from the canonical
allowlist. Reserve the Tier-2 slot atomically before parsing, transactionally
store the draft, and bind approval to an opaque draft ID. Block Kit buttons can
improve the UX later but do not replace the atomic state transition.

### 8. Slack fallback delivery is not durable

**Locations:** `lib/slack.ts:24-40,43-100`;
`src/tasks/marco-slack-inbound.ts:155-175,179-228`;
`src/tasks/marco-monday-update-draft.ts:59-80`;
`../oltre-dashboard/app/api/marco/slack/route.ts:53-77`.

**Why it matters:** The channel-post catch awaits a DM fallback without a
second catch. Draft-task errors retry the same source channel and then swallow
failure. The route’s emergency `fetch` never checks Slack’s JSON `ok`, so an
HTTP 200 carrying `invalid_auth` or `not_in_channel` is treated as delivered.
Ambiguous Slack responses have no stable delivery record, making safe retry
impossible.

**Concrete fix:** Inspect HTTP status and Slack’s `ok` field everywhere, add
bounded rate-limit-aware retries, and persist a delivery outbox keyed by
request/draft ID. Catch and record failure of the DM fallback itself. Separate
answer generation from delivery so a generated answer can be retried without
re-querying systems or duplicating a Monday write.

### 9. Tier-3 rate limiting and ingress ordering violate the canonical rule

**Locations:** `src/slack/router.ts:50-70`;
`src/slack/allowlist.ts:24-33`;
`src/tasks/marco-slack-inbound.ts:66-106`;
`src/tasks/marco-reaction-handler.ts:82-94`;
`../oltre-dashboard/app/api/marco/slack/route.ts:259-325`.

**Why it matters:** The 24-hour refusal limiter is a process-local `Map` in a
serverless system, so cold or parallel workers can send repeated refusals.
Inbound claims Redis before classifying the sender; the reaction handler reads
a draft before classifying the reactor. Slash commands return “looking it up”
to every caller before the Tier-3 decision, and route-side enqueue errors can
also message Tier 3. Bot-like users are represented as ordinary Tier 3 rather
than a distinct silent-ignore result.

**Concrete fix:** Perform the canonical tier/bot check first. Use an atomic
Redis `SET NX EX 86400` for Tier-3 refusal rate limiting and a distinct
`ignored_bot` outcome. Make edge acknowledgements and error notices
allowlist-aware without maintaining an independently editable second policy.
Continue logging every denied attempt as required.

### 10. The webhook accepts callback shapes it does not support

**Locations:** `../oltre-dashboard/app/api/marco/slack/route.ts:198-252`.

**Why it matters:** After the reaction branch, every non-bot event callback is
treated as either an app mention or DM message. Message edits, deletes, file
subtypes, or a future subscription can produce malformed requests and
unintended refusals. Reaction handling occurs before bot filtering, so Marco’s
own final-state check reaction can create a useless handler run. There is no
workspace/team assertion.

**Concrete fix:** Whitelist `app_mention` and plain `message` events with the
expected channel type and supported subtypes. Validate user, channel, text,
timestamp, team, and event ID before enqueueing. Filter Marco’s own bot user
before the reaction branch. Add signed fixture tests for every accepted and
ignored payload.

### 11. The public diagnostic endpoint leaks operational metadata, consumes runs, and can report false green

**Locations:** `../oltre-dashboard/app/api/marco/slack/route.ts:80-166`;
`../oltre-dashboard/vercel.json:1-7`;
`STATUS.md:50-51`.

**Why it matters:** Any unauthenticated GET can enqueue a Trigger run and see
environment presence, deployment metadata, a Trigger run ID, failure text,
and a prefix of the active key. The response calls enqueue acceptance
“SUCCESS”; it does not wait for the probe task result. The probe exits before
checking Slack, Redis, Monday, Anthropic, KB configuration, or allowlist
behavior. The old shared-project key fallback can target the wrong project.
An attacker can also burn Trigger runs by repeatedly calling the endpoint.

**Concrete fix:** Make public liveness passive and minimal. Put the deep
diagnostic behind strong authentication and rate limiting, remove all key
prefixes and the obsolete project-key fallback, and verify task completion
plus deployed commit SHA. A proper canary should perform non-mutating
dependency checks and verify a test delivery, not merely enqueue a task.

### 12. Both production Monday clients request an obsolete API version

**Locations:** `lib/monday.ts:24-31`;
`lib/kb.ts:41-52`;
`scratch-kbwrite.mts:10-18`.

**Why it matters:** Runtime requests `2024-01`. Monday lists versions earlier
than `2025-04` as deprecated/unsupported and may transparently route a
deprecated request to a maintenance version. The code therefore is not
actually pinned to the schema it declares, and behavior can change without a
Marco deploy.

**Concrete fix:** Centralize the GraphQL transport, test against and pin a
currently supported stable version, inspect/log the effective response
version, and add a quarterly schema contract test. See Monday’s
[version lifecycle](https://developer.monday.com/api-reference/docs/api-versioning)
and [release notes](https://developer.monday.com/api-reference/docs/release-notes).

### 13. Board reads can silently turn missing or truncated data into authoritative answers

**Locations:** `lib/monday.ts:106-164,252-330`;
`src/skills/general-query.ts:77-120`;
`src/tasks/marco-production-alert.ts:93-119`;
`src/tasks/marco-team-morning-brief.ts:79-118`.

**Why it matters:** Every board scan stops at 500 items and ignores the cursor.
`getBoardItems()` returns an empty successful board when the requested board is
missing or inaccessible. Consumers then call the totals authoritative or say
that nothing is flagged. As boards grow, Marco can miss a client, understate
AR, and suppress a production alert without any explicit source error.

**Concrete fix:** Cursor-paginate until completion, throw when a requested
board is absent, and return source metadata including item count, page count,
effective API version, fetched time, and completeness. Refuse to publish
financial totals or “nothing flagged” when completeness is not proven.
Monday’s [board-items pagination guide](https://developer.monday.com/api-reference/docs/querying-board-items)
documents the cursor flow.

### 14. Financial availability and month semantics can produce confident wrong numbers

**Locations:** `lib/ar.ts:52-68,81-150`;
`src/skills/general-query.ts:77-79,114-131,244-290,324-327`;
`.claude/skills/cash-position/SKILL.md:30-45`.

**Why it matters:** AR fetch failure is converted to `null`, after which the
model still composes instead of clearly saying the source is unavailable. The
month bucket prioritizes a column ID described in code as a ship-date
duplicate, but the prompt presents that bucket as “contracted in April.”
Those are different business questions. The full board is also serialized
with both title and `#columnId` copies of every field, increasing cost,
latency, and leakage surface.

**Concrete fix:** Maintain a tested AR schema keyed by canonical column IDs and
name each date dimension explicitly. Fail closed on unavailable or incomplete
AR data. For aggregate questions send only computed aggregates; for a named
client send only a code-selected row and allowed fields. Add fixture totals
for overall, status, aging, contract month, payment month, and remaining
balance.

### 15. The KB cache still performs the expensive source read on cold workers

**Locations:** `lib/kb.ts:75-86,331-415`;
binding cache-first decision at `decisions/log.md:35`.

**Why it matters:** The loader reads Redis, then paginates the entire Monday
doc before returning it. On short-lived Trigger workers, the in-process cache
provides little benefit and Redis does not remove source latency. A one-hour
Redis expiry also means there is no genuinely long-lived last-known-good copy
during a longer Monday outage. Concurrent cold runs can stampede the doc API.

**Concrete fix:** Return a fresh Redis snapshot immediately, refresh only
source metadata in the background or after a refresh deadline, and use a
single-flight lock. Store last-known-good content longer than the freshness
window and include source version/hash, fetched time, validation status, and a
stale marker.

### 16. KB reconstruction has no completeness contract and can drop structured content

**Locations:** `lib/kb.ts:126-186,196-267`;
`scratch-kbwrite.mts:25-40`;
`ROADMAP.md:12`.

**Why it matters:** The doc query omits parent/position information even
though the migration notes describe a heavily nested document. Generic nested
content extraction returns the first text it finds, so complex table blocks
can lose remaining cells. There is no sentinel-section, minimum-size, block
count, or hash validation before new content replaces the cache. The roadmap
already says roughly 40 percent of table material is damaged, yet KB answers
can still sound authoritative.

**Concrete fix:** Reconstruct block hierarchy and order, render every supported
table/list block completely, and preserve unsupported block diagnostics. Gate
cache promotion on required sections, expected ranges of block/character
counts, and a content hash/version. Run a curated question/citation suite
against each new KB snapshot before making it active.

### 17. KB availability and routing are not reproducible from the install configuration

**Locations:** `src/tasks/marco-slack-inbound.ts:253-277`;
`src/skills/kb-query.ts:99-177`;
`lib/kb.ts:331-337`;
`INSTALL.md:63-74`;
`STATUS.md:123-129`.

**Why it matters:** Runtime requires `ENABLE_KB=true` and
`MARCO_KB_DOC_ID`, but the install guide does not list either. When KB is
disabled or the Anthropic KB call throws, an SOP/playbook request silently
falls through to Monday-only `generalQuery`, which can return a plausible but
ungrounded answer. The diagnostic probe does not test the KB.

**Concrete fix:** Validate all required configuration at deployment and expose
its non-secret status in an authenticated health check. For a KB-routed
question, return a clear KB-unavailable answer rather than switching to an
unrelated data source. Make the known doc ID an explicit, tested deployment
configuration and run post-deploy canonical SOP questions.

### 18. Routing and entity extraction fail common live-data questions

**Locations:** `src/slack/router.ts:97-220,351-360`;
`src/skills/general-query.ts:9-15,145-207,219-240`;
`STATUS.md:101-116`.

**Why it matters:** Broad `^how` routing sends questions such as “how many
leads” to the KB. The general-query extractor intentionally returns no search
terms for board-wide questions such as deals closing this week, but no board
aggregate is then loaded. The examples claim those questions work. The
subject regex can include trailing words such as “ship,” and “has [name]
gotten back” is not reduced to the name. Dedicated skills accept very
low-scoring candidates, increasing false matches. Keyword skill answers are
not stored in conversation history, so pronoun follow-ups fail.

**Concrete fix:** Use a structured query plan with intent, entity, board,
filters, date range, and aggregation, while retaining deterministic
write-intent safety gates. Compute board-wide counts/filters in code. Unify
conversation capture after every delivered answer and add a golden corpus
that asserts both routed skill and extracted arguments for real team
phrasings, Russian input, pronouns, duplicates, and numeric disambiguation.

### 19. Several advertised conversational skills do not implement their contracts

**Locations:** `.claude/skills/deal-status/SKILL.md:18-22` versus
`src/skills/deal-status.ts:27-147`;
`.claude/skills/lead-check/SKILL.md:14-31` versus
`src/skills/lead-check.ts:14-87`;
`.claude/skills/find-in-vault/SKILL.md:14-39` versus
`src/tasks/marco-slack-inbound.ts:279-283`;
`.claude/skills/agent-fleet-health/SKILL.md:14-40` versus
`src/skills/agent-fleet-health.ts:19-66`.

**Why it matters:** Deal status omits its promised AR and recent allowed-vault
context. Lead check does not inspect Outlook, so it cannot reliably answer
whether someone replied. Find-in-vault is only a label for Monday general
query. Fleet health ignores the specified error/health sources. These are
high-frequency promises; confident partial answers will erode trust faster
than an explicit limitation.

**Concrete fix:** Implement each contract or narrow its name, documentation,
and wording immediately. Until inbox access has a current binding decision,
lead check must say “Monday shows” and explicitly state that it did not verify
email. Build vault search through a trusted ingestion job that indexes only
the AGENTS-allowed paths and carries tier metadata; do not mount or ingest
forbidden paths.

### 20. Fleet health can call “unknown” healthy and contains a committed credential

**Locations:** `src/skills/agent-fleet-health.ts:8-43`;
related state shape at `../oltre-dashboard/app/api/state/route.ts:9-12`;
credential references in `COMPANY.md:41-45` and
`decisions/2026-04-15-phase-3-integrations.md:7-12`.

**Why it matters:** `unknown` is considered healthy because only literal
`down` and `error` are degraded. The dashboard state has an update timestamp,
but Marco neither reads nor checks it, despite the binding decision that some
dashboard state is stale. The tracked source also embeds a bearer credential
instead of loading it from a task-scoped secret; the GET endpoint currently
does not even use that header for authorization.

**Concrete fix:** Treat missing, unknown, or stale state as `unknown`, never
healthy. Use a real health endpoint with last-check time, failing task counts,
and explicit freshness. Rotate the committed credential, remove it from code
and operational prose, use an environment secret only where authentication is
actually enforced, and add secret scanning. The credential value is
intentionally not repeated here.

### 21. The proactive product is incomplete, mostly not live, and the heartbeat is a false green

**Locations:** `src/tasks/marco-heartbeat.ts:21-66`;
`CLAUDE.md:22-26`;
`ROADMAP.md:16,24-27`;
`README.md:9,27-31,53-57`;
binding destination decision at `decisions/log.md:7-12`.

**Why it matters:** Friday rollup and weekly SWOT have specifications but no
tasks. The heartbeat runs 18 times each night, logs three stubs, and returns
success; its claimed draft is not consumed by the morning task. Morning brief
and production alert default to preview mode, so the team does not currently
receive the promised proactive surface. The live-state portion is blocked by
Andrew’s binding destination/go-live decision, not something code should
silently bypass.

**Concrete fix:** Disable the no-op heartbeat until it performs real,
observable work. Implement the missing weekly tasks with code-computed facts,
artifact/delivery records, and dry-run evaluation. Andrew must explicitly
choose an approved destination and authorize the live flip in a new decision;
until then, keep Andrew-only previews.

### 22. Production alerts can suppress an alert that nobody received

**Locations:** `src/tasks/marco-production-alert.ts:46-80,107-164`;
`.claude/skills/production-alert/SKILL.md:18-40`.

**Why it matters:** DM errors are caught, but every flag is still written to a
shared 24-hour dedup key and the task reports success. One recipient can miss
an alert and never be retried. Dry runs write the same live dedup state, so
turning live within 24 hours can suppress Alex T.’s first real alert. The task
also omits the specified “ship date slipped by more than three business days”
trigger and last-update context.

**Concrete fix:** Track delivery and dedup per item, state, and recipient.
Mark only successful live deliveries; dry runs must use separate preview state.
Persist every observed ship date, compute business-day movement, include
`updated_at`, and alert Andrew after repeated source or recipient-delivery
failures.

### 23. The morning brief is materially thinner than its specification and can violate the destination decision

**Locations:** `.claude/skills/team-morning-brief/SKILL.md:16-43`;
`src/tasks/marco-team-morning-brief.ts:38-68,79-184`;
`decisions/log.md:7-12`.

**Why it matters:** The task reports counts by every stage but omits open
pipeline value, movement, expected closes, AR aging, and wins. It uses seven
calendar days rather than five business days for production. Claude output is
sent without validating required sections, figures, length, punctuation, or
forbidden content. A stale office-channel environment value plus
`DRY_RUN=0` can post to the destination Andrew explicitly prohibited.

**Concrete fix:** Compute the contracted fact set deterministically and prefer
a code template. Validate every number and voice rule before delivery. Until a
new destination decision exists, hard-code Andrew DM as the only allowed
target rather than relying on an environment convention. After a decision,
use an explicit approved-destination allowlist, not an office-specific legacy
variable.

### 24. Artifact persistence can block delivery and does not prove delivery

**Locations:** `lib/deliverables.ts:14-38`;
`src/tasks/marco-production-alert.ts:138-158`;
`src/tasks/marco-team-morning-brief.ts:157-180`.

**Why it matters:** `saveDeliverable()` is awaited before Slack and is not
best-effort, so a Redis outage prevents the actual alert or brief. Every
same-day production alert overwrites the same key. Keys use UTC dates and
contain no run ID, source health, dry-run state, intended recipients, Slack
timestamps, or per-recipient result.

**Concrete fix:** Make user delivery and archival independent. Store immutable,
Pacific-timestamped structured records with a latest pointer, request/run ID,
deployed SHA, source completeness, content hash, intended recipients, delivery
results, and Slack timestamps. Archival failure must not block an urgent
message.

### 25. Deployment commands are broken and there is no proof that HEAD is deployed

**Locations:** `package.json:7-13`;
`STATUS.md:11-21,131-135,157-172`;
`CLAUDE.md:72-74`;
`trigger.config.ts:15-33`.

**Why it matters:** Every npm Trigger script invokes `trigger.dev`, but the
installed package exposes `trigger`; `npm run trigger:dev -- --help` fails
locally. There is no predeploy gate, CI workflow, commit SHA in the deployment,
or checked record mapping Trigger version to Git commit. STATUS’s last known
production series predates current HEAD and elsewhere contradicts itself about
staging versus production. A merge can appear finished while production still
runs older behavior.

**Concrete fix:** Correct scripts to the pinned local executable, add
`predeploy` for clean install, typecheck, tests, lint, secret scan, and contract
smokes, and deploy the exact tested lockfile. Embed the Git SHA in every task
run and authenticated health result. Verify the completed post-deploy canary
and record environment, Trigger version, SHA, and rollback version.

### 26. The install guide would create a silent or approval-broken installation

**Locations:** `INSTALL.md:41-100,120-138`;
binding webhook architecture at `decisions/log.md:133-147`.

**Why it matters:** The guide points Slack at a nonexistent direct Trigger HTTP
endpoint instead of the Vercel route, omits the `reaction_added` subscription,
lists only two tasks, omits the Vercel/Trigger/Redis/KB configuration matrix,
expects local memory/deliverables, and includes pre-Level-2 instructions.
Following it cannot reproducibly recreate today’s system.

**Concrete fix:** Replace it with a checked Slack app manifest and an
environment-by-environment runbook. Include the Vercel URL, every scope/event,
all six current tasks, all non-secret configuration names, project identity,
and signed end-to-end tests for DM, mention, slash command, Tier 3, KB, source
failure, draft preview, cancellation, and one harmless approved update.

## P2 — Important

### 27. “Anyone on the team” currently means only four allowlisted people

**Locations:** `.claude/rules/slack-allowlist.md:11-58`;
`src/slack/allowlist.ts:17-33`;
`COMPANY.md:22-29`.

**Why it matters:** The owner brief describes a roughly ten-person team where
anyone can ask Marco, but the binding allowlist authorizes four people. Every
other teammate is correctly treated as Tier 3 by current policy. This is a
product-policy gap, not permission to infer new users.

**Concrete fix:** Andrew must make a written onboarding decision containing
the exact Slack IDs and tiers for any additional teammates, then update the
canonical allowlist and tests through its protected process. Do not auto-add
workspace members or weaken Tier-3 behavior.

### 28. Tests and CI do not cover the guarantees the documentation makes

**Locations:** `src/slack/router.test.ts:1-130`;
`tsconfig.json:15-16`;
`.claude/rules/slack-allowlist.md:68-73`;
`package.json:7-13`;
absence of `.github/workflows/`.

**Why it matters:** The 17 passing tests assert router labels and four IDs.
They do not test extracted arguments, webhook signatures and normalization,
Redis failure, response lifecycle, Slack fallback, tier hydration, KB parsing,
AR math, pagination, duplicate candidates, approval concurrency, successful
Monday write followed by notification failure, cron behavior, or brand voice.
Tests are excluded from `tsc`, and the rule’s claim that CI blocks failures is
not true.

**Concrete fix:** Add required CI for `npm ci`, typecheck including tests,
lint/format, dependency and secret scans, and Vitest. Add mocked
route-to-task integration and failure-injection tests, plus a concurrency test
that proves one Monday mutation per draft. Maintain a sanitized golden Slack
query/evaluation corpus and require it before Trigger deployment.

### 29. The canonical allowlist can drift while its tests remain green

**Locations:** `.claude/rules/slack-allowlist.md:3-5`;
`src/slack/allowlist.ts:1-22`;
`src/slack/router.test.ts:12-30`.

**Why it matters:** Markdown, compiled code, and tests manually repeat the same
IDs. Changing only the canonical Markdown leaves code and tests mutually
consistent and green while runtime policy is wrong.

**Concrete fix:** Keep the protected Markdown as human policy, but generate the
runtime table and test fixtures from a reviewed machine-readable canonical
artifact, or parse and compare the Markdown in CI. Fail on any missing, extra,
tier-mismatched, duplicate, or bot-like ID.

### 30. Operational documentation is mutually contradictory

**Locations:** `README.md:5-16,47-57`;
`STATUS.md:15-24,43-51,86,123-135`;
`AGENTS.md:36-75`;
`INSTALL.md:77-138`;
`CLAUDE.md:22-35,54-74`;
skill specs throughout `.claude/skills/`.

**Why it matters:** Examples include production-live versus staging-only,
Tier-2 read-only versus Level-2 writes, local memory versus Redis, four
scheduled broadcasts versus two implementations, `/m` versus `/marco`, and a
“never silent” guarantee that omits hard kills and fallback failure. AGENTS
also says Tier-2 writes should be refused in one section despite the later
binding Level-2 decision. These contradictions will cause the next maintainer
or deployment to reintroduce failures.

**Concrete fix:** Preserve the append-only decision log, but make one generated
current-state/runbook page authoritative for deploy facts. Mark old prose as
historical or superseded, update AGENTS to the current binding decision, and
make each skill spec explicitly say `implemented`, `partial`, `blocked`, or
`spec only`. Validate documentation claims in CI where possible.

### 31. Brand voice and work-only scope are prompt suggestions, not validated output

**Locations:** `lib/marco-persona.ts:11-30`;
`src/skills/general-query.ts:301-340`;
`src/skills/kb-query.ts:34-73`;
`src/slack/router.test.ts:69-73`;
`ROADMAP.md:29-33`;
`COMPANY.md:11-18`.

**Why it matters:** The stable persona omits the binding “six weeks, never 30
days” rule. KB prompt text encourages unsupported “common sense” answers,
contains a stale Sendblue date rule, and code/tests retain church examples
despite the July work-only decision. Model output is not checked for
exclamation marks, emoji, prohibited personal domains, unsupported citations,
or the lead-time phrase. Error messages expose internal skill names and raw
backend fragments rather than Marco’s normal voice.

**Concrete fix:** Generate one policy/persona block from binding sources and
use it everywhere. Add deterministic output validation and correction for
forbidden punctuation/content, lead-time language, citations, and sensitive
terms; keep internal errors only in logs. Remove the church examples now. The
July acknowledgement/approval reactions conflict with the broader “no emoji”
wording, so Andrew should record whether status reactions are an explicit
exception rather than code silently choosing one interpretation.

### 32. There is no durable query audit, latency SLO, or missed-run monitor

**Locations:** `src/tasks/marco-slack-inbound.ts:81-95,305-328`;
`src/tasks/marco-reaction-handler.ts:25-40`;
`src/tasks/marco-production-alert.ts:93-164`;
`src/tasks/marco-team-morning-brief.ts:75-184`;
`AGENTS.md:36-54`.

**Why it matters:** Redis audit trails exist for denials and write incidents,
but successful/failed read queries are only in Trigger logs. There is no
durable event-to-response latency, source freshness, delivery status, or alert
when an expected cron never fires. It is therefore difficult to prove whether
Marco answered, identify recurring misses, or measure the “seconds, not
minutes” goal.

**Concrete fix:** Persist a bounded structured audit record for every request
and scheduled run: correlation ID, user/tier, intent, source timings and
freshness, outcome, final delivery timestamp, deployed SHA, and sanitized error
code. Define acknowledgement and final-response SLOs and alert Andrew on stale
requests, repeated dependency failures, or missed cron windows. Avoid storing
more message content than the existing policy requires.

### 33. Configuration and contracts are duplicated across repositories and clients

**Locations:** reaction sets in
`src/tasks/marco-reaction-handler.ts:54-63` and
`../oltre-dashboard/app/api/marco/slack/route.ts:33-51`;
Monday transports in `lib/monday.ts:13-47` and `lib/kb.ts:30-69`;
personas in `lib/marco-persona.ts` and
`src/skills/general-query.ts:301-340`;
board/user IDs throughout `COMPANY.md`, tasks, and specs;
SDK versions in both repositories’ `package.json`.

**Why it matters:** The two repositories can deploy independently, payloads
have no schema version, reaction policy is copied, SDK patch versions differ,
and no cross-repo contract test exists. Monday error/version behavior and
persona rules have already drifted. Missing configuration is discovered only
when a teammate asks a question.

**Concrete fix:** Define versioned payload schemas and a small shared/generated
contract artifact for task names, event shapes, exact reaction policy, and
canonical IDs. Centralize Monday transport and policy composition inside
Marco. Add boot/deploy-time environment validation and cross-repo fixture
tests, while retaining independent deployability.

### 34. Runtime dependencies have unresolved advisories

**Locations:** `package.json:15-24`; `package-lock.json`.

**Why it matters:** `npm audit --omit=dev` reports 26 advisories in the runtime
tree, including seven high-severity advisories, largely through the old
Trigger/OpenTelemetry tree plus protobuf and WebSocket dependencies. Not every
advisory is necessarily reachable in Marco, but a reference build should
document and eliminate or explicitly accept them.

**Concrete fix:** Upgrade Trigger CLI and SDK together and upgrade the
Anthropic SDK in a controlled branch. Review breaking changes, then run the
expanded tests, a staging canary, write-flow concurrency tests, and a verified
production deployment. Do not run a blind forced audit fix.

### 35. A tracked temporary script bypasses Marco’s authorized mutation boundary

**Locations:** `scratch-kbwrite.mts:1-85`; `tsconfig.json:15-16`.

**Why it matters:** The script directly calls a Monday doc mutation outside
Marco’s sole runtime authorization (`create_update` on three boards). It has a
dead machine-specific temporary path, no confirmation, dry run,
idempotency, tests, or audit record, and its own comment says it should have
been deleted. It is excluded from typecheck. Accidental execution with a
credential can duplicate or corrupt the live KB.

**Concrete fix:** Remove it from the runtime repository. If its history is
needed, move it to an isolated admin-migrations area with an explicit written
decision, immutable input, dry-run diff, interactive confirmation,
idempotency, supported API version, tests, and audit output.

### 36. The checked icon does not match its documented visual specification

**Locations:** `Marco Icon.png`; `INSTALL.md:34-37`.

**Why it matters:** The asset is a gold serif “M” on white, while the install
guide specifies the Oltre Craftsman treatment with a cobalt accent and calls
the asset a placeholder. This is low operational risk, but a stable,
recognizable identity matters for adoption and for a reference deployment.

**Concrete fix:** Confirm the intended Slack icon, replace the placeholder with
the approved asset, and update the installation manifest/runbook so the
deployed identity is reproducible.

## Recommended repair order

1. Build the request lifecycle/watchdog and bounded network clients so silence
   is observable and recoverable.
2. Make approval atomic and exactly once; restrict the exact approval emoji;
   fix duplicate disambiguation and DM-only previews.
3. Implement code-side tier hydration and isolated DM memory before expanding
   access.
4. Upgrade/paginate Monday, define the AR schema, and harden KB caching and
   completeness.
5. Fix the webhook diagnostic, install manifest, deploy scripts, CI, and
   commit-to-deployment traceability.
6. Bring each conversational and scheduled skill up to its declared contract,
   then run dry-run scoring before Andrew makes the required destination/live
   decision.

## Validation evidence

- `npm test`: passed, one test file, 17 tests.
- `npm run typecheck`: passed.
- `npm run trigger:dev -- --help`: failed because the script names a
  nonexistent executable.
- `npm audit --omit=dev --audit-level=moderate`: reported 26 advisories,
  including seven high-severity advisories.
- Git worktree was clean before this findings file was added.
- The sibling Slack route was available and reviewed.
- Live Slack, Monday, Redis, Anthropic, Trigger deployment state, and
  environment values were intentionally not mutated or inspected.
