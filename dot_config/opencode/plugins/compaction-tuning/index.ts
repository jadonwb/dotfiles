// Compaction summary tuning.
//
// OpenCode's built-in summary prompt is appended as a user message after the
// compaction hooks run, and it asks for terse single-line bullets and "short
// references". Config (`agents.compaction.system`) and `event.system` cannot
// override it, because the later user message wins. There is no config switch
// to disable it.
//
// This hook rewrites the outgoing DeepSeek request body for compaction
// requests: it removes the built-in summary prompt and replaces it with one
// prompt that keeps the required section headings but asks for coverage of the
// work instead of brevity, without reporting tool calls.
//
// Length is deliberately not expressed in tokens. The prompt asks for one
// bullet per distinct item and lets the amount of useful information decide the
// checkpoint size, so it scales with the conversation and with whatever model
// is configured for compaction.

const BUILTIN_MARKERS = [
  "You MUST use this format for your response",
  "The previous response did not fill in the required summary template",
]

const SUMMARY_PROMPT = `Summarize the conversation above into a checkpoint for another agent that will resume this work. The next agent does not see the conversation; it sees this checkpoint and the most recent messages.

Cover the substance, not the mechanics:
- What the user is trying to accomplish, in their own words where it matters.
- Every requirement, preference, constraint, and scope boundary that still applies.
- Every decision already made and why, including alternatives that were rejected and the reason.
- What is done, what is in progress, what is blocked, and why.
- Findings, root causes, and facts discovered that are not obvious from the code or the files: exact paths, symbols, error strings, IDs, versions, numbers, and URLs where they matter.
- Approaches that failed and why they failed.
- Unresolved questions and the precise next actions, in order.

Do not narrate the conversation, and do not keep a log of tool calls, commands, or files that were read. Mention a tool result only when the result itself is a finding the next agent needs. Omit conversational filler, repeated information, and details the next agent can recover cheaply from the repository. In \`## Relevant Files\`, list only the files or directories the next agent must open to continue, not every file that was consulted or changed.

Use one bullet per distinct item. Do not merge separate requirements, decisions, or findings into a single bullet. If the conversation covered more ground, use more bullets; if it was short, keep the checkpoint short. Do not pad, repeat, or invent. Let the length follow the amount of useful information.

Use exactly these headings, omitting a section only if it has no content:

## Objective
## Requirements
## Decisions
## Work State
### Completed
### Active
### Blocked
## Next Move
## Relevant Files
## Important Context

Preserve exact wording for user requirements and unanswered questions. Do not call tools. Return only the summary.`

function isBuiltinSummaryPrompt(message: any): boolean {
  if (!message || message.role !== "user" || typeof message.content !== "string") return false
  return BUILTIN_MARKERS.some((marker) => message.content.includes(marker))
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

        // The built-in prompt, and its retry variant, are always appended at
        // the end. Drop them, then put our prompt in their place.
        while (data.messages.length > 0 && isBuiltinSummaryPrompt(data.messages.at(-1))) {
          data.messages.pop()
        }
        data.messages.push({ role: "user", content: SUMMARY_PROMPT })

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
