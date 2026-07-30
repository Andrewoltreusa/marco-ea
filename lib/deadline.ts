/**
 * Per-run time budget — no outbound call may outlive its task.
 *
 * Trigger.dev kills a run at maxDuration WITHOUT executing catch blocks,
 * so any fetch/SDK timeout longer than the time left turns a slow
 * dependency into a silent dead run. Every task's run() calls
 * beginTaskBudget(<its maxDuration>) first; every transport clamps its
 * per-call timeout with clampMs().
 *
 * Module-level state is safe here: Trigger.dev deployed runs execute one
 * run per process, and beginTaskBudget re-stamps the deadline at the top
 * of every run() anyway, so a reused process can never leak a previous
 * run's budget.
 */

/** Epoch ms after which no new outbound work should start. */
let deadlineAtMs: number | null = null;

/**
 * Stamp the run's deadline. `safetyMs` is reserved headroom for the
 * never-silent catches (error replies, audit writes) that must still run
 * after the last clamped call times out.
 */
export function beginTaskBudget(maxDurationSec: number, safetyMs = 8000): void {
  deadlineAtMs = Date.now() + maxDurationSec * 1000 - safetyMs;
}

/** Ms left in the budget. Infinity when beginTaskBudget was never called. */
export function remainingMs(): number {
  if (deadlineAtMs === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, deadlineAtMs - Date.now());
}

/**
 * Clamp a desired per-call timeout to the remaining budget, never below
 * `floorMs` — a 0ms timeout would fail instantly and mask the real error
 * with an abort.
 */
export function clampMs(desiredMs: number, floorMs = 3000): number {
  return Math.max(floorMs, Math.min(desiredMs, remainingMs()));
}

/** Test hook: restore the "no budget" state between test cases. */
export function __resetTaskBudgetForTest(): void {
  deadlineAtMs = null;
}
