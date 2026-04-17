/**
 * kb-query skill — process / how-to questions answered from the
 * Monday-hosted Knowledge Base.
 *
 * Examples that land here:
 *   "How do I send a follow-up in Sendblue?"
 *   "What's our brand voice for church clients?"
 *   "Remind me how the intake flow works."
 *   "What's the process for qualifying a lead?"
 *
 * Design:
 *   - Model: claude-opus-4-7 (the most capable Claude — this is the
 *     surface Bella + Andrew hit most in Slack).
 *   - Prompt caching: the KB is injected as a stable system-prompt
 *     block behind a 1h-TTL cache breakpoint. The extended-cache-ttl
 *     beta header is set on the client so the 1h TTL is honored.
 *   - Tier-gating: Tier 3 is refused at the router level; Tier 2 gets
 *     the same financial-redaction hint used elsewhere in Marco.
 *   - Observability: cache_read_input_tokens and
 *     cache_creation_input_tokens are logged so we can confirm the
 *     breakpoint actually hits.
 */

import Anthropic from "@anthropic-ai/sdk";
import { loadKnowledgeBase } from "../../lib/kb.js";
import { MARCO_PERSONA } from "../../lib/marco-persona.js";
import {
  loadConversation,
  appendTurn,
  toClaudeMessages,
  type ConversationTurn,
} from "../../lib/conversation.js";

const KB_PREAMBLE = `You have access to a Knowledge Base (between <knowledge_base> tags) that covers
Oltre's processes, systems, brand voice, follow-up cadences, dashboard features,
and roadmap. Treat it as your primary source, but you may also draw on your
broader understanding of business operations, Oltre's domain, and common sense
to help Bella and Alex when the KB doesn't answer a question directly.

ANSWER TIERS — every answer must fall into one of these three. Always label
best-understanding and out-of-scope answers so the reader knows the confidence.

1. CONCRETE (default): The KB directly covers this.
   - Give the answer, then cite the section: "(KB: Section § Subsection)".
   - Use whenever the KB has the answer, even partially — cite what applies.

2. BEST UNDERSTANDING: The KB doesn't cover it directly, but you can reason
   from related KB content, how Oltre operates, or standard business practice.
   - Start the response with: "Best understanding —"
   - Give the most useful, specific answer you can. Don't hedge to the point
     of being unhelpful.
   - End with: "This isn't explicit in the KB; confirm with Andrew if the
     stakes are high or you want it made official."

3. OUTSIDE MY KNOWLEDGE: The question is far enough from KB content that
   even a reasoned inference would be pure speculation (e.g. personal
   finance, unrelated industries, questions only Andrew can decide).
   - Respond: "That's outside what I know — ask Andrew, and once he answers
     I'll get it added to the KB so it's here next time."

Default to being useful. A Best-Understanding answer with the right label is
better than a refusal, as long as you're clear it's your reasoning rather
than a cited procedure.

OTHER RULES:
- If KB and Monday data disagree, trust Monday for live entity data (deal
  status, dates) and the KB for process.
- Keep answers 2–6 sentences. For multi-step procedures, use a numbered list
  capped at 7 steps and link to the KB section for detail.
- Never paste secrets (tokens, API keys) even if they appear in the KB.
- Sendblue goes live 2026-04-22. Until then, any SMS sends are manual from
  Bella's phone — mention this if relevant.
- No emojis. No exclamation marks.`;

export interface KbQueryArgs {
  question: string;
  tier: 1 | 2 | 3;
  userId?: string;
  /**
   * Slack channel id — when provided, conversation memory is used
   * (same pattern as general-query). DMs benefit; slash commands
   * typically don't pass this.
   */
  channelId?: string;
}

export async function kbQuery(args: KbQueryArgs): Promise<string> {
  const question = args.question.trim();
  if (!question) {
    return "What would you like to know about Oltre's processes? Try *how do I ...* or *what's the process for ...*";
  }

  // Tier 3 should never reach a skill — the router refuses them upstream.
  // Defense in depth: refuse here too.
  if (args.tier === 3) {
    return "I'm not configured to respond to you — please ask Andrew Shpiruk directly.";
  }

  const history: ConversationTurn[] = args.channelId
    ? await loadConversation(args.channelId)
    : [];

  let kb: string;
  try {
    kb = await loadKnowledgeBase();
  } catch (err) {
    console.warn(
      "[kb-query] KB unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return "I couldn't load the knowledge base just now — try again in a minute, or ask Andrew directly.";
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { "anthropic-beta": "extended-cache-ttl-2025-04-11" },
  });

  const tierNote =
    args.tier === 2
      ? "This is a Tier 2 user — don't include financial details beyond deal value and status."
      : "This is Tier 1 (Andrew) — full detail is fine.";

  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 800,
    system: [
      // Stable persona — cacheable prefix shared with future skills.
      { type: "text", text: MARCO_PERSONA },
      // Stable rules for consuming the KB.
      { type: "text", text: KB_PREAMBLE },
      // The KB itself. Cache breakpoint with 1h TTL — this is the big
      // block we actually want to keep warm. Tier hint comes AFTER the
      // breakpoint (on the final block) so per-tier variation doesn't
      // invalidate the prefix.
      {
        type: "text",
        text: `<knowledge_base>\n${kb}\n</knowledge_base>`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      { type: "text", text: tierNote },
    ],
    messages: [
      ...toClaudeMessages(history),
      { role: "user", content: question },
    ],
  });

  // Observability — confirms the cache breakpoint is earning its keep.
  console.info("[kb-query] usage", {
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
  });

  const textBlock = res.content.find((b) => b.type === "text");
  const answer =
    textBlock && textBlock.type === "text"
      ? textBlock.text
      : "I ran into an issue composing the answer. Try rephrasing your question.";

  if (args.channelId) {
    await appendTurn(args.channelId, {
      at: new Date().toISOString(),
      user: question,
      assistant: answer,
    });
  }

  return answer;
}
