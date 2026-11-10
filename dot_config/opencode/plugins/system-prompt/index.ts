// Appends the custom system prompt for the `system` agent after OpenCode's own.
//
// An agent whose Markdown body is non-empty replaces OpenCode's base prompt
// entirely. That removes the `${OPENCODE_TOOL_GUIDANCE}` block OpenCode expands
// from the available tools, and the plugin that expands it skips any agent that
// carries a custom system. Keeping the agent body empty leaves OpenCode's base
// prompt intact; this plugin then inserts prompts/system.md as the next system
// part, ahead of the instruction sources (AGENTS.md). The agent therefore keeps
// OpenCode's version-tracked tool wording and its own behavior.
//
// The prompt file is re-read for each model call, so edits apply without a
// reload and without restarting the server.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const AGENT = "system"
const PROMPT_PATH = join(import.meta.dir, "../../prompts/system.md")

function prompt(): string {
  try {
    return readFileSync(PROMPT_PATH, "utf8").trim()
  } catch (error) {
    console.error(`system-prompt: cannot read ${PROMPT_PATH}`, error)
    return ""
  }
}

export default {
  id: "personal.system-prompt",
  async setup(ctx) {
    // "context" is the agent-loop request hook: it runs immediately before the
    // model call, with the assembled system parts of that request.
    const registration = await ctx.session.hook("context", (event) => {
      if (event.agent !== AGENT) return
      const text = prompt()
      if (!text) return
      event.system.splice(1, 0, { type: "text", text })
    })
    return () => {
      void registration.dispose()
    }
  },
}
