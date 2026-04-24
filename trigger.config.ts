import { defineConfig } from "@trigger.dev/sdk";

/**
 * Marco's Trigger.dev config. Scoped to Marco's own project
 * (proj_nvpgdhytpkikscybodkk) — split off from the shared oltre-agents
 * project (proj_rfghiguuzwfekcixcuux) on 2026-04-24 so each can deploy
 * independently without evicting the other's task surface.
 *
 * Tasks are under src/tasks. The Slack webhook front door lives in
 * oltre-dashboard/app/api/marco/slack/route.ts — that route verifies
 * the signature, normalizes the payload, and calls tasks.trigger()
 * on the marco-slack-inbound task here. The dashboard route authenticates
 * to THIS project via MARCO_TRIGGER_SECRET_KEY on Vercel.
 */
export default defineConfig({
  project: "proj_nvpgdhytpkikscybodkk",
  runtime: "node",
  logLevel: "info",
  dirs: ["src/tasks"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  maxDuration: 300,
  build: {
    autoDetectExternal: true,
  },
});
