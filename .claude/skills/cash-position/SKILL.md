---
name: cash-position
description: Answer "how much AR is out?" / "who owes us the most?" / "what's cash at?". Pulls from FreshBooks + Monday AR 2026 board. Tier 1 gets full detail; Tier 2 gets AR top 5 without account-level financial drilldown. Read-only.
---

# cash-position

## Trigger phrases
- "cash", "cash position", "how's cash"
- "AR", "accounts receivable", "what's AR at"
- "who owes us", "biggest outstanding", "overdue"
- "what's [client] owe"

## Data sources
- **FreshBooks** — `GET /accounting/account/{accountId}/invoices/invoices` filtered by status `outstanding`. Refresh access token using `FRESHBOOKS_REFRESH_TOKEN` from `oltre-agents/.env`.
- **Monday AR 2026** board `18393591112` — items, amount column, aging column.

## Output format

### Tier 1 (Andrew)
```
AR outstanding: $X,XXX across N invoices.
Top 5:
 1. [Client] — $X,XXX — X days aged
 2. ...
Aged >60 days: $X,XXX (N invoices).
Sources: FreshBooks + Monday AR 2026.
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
- Never include FreshBooks internal IDs or URLs with tokens.
- Never answer "what's cash balance?" — that's not in Marco's read surface. Respond: "Cash balance isn't on my read list. Ask Andrew or check FreshBooks directly."
- Cache the top-5 result for 15 minutes to avoid hammering FreshBooks.
