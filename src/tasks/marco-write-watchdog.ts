/**
 * Trigger.dev task: comms/marco-write-watchdog
 *
 * Every 10 minutes, sweeps the write-delegation outbox
 * (marco:outbox:write-delegations, lib/outbox.ts). The inbound parent
 * leaves the request lifecycle open when it delegates a monday-update to
 * the draft child; the child stamps `marco:outbox-started:<key>` as its
 * first action and closes out (markResponded + done marker) after its
 * terminal user-visible reply. Triage:
 *   done marker            → child delivered, drop the entry quietly
 *   started but no done    → child died mid-run: lost after 5 minutes
 *   no started marker      → queue-delayed: lost only after 30 minutes
 *
 * On a lost delegation: LREM FIRST (a sweep killed mid-loss must not
 * re-notify next cycle), then the write-incident record, then the DMs,
 * then delete the lifecycle key so a resend isn't deduped. The requester
 * DM is honest under ambiguity — the child may have died after posting
 * its preview, so the user is pointed at the preview if one exists.
 *
 * Dependency-free by design: no Trigger.dev runs API — the markers ARE
 * the verdict. Uses the raw (non-deserializing) Redis client so LRANGE
 * elements can be handed back to LREM byte-identical. DRY_RUN is NOT
 * consulted: this only fires on real failures and DMs only the affected
 * user plus Andrew.
 *
 * Project: proj_nvpgdhytpkikscybodkk
 */

import { schedules, logger } from "@trigger.dev/sdk";
import { redisRaw } from "../../lib/redis.js";
import { dmUser } from "../../lib/slack.js";
import { logWriteIncident } from "../../lib/audit.js";
import { beginTaskBudget } from "../../lib/deadline.js";
import {
  OUTBOX_KEY,
  outboxDoneKey,
  outboxStartedKey,
  parseOutboxEntry,
  triageOutboxEntry,
} from "../../lib/outbox.js";

// Slack ID mirrors .claude/rules/slack-allowlist.md.
const ANDREW = "U04D9BPK8H2";

const MAX_DURATION_SEC = 60;

/** Human-readable Pacific time for the "didn't finish" DMs. */
function fmtPacific(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d) + " Pacific"
  );
}

export const marcoWriteWatchdog = schedules.task({
  id: "comms/marco-write-watchdog",
  cron: { pattern: "*/10 * * * *", timezone: "America/Los_Angeles" },
  maxDuration: MAX_DURATION_SEC,
  // Never retry: the next sweep is 10 minutes away, and the entry is
  // LREM'd before any notification goes out.
  retry: { maxAttempts: 1 },
  run: async () => {
    beginTaskBudget(MAX_DURATION_SEC);
    // Raw client: elements come back as the exact stored strings, so the
    // LREM value is the LRANGE element untouched (the default client
    // JSON-parses list items; re-stringifying a parsed copy is not
    // guaranteed byte-identical for foreign-formatted entries).
    const r = redisRaw();
    const rawEntries = await r.lrange<string>(OUTBOX_KEY, 0, -1);
    if (rawEntries.length === 0) {
      return { ok: true, entries: 0, lost: 0 };
    }

    const now = Date.now();
    let kept = 0;
    let done = 0;
    let lost = 0;

    for (const raw of rawEntries) {
      // Parse a copy for reading; `raw` itself is reserved for LREM.
      const entry = parseOutboxEntry(raw);
      if (!entry) {
        // Foreign/corrupt element — LREM by its raw string so it is
        // logged exactly once, not re-logged forever.
        logger.warn("unparseable outbox entry — removing", { raw });
        try {
          await r.lrem(OUTBOX_KEY, 1, raw);
        } catch (err) {
          logger.warn("could not remove unparseable outbox entry", {
            err: String(err),
          });
        }
        continue;
      }

      const markerKey = entry.lifecycleKey ?? entry.childRunId;
      const [doneMarker, startedMarker] = await Promise.all([
        r.get(outboxDoneKey(markerKey)),
        r.get(outboxStartedKey(markerKey)),
      ]);
      const action = triageOutboxEntry(
        entry,
        { done: doneMarker !== null, started: startedMarker !== null },
        now,
      );

      if (action === "keep") {
        kept++;
        continue;
      }
      if (action === "remove_done") {
        done++;
        await r.lrem(OUTBOX_KEY, 1, raw);
        continue;
      }

      // Lost delegation. Order matters: LREM first so a sweep that dies
      // mid-handling can never notify twice; the incident record is the
      // durable trace even if both DMs fail.
      await r.lrem(OUTBOX_KEY, 1, raw);
      const when = fmtPacific(entry.ts);
      logger.error("write delegation lost — child never finalized", {
        childRunId: entry.childRunId,
        requester: entry.requester,
        lifecycleKey: entry.lifecycleKey,
        enqueuedAt: entry.ts,
        childStarted: startedMarker !== null,
      });
      await logWriteIncident({
        outcome: "delegation_lost",
        requester: entry.requester,
        childRunId: entry.childRunId,
        lifecycleKey: entry.lifecycleKey,
        enqueuedAt: entry.ts,
        childStarted: startedMarker !== null,
      });

      let requesterNotified = false;
      try {
        await dmUser(
          entry.requester,
          `Your update request from ${when} may not have finished. ` +
            `If I sent you a draft preview for it, react ✅ or ❌ there; if not, please resend it.`,
        );
        requesterNotified = true;
      } catch (err) {
        logger.error("lost-delegation DM to requester failed", {
          requester: entry.requester,
          err: String(err),
        });
      }
      try {
        await dmUser(
          ANDREW,
          `Write delegation lost: draft child run ${entry.childRunId} for <@${entry.requester}> ` +
            `(enqueued ${when}, ${startedMarker !== null ? "died mid-run" : "never started"}) never posted a reply. ` +
            `${requesterNotified ? "The requester was notified." : "The requester could NOT be reached — follow up manually."}`,
        );
      } catch (err) {
        logger.error("lost-delegation DM to Andrew failed", { err: String(err) });
      }

      // Clear the lifecycle so a resend of the same Slack event text (or
      // a retried delivery) isn't swallowed as a duplicate.
      if (entry.lifecycleKey) {
        try {
          await r.del(entry.lifecycleKey);
        } catch (err) {
          logger.warn("could not clear lifecycle key", {
            key: entry.lifecycleKey,
            err: String(err),
          });
        }
      }
      lost++;
    }

    logger.info("watchdog sweep complete", {
      entries: rawEntries.length,
      kept,
      done,
      lost,
    });
    return { ok: true, entries: rawEntries.length, kept, done, lost };
  },
});
