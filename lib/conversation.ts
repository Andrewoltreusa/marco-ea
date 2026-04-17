/**
 * Per-channel conversation memory for Marco.
 *
 * Stored in Upstash Redis, keyed by Slack channel ID. Each channel
 * gets its own rolling window of the last N turns. After 30 minutes
 * of silence, the context expires and the next message starts fresh.
 *
 * Used by general-query.ts to resolve pronouns ("her", "that project")
 * and maintain continuity across follow-up questions.
 */

import { redis } from "./redis.js";

export interface ConversationTurn {
  /** ISO timestamp when the turn was stored. */
  at: string;
  /** The user's message (cleaned, no mention prefix). */
  user: string;
  /** Marco's reply, as posted to Slack. */
  assistant: string;
}

const CONV_KEY = (channelId: string) => `marco:conv:${channelId}`;
const MAX_TURNS = 5;
const TTL_SEC = 30 * 60;

export async function loadConversation(
  channelId: string,
): Promise<ConversationTurn[]> {
  const raw = (await redis().get(CONV_KEY(channelId))) as
    | ConversationTurn[]
    | null;
  if (!Array.isArray(raw)) return [];
  return raw;
}

export async function appendTurn(
  channelId: string,
  turn: ConversationTurn,
): Promise<void> {
  const existing = await loadConversation(channelId);
  const updated = [...existing, turn].slice(-MAX_TURNS);
  await redis().set(CONV_KEY(channelId), updated, { ex: TTL_SEC });
}

/**
 * Convert stored turns into the Claude messages-array format for
 * multi-turn context. The newest turn is NOT included here — that's
 * the user's current message, which the caller appends separately.
 */
export function toClaudeMessages(
  turns: ConversationTurn[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.flatMap((t) => [
    { role: "user" as const, content: t.user },
    { role: "assistant" as const, content: t.assistant },
  ]);
}

/**
 * Plain-text render of the conversation for prompts that need it as
 * a single string (e.g. the search-term extractor that runs as a
 * single-turn Claude call).
 */
export function toTranscript(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "(no prior context in this conversation)";
  return turns
    .map((t) => `User: ${t.user}\nMarco: ${t.assistant}`)
    .join("\n\n");
}
