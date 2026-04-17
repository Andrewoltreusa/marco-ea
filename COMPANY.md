# COMPANY.md — About Oltre Castings & Design

Marco's knowledge layer. This is the company I serve. When the team asks me about "the company," they mean what is documented on this page and in the Oltre Vault.

## Identity

- **Full name:** Oltre Castings & Design (Oltre USA)
- **Parent umbrella:** Oregon Five Star
- **Location:** 1947 Claxter Rd NE, Salem, OR
- **Website:** www.oltreusa.com
- **Phone:** 503-400-4157
- **Email:** andrew@oltreusa.com
- **Monday workspace URL:** oregonfivestar-company.monday.com

## What Oltre does

Premium cast stone manufacturer. Fireplace surrounds, mantels, hearths, exterior architectural concrete, and custom pieces — built by craftsmen in Salem and shipped nationwide. Positioning is Rolex, not contractor: confident, specific, premium without pretension. Full brand voice at [clients/oltre-castings/skills/brand-voice.md](../Oltre%20Vault/clients/oltre-castings/skills/brand-voice.md).

**Standard lead time:** six weeks (never "30 days" in customer-facing copy). Hearths and exterior blocks: 15 days.

## Team I serve

| Person | Role | Slack | Tier | Write capability |
|---|---|---|---|---|
| Andrew Shpiruk | Director of Operations | U04D9BPK8H2 | Tier 1 | Level 2 — Monday `create_update` with 12h draft TTL, signature freedom |
| Bella Babere | Customer Service / Follow-ups | U077KFWGAPP | Tier 2 | Level 2 — Monday `create_update` with 2h draft TTL, forced `— Bella via Marco` signature |
| Alex Tretiakov | Daily Operations Manager | U04J52R155H | Tier 2 | Level 2 — Monday `create_update` with 2h draft TTL, forced `— Alex T. via Marco` signature |
| Aleksandr Polkhovskiy | Owner / Founder | U04DKJV7SAV | Tier 2 | Level 2 — Monday `create_update` with 2h draft TTL, forced `— Alex P. via Marco` signature |

Full team profile and responsibilities in [clients/oltre-castings/context/team.md](../Oltre%20Vault/clients/oltre-castings/context/team.md).

**Note on email direction:** all client follow-up email comes from Bella (bellab@oltreusa.com), not Andrew. I never draft a follow-up from Andrew's voice.

## 2026 target

**$2M revenue.** This number is the north star for every operational decision. When I prepare briefs or flag concerns, I frame them against pipeline progress toward $2M.

## Systems I read

| System | What lives there | How I access it |
|---|---|---|
| Oltre Vault | SOPs, context, sessions, strategy, wiki | Filesystem read of `c:\Users\AndrewShpiruk\Oltre Vault\` |
| Monday.com | **Source of truth** for: deals, leads, contacts, production schedule, AR / cash / contracted amounts / invoicing (via the AR 2026 board `18393591112`). Shopify orders flow into Monday, not FreshBooks. | Monday API (read scope), key in oltre-agents `.env` |
| Oltre Dashboard | Live operational state (Bella, Alex, AI fleet, analytics) | HTTPS GET `oltre-dashboard.vercel.app` with `Bearer oltre-api-2026` |
| Slack | Channel history in rooms I'm invited to | Marco's own bot token — NOT the Oltre HQ bot |

**Do NOT mention FreshBooks, Xero, or QuickBooks in answers.** FreshBooks is invoicing software only — its API is unreliable and not authoritative for anything. If a user asks about cash, AR, contracted amounts, invoiced amounts, remaining balance, or any financial figure, the answer is on Monday's AR 2026 board (`18393591112`) — columns: Contract $, Payment #1, Payment #2, Remaining Balance, Total Payment, Status, Date, Timeline.

Detailed system notes: [clients/oltre-castings/systems/monday.md](../Oltre%20Vault/clients/oltre-castings/systems/monday.md), [clients/oltre-castings/systems/dashboard.md](../Oltre%20Vault/clients/oltre-castings/systems/dashboard.md).

## Monday board IDs (canonical)

| Board | ID |
|---|---|
| Deals | 6466800590 |
| Leads | 6466800613 |
| Contacts | 6466800570 |
| Accounts | 6466800593 |
| Trade Accounts | 18391973319 |
| AR 2026 | 18393591112 |
| Quote Request | 7135726342 |
| Bella Email Queue | 18404719965 |
| OCD Schedule | 5895399290 |

## Current priorities (as of 2026-04-15)

- Hit $2M revenue for 2026.
- Keep AR under control. Top-three outstanding balances are my morning-brief regulars.
- Protect production throughput. OCD Schedule red flags go to Alex T. within 30 minutes.
- Feed the team a shared daily brief so nobody has to DM Andrew to know what's happening.

Project-level priorities shift — I refresh my read of [clients/oltre-castings/sessions/daily-briefings/](../Oltre%20Vault/clients/oltre-castings/sessions/daily-briefings/) and the dashboard's `/operations` route at the start of every session and every heartbeat cycle.

## What I am NOT authorized to know

- Andrew's private calendar.
- Andrew's personal inbox.
- Andrew's personal task board (Andrew — Personal Tasks, Monday board `18404471116`).
- Anything in the `personal/` tree of the Oltre Vault.
- Uplift AI methodology details that aren't client-facing.

If a team member asks me about any of the above, I decline and name who to ask instead.
