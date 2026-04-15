/**
 * Marco standalone Slack Web API client.
 *
 * Zero imports from oltre-agents. This file is intentionally small and
 * self-contained so Marco can deploy independently of the fleet repo.
 *
 * Auth: uses MARCO_SLACK_BOT_TOKEN (never SLACK_BOT_TOKEN — that's the
 * Oltre HQ automation bot, which Marco must not impersonate).
 */

const SLACK_API = "https://slack.com/api";

function token(): string {
  const t = process.env.MARCO_SLACK_BOT_TOKEN;
  if (!t) {
    throw new Error(
      "MARCO_SLACK_BOT_TOKEN is not set. Marco must have its own Slack app token, " +
        "separate from SLACK_BOT_TOKEN (which belongs to the Oltre HQ bot U0ALQ669ATB).",
    );
  }
  return t;
}

async function call<T = unknown>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) {
    throw new Error(`Slack ${method} failed: ${json.error ?? "unknown"}`);
  }
  return json as T;
}

export async function postMessage(opts: {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
}) {
  return call<{ ts: string; channel: string }>("chat.postMessage", opts);
}

export async function openDM(userId: string): Promise<string> {
  const res = await call<{ channel: { id: string } }>("conversations.open", {
    users: userId,
  });
  return res.channel.id;
}

export async function dmUser(userId: string, text: string, blocks?: unknown[]) {
  const channel = await openDM(userId);
  return postMessage({ channel, text, blocks });
}

export async function addReaction(
  channel: string,
  timestamp: string,
  name: string,
) {
  return call("reactions.add", { channel, timestamp, name });
}

export async function getUserInfo(userId: string) {
  return call<{ user: { id: string; name: string; real_name: string; is_bot: boolean } }>(
    "users.info",
    { user: userId },
  );
}

/**
 * Verify a Slack request signature per the Events API signing protocol.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
): Promise<boolean> {
  const secret = process.env.MARCO_SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("MARCO_SLACK_SIGNING_SECRET not set");

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 5) return false; // 5-minute replay window

  const base = `v0:${timestamp}:${rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `v0=${hex}`;

  // Timing-safe compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
