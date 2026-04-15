---
name: find-in-vault
description: Answer "what do we know about [topic]?". Semantic + keyword search over the Oltre Vault's wiki/ and clients/oltre-castings/ trees. Returns a 2-3 sentence synthesis with citations. Read-only. Tier 1 and Tier 2.
---

# find-in-vault

## Trigger phrases
- "what do we know about [X]"
- "tell me what's in the vault on [X]"
- "find [X] in the vault"
- Fallback when no other intent classifier matches.

## Resolution
1. **Grep pass** — ripgrep over `wiki/` and `clients/oltre-castings/` for the search term. File list sorted by mtime.
2. **Read top 5 matching files** — extract frontmatter title + the 2-3 sentences around the first match.
3. **Synthesize** — Claude call with the user's question + the extracted snippets + brand-voice rules. Return a 2-3 sentence answer.
4. **Cite** — list the files consulted as wiki-link-style markdown.

## Forbidden paths
Per AGENTS.md vault reading protocol:
- `personal/` — never
- `raw/` — never, unless the file is already linked from a wiki page in the result set
- `uplift-ai/` — never
- `clients/oltre-castings/sessions/conversation-notes/` — only for Tier 1

## Output format
```
[2-3 sentence synthesis]

Sources:
- [wiki/concepts/foo.md](...)
- [clients/oltre-castings/systems/bar.md](...)
```

## Guardrails
- If the top result is in a forbidden path for the requester's tier, skip it and move to the next result.
- If no results: "I don't see '[X]' in the vault. It might be under a different term — try a synonym or ask what section it's in."
- Never quote more than 2 sentences verbatim from a single source — synthesize instead.
- Cache grep results per query for 5 minutes.
