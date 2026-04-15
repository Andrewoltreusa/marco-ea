---
name: agent-fleet-health
description: Answer "is anything broken?" / "how's the fleet?". Pulls the /ai route on the Oltre Dashboard and the ops/health-monitor output from the oltre-agents repo. Tier 1 primarily; Tier 2 sees a summarized "healthy / degraded / down" status without internals.
---

# agent-fleet-health

## Trigger phrases
- "is anything broken"
- "fleet health", "how's the fleet"
- "any errors", "anything failing"
- "ai status"

## Data sources
- `GET https://oltre-dashboard.vercel.app/api/state` — parse the `ai` section and any `errors[]` field.
- `GET https://oltre-dashboard.vercel.app/ai` HTML → not ideal; prefer structured state.
- Filesystem read of `c:\Users\AndrewShpiruk\Oltre\oltre-agents\reports\health-monitor-latest.json` if present.

## Output format

### Tier 1 (Andrew)
```
Fleet: [healthy / degraded / down]
- Tasks run in last 24h: N
- Failures: M ([task names])
- Open alerts: [list]
Last health check: [timestamp]
```

### Tier 2
```
Fleet: [healthy / degraded / down]
Last check: [timestamp]
```

No task names, no failure counts for Tier 2 — that level of detail is Andrew's concern.

## Guardrails
- Never expose error messages verbatim (they might contain client names or PII).
- If the dashboard is unreachable, the fleet is "unknown," not "down." Say so.
- This skill NEVER restarts anything. Read-only.
