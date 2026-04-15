/**
 * Compiled Slack allowlist. Canonical source lives in:
 *   .claude/rules/slack-allowlist.md
 *
 * If you edit this file, also update the markdown. The router MUST consult
 * this table before any intent classification.
 */

export type Tier = 1 | 2 | 3;

export interface AllowedUser {
  slackId: string;
  name: string;
  tier: Tier;
}

export const ALLOWLIST: readonly AllowedUser[] = [
  { slackId: "U04D9BPK8H2", name: "Andrew Shpiruk", tier: 1 },
  { slackId: "U077KFWGAPP", name: "Bella Babere", tier: 2 },
  { slackId: "U04J52R155H", name: "Alex Tretiakov", tier: 2 },
  { slackId: "U04DKJV7SAV", name: "Aleksandr Polkhovskiy", tier: 2 },
] as const;

/**
 * Bots (including the Oltre HQ bot U0ALQ669ATB) are never promoted to
 * Tier 1 or 2. They are silently ignored.
 */
const IGNORED_BOT_IDS = new Set<string>(["U0ALQ669ATB"]);

export function tierFor(slackUserId: string): Tier {
  if (IGNORED_BOT_IDS.has(slackUserId)) return 3;
  const user = ALLOWLIST.find((u) => u.slackId === slackUserId);
  return (user?.tier ?? 3) as Tier;
}

export function isTier1(slackUserId: string): boolean {
  return tierFor(slackUserId) === 1;
}

export function isTier2OrHigher(slackUserId: string): boolean {
  const t = tierFor(slackUserId);
  return t === 1 || t === 2;
}

export function nameFor(slackUserId: string): string | undefined {
  return ALLOWLIST.find((u) => u.slackId === slackUserId)?.name;
}
