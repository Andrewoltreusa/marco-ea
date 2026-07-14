---
name: cash-position
description: Answer "how much AR is out?" / "who owes us the most?" / "what's cash at?". Pulls from the Monday AR 2026 board (FreshBooks removed 2026-04-17). NOTE: at runtime this skill is folded into general-query, which injects code-computed AR aggregates. Tier 1 gets full detail; Tier 2 gets AR top 5 without account-level financial drilldown. Read-only.
---

# cash-position

## Trigger phrases
- "cash", "cash position", "how's cash"
- "AR", "accounts receivable", "what's AR at"
- "who owes us", "biggest outstanding", "overdue"
- "what's [client] owe"

## Data sources
- **Monday AR 2026 board `18393591112`** — Contract $, Payment #1/#2, Remaining Balance; aggregates pre-computed in code (lib/ar.ts).
- **Monday AR 2026** board `18393591112` — items, amount column, aging column.

## Output format

### Tier 1 (Andrew)
```
AR outstanding: $X,XXX across N invoices.
Top 5:
 1. [Client] — $X,XXX — X days aged
 2. ...
Aged >60 days: $X,XXX (N invoices).
Sources: Monday AR 2026.
```

### Tier 2 (Bella, Alex T., Alex P.)
Same top 5 list, but omit the "aged >60 days" total if the requester is Bella or Alex T. (Alex P. as owner gets the full view.)

## Tier redaction table

| Field | Andrew | Alex P | Bella / Alex T |
|---|---|---|---|
| Total AR | ✅ | ✅ | ✅ |
| Top 5 names + amounts | ✅ | ✅ | ✅ |
| Aging buckets | ✅ | ✅ | ❌ |
| Single-client aging | ✅ | ✅ | ✅ (only for their own queries) |
| Cash balance | ❌ (not in scope) | ❌ | ❌ |

## Guardrails
- Never include raw API URLs or tokens.
- Never answer "what's cash balance?" — that's not in Marco's read surface. Respond: "Bank cash balance isn't on my read list — I can give you AR outstanding from Monday. Ask Andrew for bank balances."
- Cache the top-5 result for 15 minutes to avoid hammering the Monday API.
