---
name: lead-check
description: Answer "has [name] gotten back to us?". Checks Monday Leads for the latest activity and MS Graph for the latest inbound email from that person. Read-only. Tier 1 and Tier 2 allowed.
---

# lead-check

## Trigger phrases
- "has [X] gotten back to us"
- "did [X] reply"
- "any word from [X]"
- "what's the latest from [X]"

## Resolution
1. **Monday Leads** `6466800613` — fuzzy match on name OR email OR company. Extract: last_updated, status, last note.
2. **MS Graph (Outlook)** — read-only query of Bella's inbox (`bellab@oltreusa.com`) and Andrew's work inbox. Search by sender name/email. Return the most recent inbound message timestamp + subject.
3. Compare: if the Monday item's last update is older than the Outlook inbound, flag "Monday not updated yet."

## Output format
Three-line answer:
```
[Name] — latest on Monday: [status] as of [date]
Latest inbound email: [date] — "[subject]"
[Action hint: "Monday out of date" / "Follow-up overdue (N days)" / "No response yet"]
```

## Guardrails
- MS Graph access is READ-ONLY. Marco does not send, draft, or flag emails from Outlook.
- If the sender has multiple threads, return the most recent only.
- If no Monday item: "Not in Monday Leads. Possible they're in Contacts or Deals — want me to check?"
- Never read Andrew's personal inbox. Only `andrews@oregonfivestar.com` work mail + Bella's mail.
- Cache Outlook query results for 2 minutes per sender to avoid Graph rate limits.
