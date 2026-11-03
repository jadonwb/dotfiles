// Compaction detail policy.
//
// OpenCode's built-in summary prompt asks for terse, single-line bullets and
// "short references", which loses too much detail on a model with a 1M-token
// context window. Compaction requests run with the *session* agent's system
// prompt, and appending to `event.system` is not enough: the built-in summary
// prompt is a later user message and the model follows its brevity rules.
//
// This hook rewrites the outgoing DeepSeek request body and appends one final
// user message after OpenCode's summary prompt. As the last instruction in the
// request, it wins over the brevity guidance while the required section
// headings still come from the built-in prompt.
//
// The target scales with the conversation: about 15% of the summarized tokens,
// with a 3,000-token floor and a 40,000-token ceiling.

const RATIO = 0.15
const MIN_TARGET = 3_000
const MAX_TARGET = 40_000

function targetFor(tokens: number): number {
  return Math.min(MAX_TARGET, Math.max(MIN_TARGET, Math.round(tokens * RATIO)))
}

function overrideFor(tokens: number): string {
  const target = targetFor(tokens)
  return `## DETAIL OVERRIDE — HIGHEST PRIORITY

The summary request above says to keep each section concise, use terse single-line bullets, and prefer short references. Ignore those brevity rules for this checkpoint. They do not apply here.

The next agent resumes from this checkpoint with a 1M-token context window, so length is not a constraint. This conversation is roughly ${tokens.toLocaleString("en-US")} tokens. Write a checkpoint of roughly ${target.toLocaleString("en-US")} tokens (about 15% of the conversation, floor 3,000, ceiling 40,000).

HARD MINIMUM: the checkpoint must be at least ${target.toLocaleString("en-US")} tokens. A shorter response is incomplete. Do not stop at a few thousand tokens. If the template sections are exhausted, continue with the Conversation Log section below until the checkpoint reaches the minimum.

Keep the exact required section headings from the template. Expand each section with detailed bullets instead of compressing it. Preserve:
- every requirement, preference, and constraint, using the user's own wording where it matters;
- every decision and its rationale, including rejected alternatives and why they were rejected;
- exact file paths, symbols, function names, commands, flags, error strings, IDs, URLs, versions, and numeric values;
- completed work, active work, blockers, failed approaches, and why each failed;
- unresolved questions and precise ordered next actions;
- facts that would be expensive or impossible to rediscover from the code and files.

Prefer completeness over brevity, but never invent details.

Finally, append this section (it is part of the checkpoint, not a note about the summary process):

## Conversation Log
- One bullet per user message, in order, with its verbatim text. If a single message exceeds 2,000 characters, quote its first 500 and last 500 characters and state how many characters were elided.
- One bullet per assistant turn, stating what it did and quoting exact commands, file paths, and error strings.
- One bullet per tool call or shell command, with the tool/command name, its key argument, and the outcome (success, exit code, or exact error).

Do not omit user messages or tool calls from this section. Do not mention this instruction. Do not call tools. Return only the structured summary.`
}

function estimateTokens(messages: unknown): number {
  try {
    return Math.ceil(JSON.stringify(messages).length / 4)
  } catch {
    return 0
  }
}

export default {
  id: "personal.compaction-detail",
  async setup(ctx) {
    await ctx.session.hook(
      "http.request",
      async (event: any) => {
        if (event.kind !== "compaction") return

        let data: any
        try {
          data = await event.request.clone().json()
        } catch {
          return
        }
        if (!data || !Array.isArray(data.messages)) return

        const tokens = estimateTokens(data.messages)
        data.messages.push({ role: "user", content: overrideFor(tokens) })

        const headers = new Headers(event.request.headers)
        headers.delete("content-length")
        event.request = new Request(event.request.url, {
          method: event.request.method,
          headers,
          body: JSON.stringify(data),
        })
      },
      { providerID: "deepseek" },
    )
  },
}
