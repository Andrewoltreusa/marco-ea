---
name: production-eta
description: Answer "when does [client] ship?" Pulls the OCD Schedule row for the client and returns the current production stage and ship date. Read-only.
---

# production-eta

## Trigger phrases
- "when does [X] ship"
- "ship date for [X]"
- "production on [X]"
- "eta [X]"

## Input
- `client` — client or deal name.

## Resolution
1. Monday OCD Schedule `5895399290` — fuzzy match on item name.
2. If no match, fall back to Monday Deals `6466800590` and answer "Not yet on the production schedule. Deal status: [status]."

## Output format
Two sentences:
> "**[Client]** is at stage **[stage]** on the OCD Schedule. Target ship: **[date]**."

If flagged red:
> "**[Client]** is flagged **red** on OCD Schedule — [reason if in the update column]. Target ship was [date]; Alex T. has been pinged."

## Guardrails
- Never promise a ship date as a commitment. Always frame as "target ship" or "currently scheduled."
- If the item is red and the caller is Bella, add: "Don't commit this date to the client until Alex T. confirms."
- Cache board snapshot for 5 minutes.