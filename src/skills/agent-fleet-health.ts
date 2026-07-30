/**
 * agent-fleet-health skill — "Is anything broken?"
 *
 * Pulls from the Oltre Dashboard /api/state endpoint (DashboardState
 * shape per oltre-dashboard/lib/types.ts: currentFocus, priorities[],
 * completedToday[], sessionStart, updatedAt, n8nStatus). The GET may
 * also return `{}` when no state has ever been written.
 *
 * Tier 1 gets the full readout. Tier 2 gets ONLY the one-line health
 * status + freshness — no n8n internals, no counts, no focus/priorities
 * (.claude/skills/agent-fleet-health/SKILL.md redaction rule).
 *
 * Read-only. Never restarts anything. If the dashboard is unreachable
 * the fleet is "unknown", not "down".
 */

import { clampMs } from "../../lib/deadline.js";

const DASHBOARD_URL = "https://oltre-dashboard.vercel.app";

interface DashboardState {
  currentFocus?: string;
  priorities?: string[];
  completedToday?: string[];
  n8nStatus?: string;
  /** ISO heartbeat — bumped by every POST to /api/state. */
  updatedAt?: string;
  /** Some writers may use this name instead. */
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Explicit allowlist: only these parsed statuses mean "healthy".
 * "down"/"error"/"failing" mean degraded. ANYTHING else — including
 * "unknown", empty, or missing — is unknown. Never map unknown to
 * healthy.
 */
const HEALTHY_STATUSES = ["ok", "healthy", "up", "running", "green"];
const DEGRADED_STATUSES = ["down", "error", "failing"];

const STALE_MS = 24 * 60 * 60 * 1000;

const UNKNOWN_LABEL =
  "unknown — the dashboard hasn't reported real health data";

function statusLabel(n8nStatus: string | undefined): string {
  const s = (n8nStatus ?? "").trim().toLowerCase();
  if (HEALTHY_STATUSES.includes(s)) return "healthy";
  if (DEGRADED_STATUSES.includes(s)) return "degraded";
  return UNKNOWN_LABEL;
}

/**
 * Freshness from the state's updatedAt/timestamp heartbeat.
 * Older than 24h → "stale (last updated <date>)" regardless of status.
 * Missing or unparseable → "freshness unknown".
 */
function freshnessLabel(state: DashboardState): string {
  const raw =
    typeof state.updatedAt === "string" && state.updatedAt
      ? state.updatedAt
      : typeof state.timestamp === "string" && state.timestamp
        ? state.timestamp
        : null;
  if (!raw) return "freshness unknown";
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return "freshness unknown";
  const when =
    new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return Date.now() - ts > STALE_MS
    ? `stale (last updated ${when})`
    : `last updated ${when}`;
}

export async function agentFleetHealth(tier: 1 | 2): Promise<string> {
  // Never a hardcoded secret — the token lives in the Trigger.dev env.
  const token = process.env.OLTRE_DASHBOARD_API_TOKEN;
  if (!token) {
    return (
      "I can't check the dashboard — the OLTRE_DASHBOARD_API_TOKEN " +
      "environment variable isn't set in this deployment. Fleet status: *unknown*."
    );
  }

  let state: DashboardState;
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
      // 10s deadline, clamped to the run's remaining budget — a hung
      // dashboard must resolve to "unknown", not a killed run.
      signal: AbortSignal.timeout(clampMs(10_000)),
    });
    if (!res.ok) {
      return `Dashboard returned HTTP ${res.status}. Fleet status: *unknown*. Try again in a minute.`;
    }
    state = (await res.json()) as DashboardState;
  } catch (err) {
    return `Couldn't reach the dashboard: ${err instanceof Error ? err.message : "unknown"}. Fleet status: *unknown*.`;
  }

  const label = statusLabel(state.n8nStatus);
  const freshness = freshnessLabel(state);

  if (tier === 2) {
    // Tier 2 redaction (SKILL.md): one-line status + freshness ONLY.
    return `Fleet: *${label}* — ${freshness}.`;
  }

  // Tier 1 gets the full readout.
  const n8nRaw = (state.n8nStatus ?? "").trim() || "(not reported)";
  const completedToday = Array.isArray(state.completedToday)
    ? state.completedToday
    : [];
  const priorities = Array.isArray(state.priorities) ? state.priorities : [];
  const focus =
    typeof state.currentFocus === "string" && state.currentFocus.trim()
      ? state.currentFocus
      : "none set";

  let output = `Fleet: *${label}* — ${freshness}\n`;
  output += `n8n reported status: *${n8nRaw}*\n`;
  output += `Tasks completed today: *${completedToday.length}*\n`;
  output += `Current focus: ${focus}\n`;

  if (priorities.length > 0) {
    output += `Priorities:\n${priorities.map((p) => `  • ${p}`).join("\n")}\n`;
  }

  if (completedToday.length > 0) {
    const recentItems = completedToday.slice(0, 5);
    output += `Recent completions:\n${recentItems.map((c) => `  • ${c}`).join("\n")}`;
    if (completedToday.length > 5) {
      output += `\n  _(+${completedToday.length - 5} more)_`;
    }
    output += "\n";
  }

  output += `_Source: oltre-dashboard.vercel.app/api/state_`;
  return output;
}
