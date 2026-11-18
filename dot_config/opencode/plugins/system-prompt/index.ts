// Keep agent bodies empty to retain the provider's base prompt and tool guidance.
// Read role guidance on each model call and insert it after the base prompt.
import { readFileSync } from "node:fs"

function prompt(agent: "lead" | "worker"): string {
  const path = new URL(`../../prompts/${agent}.md`, import.meta.url)
  try {
    return readFileSync(path, "utf8").trim()
  } catch (error) {
    console.error(`system-prompt: cannot read ${path.pathname}`, error)
    return ""
  }
}

export default {
  id: "personal.system-prompt",
  async setup(ctx) {
    // "context" is the agent-loop request hook: it runs immediately before the
    // model call, with the assembled system parts of that request.
    const registration = await ctx.session.hook("context", (event) => {
      if (event.agent !== "lead" && event.agent !== "worker") return
      const text = prompt(event.agent)
      if (!text) return
      event.system.splice(1, 0, { type: "text", text })
    })
    return () => {
      void registration.dispose()
    }
  },
}
