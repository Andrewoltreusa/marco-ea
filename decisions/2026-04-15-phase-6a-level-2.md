# Phase 6a — Marco promoted to Level 2 (Draft & Wait)

**Date:** 2026-04-15
**Decided by:** Andrew Shpiruk (verbal in Slack session)
**Supersedes:** the 2-week Level-1 freeze and the "Tier 2 read-only forever" rule from the initial Marco scaffold
**Related files:**
- `SOUL.md` — trust ladder section rewritten
- `.claude/rules/slack-allowlist.md` — Tier 1 + Tier 2 capability rows rewritten
- `COMPANY.md` — team table updated
- `src/slack/router.ts`, `src/tasks/marco-monday-update-draft.ts`, `src/tasks/marco-reaction-handler.ts` — code that enforces this decision

## What changed

Marco was scaffolded with the rule *"Level 1 for a minimum of 2 weeks; Tier 2 stays read-only forever."* That rule is relaxed today, six hours after Marco went live, for two reasons:

1. **Level 1 stubs proved the full plumbing works end-to-end** (slash command + DM + router + Trigger.dev task + outbound post). There is nothing left to learn from staying at Level 1. The 2-week freeze was insurance against unknown integration risk — that insurance paid out already.
2. **The "Tier 2 never writes" rule was designed before we had a signature-based attribution mechanism.** The concern was blast radius: if Marco wrote on Bella's behalf and something was wrong, the audit trail would point at Andrew (the API key owner). With the `— {Name} via Marco` signature pattern and the ✅-reaction gate, the audit trail is clear and the blast radius is the same as Bella typing the update herself — only faster.

## New policy

Marco is at **Level 2 (Draft & Wait)** for both Tier 1 and Tier 2 users. Marco can do exactly one Monday write: the `create_update` mutation, which adds a message to the yellow "updates" feed of an existing Monday item.

### Everything else remains forbidden

Marco still cannot:
- Create new Monday items (deal, contact, lead, AR row)
- Change column values (status, owner, dates, text columns)
- Move items between groups or boards
- Delete anything
- Write to any board outside Deals (`6466800590`), Leads (`6466800613`), Contacts (`6466800570`)
- Write to FreshBooks, Gmail, Outlook, the dashboard, or the Oltre Vault filesystem

Those capabilities stay at Level 3 and require a written decision to unlock.

### The flow

1. User DMs Marco a write intent. Examples: *"I'm meeting Duncan tomorrow at 11"* / *"Spoke with Rivertop, they're going to sign by Friday"* / *"Note that the Schellenberg job is waiting on the hearth size."*
2. Marco's router detects the write intent and routes to the `monday-update` skill.
3. Skill calls Claude to parse the message into `{target, content}`.
4. Skill fuzzy-searches Monday Deals/Leads/Contacts for `target`. Picks the best match. If ambiguous → asks which.
5. Skill composes the update body:
   ```
   {content}

   — {RequesterName} via Marco
   ```
6. Skill stores the draft in Upstash Redis keyed by the preview message's Slack `ts`, with a TTL matching the requester's tier:
   - Tier 1: 12 hours
   - Tier 2: 2 hours
7. Skill DMs the requester a **preview** of the exact update + the target item name + instructions to react ✅ to send or ❌ to cancel.
8. When Slack fires a `reaction_added` event, the Vercel webhook route forwards it to the `marco-reaction-handler` task.
9. Reaction handler verifies:
   - Reactor is the same Slack user who created the draft (no cross-user approvals)
   - Emoji is ✅ (`white_check_mark`)
   - Draft is still within its TTL
   - Tier 1 over 12h → re-confirm before sending
   - Tier 2 drafts that expire → silently discard, no re-confirm flow
10. If all checks pass, handler calls Monday `create_update` mutation and DMs a confirmation in the same thread.
11. Draft deleted from Redis.

### Tier-specific rules

**Tier 1 (Andrew):**
- 12-hour draft TTL
- Can sign drafts with any attribution (default `— Andrew via Marco`)
- If reacts on a 12+ hour draft, Marco re-confirms first
- No limit on concurrent drafts

**Tier 2 (Bella, Alex T., Alex P.):**
- 2-hour draft TTL
- Signature is **forced** to `— {OwnName} via Marco`. Tier 2 users cannot request a draft signed in someone else's name. The signature is derived server-side from the Slack sender ID; the skill overrides any attempted override in the body.
- If reacts on an expired draft, draft is silently discarded — no re-confirm
- **Only one active draft per user.** Asking for a second draft before reacting to the first → Marco tells them the first is still pending and asks them to ✅ or ❌ before proceeding. This prevents mis-reactions on the wrong preview message.

### Signature examples

Andrew DMs Marco: *"Spoke with John Duncan on the phone. Meeting tomorrow at 11 to walk the site."*
```
Spoke with John Duncan on the phone. Meeting tomorrow at 11 AM to walk the site.

— Andrew via Marco
```

Bella DMs Marco: *"I'm meeting John Duncan tomorrow at 11."*
```
Meeting John Duncan tomorrow at 11 AM.

— Bella via Marco
```

Monday will tag both as authored by "Andrew Shpiruk" in the activity feed because the API key is Andrew's. The body signature is the human-readable attribution.

## Reality check Andrew signed off on

Monday's API always records the API-key owner as the actor. There is no technical way for Marco to post an update that Monday's activity feed attributes to Bella directly — that would require giving Marco a separate Monday user account, which we deferred in Phase 2 (the dedicated-account decision from the Klaus pattern). The `— {Name} via Marco` body signature is the attribution surface everyone sees when reading the update, and that's sufficient for team-internal use.

## Things this decision does NOT change

- The "Tier 3 silent + one refusal per 24h" rule stands.
- The Oltre HQ bot `U0ALQ669ATB` is still always Tier 3.
- Scheduled skills (`team-morning-brief`, `friday-weekly-rollup`, `production-alert`, `weekly-swot-company`) still default to `DRY_RUN=1` for their initial cycles. Writes are only live for the new `monday-update` skill via the explicit ✅ gate.
- The "Level 3 pre-approved action types" list is still empty.

## When we revisit

- **7 days from today (2026-04-22):** Andrew reviews all Marco-written Monday updates from the first week. Decision point: promote the `create_update` action to Level 3 (no ✅ needed for Andrew only) or stay at Level 2.
- **First write error / misinterpretation:** immediate review, document in `memory/write-incidents.md`, consider tightening the classifier or adding a guardrail.
- **Request for a second write mutation type** (e.g., "create new lead"): fresh decision, fresh entry in `decisions/`, not a silent expansion of this one.
