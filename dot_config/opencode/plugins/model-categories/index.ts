// Resolve `category` or `category#variant` in the subagent tool's `model` input
// to the model mapped in categories.json, with the `default` variant when none
// is given. categories.json is read on each call, so edits apply without a
// reload. Other values pass through, and the built-in tool validates the result.
import { readFileSync } from "node:fs"

const path = new URL("./categories.json", import.meta.url)

function categories(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    console.error(`model-categories: cannot read ${path.pathname}`, error)
    return {}
  }
}

export default {
  id: "personal.model-categories",
  async setup(ctx) {
    // Category and resolved reference per tool call, for the result note.
    const resolved = new Map<string, { category: string; model: string }>()

    const before = await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "subagent") return
      const input = event.input as Record<string, unknown> | null
      if (typeof input?.model !== "string") return
      const [category, variant = "default"] = input.model.split("#", 2)
      const ref = categories()[category]
      if (typeof ref !== "string") return
      const model = `${ref}#${variant}`
      event.input = { ...input, model }
      resolved.set(event.id, { category, model })
    })

    const after = await ctx.tool.hook("execute.after", (event) => {
      const entry = resolved.get(event.id)
      if (!entry) return
      resolved.delete(event.id)
      if (event.status !== "completed") return
      // The subagent tool returns its launch message as string content.
      const content = event.result.content
      if (typeof content !== "string") return
      const note = `Model: ${entry.model} (category "${entry.category}")`
      event.result = { ...event.result, content: `${content}\n${note}` }
    })

    return () => {
      void before.dispose()
      void after.dispose()
    }
  },
}
