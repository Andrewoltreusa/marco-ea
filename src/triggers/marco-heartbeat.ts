/**
 * Trigger.dev scheduled task: comms/marco-heartbeat
 *
 * Overnight heartbeat. Every 30 minutes between 10 PM and 7 AM Pacific:
 *   1. Refresh the Oltre Vault index (ripgrep file list into Redis).
 *   2. Refresh the Monday state cache for Deals, AR, OCD Schedule.
 *   3. Prepare the morning brief draft → deliverables/YYYY-MM-DD-morning-draft.md
 *
 * The actual team-morning-brief task (7:30 AM) consumes the draft and posts.
 *
 * Project: proj_rfghiguuzwfekcixcuux (shared)
 *
 * Why Trigger.dev and not /loop: the decision log
 * (decisions/log.md, 2026-04-15) aligns Marco with the Q16 cron
 * decision for the Oltre fleet. Trigger.dev gives us retries, observability,
 * and a single ops surface.
 */

import { schedules, logger } from "@trigger.dev/sdk/v3";

export const marcoHeartbeat = schedules.task({
  id: "comms/marco-heartbeat",
  // Every 30 min between 22:00 and 06:59 Pacific (the 7:30 morning-brief task
  // owns the final pass).
  cron: {
    pattern: "*/30 22,23,0,1,2,3,4,5,6 * * *",
    timezone: "America/Los_Angeles",
  },
  maxDuration: 10 * 60, // 10 minutes
  run: async (payload) => {
    const now = new Date();
    logger.info("marco heartbeat", { firedAt: now.toISOString() });

    await refreshVaultIndex();
    await refreshMondayCache();
    await prepareMorningDraft(now);

    return { ok: true, firedAt: now.toISOString() };
  },
});

async function refreshVaultIndex(): Promise<void> {
  // Placeholder: walk `c:\Users\AndrewShpiruk\Oltre Vault\wiki` and
  // `clients/oltre-castings` via filesystem API, write the file list +
  // frontmatter snippets to Upstash Redis under key `marco:vault-index`.
  // Filesystem access here depends on Marco running on a worker with
  // the vault mounted — the Trigger.dev project currently runs cloud,
  // so real vault-index refresh happens on a self-hosted worker. See
  // decisions/log.md for the deployment plan.
  logger.info("vault index refresh: stub");
}

async function refreshMondayCache(): Promise<void> {
  // Placeholder: fetch board snapshots for 6466800590 (Deals),
  // 18393591112 (AR 2026), 5895399290 (OCD Schedule). Store in Redis
  // under `marco:monday:<boardId>`.
  logger.info("monday cache refresh: stub");
}

async function prepareMorningDraft(now: Date): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  logger.info("morning draft prep", { path: `deliverables/${today}-morning-draft.md` });
  // Placeholder: produce the brief using the cached data, write to
  // deliverables/<date>-morning-draft.md. The 7:30 team-morning-brief
  // task reads this draft and posts.
}
