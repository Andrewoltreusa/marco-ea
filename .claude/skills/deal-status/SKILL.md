---
name: deal-status
description: Answer "what's the status of [client name]?" in 3 sentences. Pulls the deal row from Monday Deals, production status from OCD Schedule, invoice status from FreshBooks, and any recent vault notes. Tier 1 and Tier 2 allowed. Read-only.
---

# deal-status

## Trigger phrases
- "what's the status of [X]"
- "what's up with [X]"
- "where are we on [X]"
- "how's [X] going"
- "tell me about [X]" (when X resolves to a client or deal name)

## Input
- `name` — client or deal name, free text. Fuzzy-match against Monday Deals and Contacts.

## Resolution order
1. **Monday Deals** `6466800590` — search items by name. If multiple match, prefer the one with the most recent `updated_at`. Extract: status, value, owner, expected close date.
2. **Monday OCD Schedule** `5895399290` — search for the same client name. Extract: current production stage, ship date, any flags.
3. **FreshBooks** — lookup client by name, get open invoices, latest payment, aging. Auth: refresh the FreshBooks access token using creds from `oltre-agents/.env`.
4. **Oltre Vault** — grep `clients/oltre-castings/sessions/daily-briefings/` (last 7 days) and `clients/oltre-castings/sops/` for the client name. Include any 1-line mention.

## Output format
Three sentences, no more. Example:

> "**Schellenberg kitchen** is in the Deals board at $14,800, status **Proposal sent**, Bella owner, expected close 2026-04-22. Production hasn't started — nothing on the OCD Schedule yet. Last invoice was the $2,000 deposit on 2026-03-28, currently marked paid in FreshBooks."

Follow with a single citations line:
> `Sources: Monday Deals #6466800590 item 1234567890 • FreshBooks invoice #INV-0421`

## Guardrails
- If fuzzy match returns >1 candidate with similar scores, respond: "I found multiple deals matching '[name]': [list]. Which one?"
- If no match: "I don't see a deal matching '[name]' in Monday. It might be under a different name — can you try the company name?"
- Never leak margin, cost, or negotiation context. Just status + value + stage.
- Never include Andrew's private notes (anything in `personal/` or flagged Tier-1-only).
- Redact FreshBooks detail for Tier 2: show amount outstanding but not full invoice history.

## Tier behavior
- **Tier 1 (Andrew):** Full output including vault quote.
- **Tier 2 (Bella, Alex T., Alex P.):** Same output, minus the vault quote if the note is marked `tier: 1` or lives in a Tier-1-only path.
- **Tier 3:** Refused per allowlist rules.
