/**
 * agent-fleet-health skill — "Is anything broken?"
 *
 * Pulls from the Oltre Dashboard /api/state endpoint.
 * Tier 1 gets full detail; Tier 2 gets a summarized healthy/degraded/down status.
 */

const DASHBOARD_URL = "https://oltre-dashboard.vercel.app";
const DASHBOARD_TOKEN = "oltre-api-2026";

interface DashboardState {
  currentFocus?: string;
  priorities?: string[];
  completedToday?: string[];
  n8nStatus?: string;
  [key: string]: unknown;
}

export async function agentFleetHealth(tier: 1 | 2): Promise<string> {
  let state: DashboardState;
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/state`, {
      headers: { Authorization: `Bearer ${DASHBOARD_TOKEN}` },
    });
    if (!res.ok) {
      return `Dashboard returned HTTP ${res.status}. Fleet status: *unknown*. Try again in a minute.`;
    }
    state = (await res.json()) as DashboardState;
  } catch (err) {
    return `Couldn't reach the dashboard: ${err instanceof Error ? err.message : "unknown"}. Fleet status: *unknown*.`;
  }

  const n8n = state.n8nStatus ?? "unknown";
  const completedCount = state.completedToday?.length ?? 0;
  const focus = state.currentFocus ?? "none set";
  const priorities = state.priorities ?? [];

  // Simple health heuristic
  const healthy = n8n !== "down" && n8n !== "error";
  const statusEmoji = healthy ? "healthy" : "degraded";

  if (tier === 2) {
    return `Fleet: *${statusEmoji}*. n8n: *${n8n}*. ${completedCount} tasks completed today.`;
  }

  // Tier 1 gets full detail
  let output = `Fleet: *${statusEmoji}*\n`;
  output += `n8n: *${n8n}*\n`;
  output += `Tasks completed today: *${completedCount}*\n`;
  output += `Current focus: ${focus}\n`;

  if (priorities.length > 0) {
    output += `Priorities:\n${priorities.map((p) => `  • ${p}`).join("\n")}\n`;
  }

  if (completedCount > 0 && state.completedToday) {
    const recentItems = state.completedToday.slice(0, 5);
    output += `Recent completions:\n${recentItems.map((c) => `  • ${c}`).join("\n")}`;
    if (state.completedToday.length > 5) {
      output += `\n  _(+${state.completedToday.length - 5} more)_`;
    }
  }

  output += `\n_Source: oltre-dashboard.vercel.app/api/state_`;
  return output;
}
