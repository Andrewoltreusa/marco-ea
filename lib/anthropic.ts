/**
 * Marco's Anthropic SDK wrapper.
 *
 * Used by the write-intent parser to turn natural language into a
 * structured {target, content} pair.
 *
 * Credentials come from the shared oltre-agents env:
 *   ANTHROPIC_API_KEY
 */

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Copy it from oltre-agents env into Marco's Trigger.dev env.",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export interface WriteIntentParsed {
  /**
   * The target entity name — a person, company, or deal. Never an
   * internal Monday item ID (that's for the fuzzy search to resolve).
   */
  target: string;
  /**
   * The exact text that should land in the Monday update body, BEFORE
   * the signature is appended. First-person as the user said it,
   * lightly cleaned for clarity and capitalization.
   */
  content: string;
  /** 0–1 — how confident the parser is. Below 0.65 we ask to clarify. */
  confidence: number;
}

const SYSTEM_PROMPT = `You parse natural-language Slack messages into Monday.com write intents for Oltre Castings & Design.

Your job: given a user's Slack message, return a JSON object with three fields:
{
  "target": "<person, company, or deal name the user is talking about>",
  "content": "<the exact text to log as a Monday update, first-person, lightly cleaned>",
  "confidence": <0.0–1.0 — how sure you are this is a write intent>
}

RULES:
- If the user is clearly asking to log, note, update, add, or otherwise RECORD something in Monday, this is a write intent.
- If the user is asking a QUESTION ("what's the status of X?", "when does X ship?"), confidence should be 0 or very low — it's not a write intent.
- The target is usually a person's name or a company name. It is NEVER an internal ID. Just copy it out of the message.
- The content should read naturally as a Monday update entry. Strip meta-phrases like "Hey Marco, can you make sure..." but keep the actual information. Convert "tomorrow at 11" to a relative phrase — the reader will know today's date.
- If no date is mentioned but the message implies urgency ("meeting"), leave the date as the user said it ("tomorrow", "Friday", etc.). Don't invent dates.
- Do NOT include a signature — that gets appended server-side.
- Return ONLY the JSON object, no prose, no code fences.

EXAMPLES:

Input: "Hey Marco, I'm meeting John Duncan tomorrow at 11 AM. Update his contact in Monday."
Output: {"target":"John Duncan","content":"Meeting tomorrow at 11 AM.","confidence":0.95}

Input: "Spoke with Rivertop on the phone — they want to move forward, sending contract Friday."
Output: {"target":"Rivertop","content":"Spoke on the phone — they want to move forward. Sending contract Friday.","confidence":0.9}

Input: "What's the status of Schellenberg?"
Output: {"target":"Schellenberg","content":"","confidence":0.0}

Input: "Note that the Lemmon project is waiting on hearth size confirmation."
Output: {"target":"Lemmon","content":"Waiting on hearth size confirmation.","confidence":0.88}

Input: "cash"
Output: {"target":"","content":"","confidence":0.0}`;

export async function parseWriteIntent(
  userMessage: string,
): Promise<WriteIntentParsed> {
  const client = anthropic();
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { target: "", content: "", confidence: 0 };
  }

  const raw = textBlock.text.trim();
  try {
    const parsed = JSON.parse(raw) as WriteIntentParsed;
    if (
      typeof parsed.target === "string" &&
      typeof parsed.content === "string" &&
      typeof parsed.confidence === "number"
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return { target: "", content: "", confidence: 0 };
}
