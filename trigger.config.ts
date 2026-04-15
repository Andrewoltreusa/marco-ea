import { defineConfig } from "@trigger.dev/sdk";

/**
 * Marco's Trigger.dev config. Shares the same project as oltre-agents
 * (proj_rfghiguuzwfekcixcuux) so both live in one deploy surface.
 *
 * Tasks are under src/tasks. The Slack webhook front door lives in
 * oltre-dashboard/app/api/marco/slack/route.ts — that route verifies
 * the signature, normalizes the payload, and calls tasks.trigger()
 * on the marco-slack-inbound task here.
 */
export default defineConfig({
  project: "proj_rfghiguuzwfekcixcuux",
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
