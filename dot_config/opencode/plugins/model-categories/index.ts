// Route the subagent tool's `model` input by task category. The lead passes
// `code`, `ui`, or `writing`, optionally with `#variant`. The plugin replaces it
// with the model chosen for that category in the TUI picker (tui.ts), or with
// the target agent's configured model when none is chosen. Without a variant,
// the model's own default applies. Other values pass through, and the built-in
// tool validates the result.
import { isCategory, ModelCategories, type Category, type Models } from "./rpc.ts"

const KEY = "models"

export default {
  id: "personal.model-categories",
  async setup(ctx) {
    const load = async (): Promise<Models> => {
      const value = await ctx.storage.get(KEY)
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Models) : {}
    }

    // The agent's configured model as `provider/model`, or undefined when it
    // has none and OpenCode picks the session default.
    const agentModel = async (agentID: string): Promise<string | undefined> => {
      try {
        const { data } = await ctx.agent.get({ agentID })
        return data.model ? `${data.model.providerID}/${data.model.id}` : undefined
      } catch {
        return undefined
      }
    }

    // Category and resolved reference per tool call, for the result note.
    const resolved = new Map<string, { category: Category; model: string }>()

    const before = await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return
      const input = event.input as Record<string, unknown> | null
      if (typeof input?.model !== "string") return
      const [category, variant] = input.model.split("#", 2)
      if (!isCategory(category)) return
      const agent = typeof input.agent === "string" ? input.agent : "worker"
      const base = (await load())[category] ?? (await agentModel(agent))
      if (!base) {
        // No model to apply the variant to: let OpenCode pick the default.
        const { model: _, ...rest } = input
        event.input = rest
        return
      }
      const model = variant ? `${base}#${variant}` : base
      event.input = { ...input, model }
      resolved.set(event.id, { category, model })
    })

    const after = await ctx.tool.hook("execute.after", (event) => {
      const entry = resolved.get(event.id)
      if (!entry) return
      resolved.delete(event.id)
      if (event.status !== "completed") return
      // The subagent tool returns its launch message as text parts.
      const note = `Model: ${entry.model} (category "${entry.category}")`
      const content = event.result.content
      if (typeof content === "string") {
        event.result = { ...event.result, content: `${content}\n${note}` }
      } else if (Array.isArray(content)) {
        event.result = { ...event.result, content: [...content, { type: "text", text: `\n${note}` }] }
      }
    })

    const rpc = await ctx.rpc.register(ModelCategories, {
      get: async () => ({ models: await load(), fallback: (await agentModel("worker")) ?? null }),
      set: async (input) => {
        const { category, model } = input as { category: Category; model: string | null }
        const models = await load()
        if (model) models[category] = model
        else delete models[category]
        await ctx.storage.set(KEY, models)
        return {}
      },
    })

    return () => {
      void before.dispose()
      void after.dispose()
      void rpc.dispose()
    }
  },
}
