// Resolve a pool name in the subagent tool's `model` input to a concrete model.
// Pools live in pools.json, read on each call so edits apply without a reload.
// The built-in subagent tool still validates the rewritten reference.
import { readFileSync } from "node:fs"

type Pools = Record<string, string[]>
type Model = { providerID: string; id: string; variants?: { id: string }[] }

const poolsPath = new URL("./pools.json", import.meta.url)

function pools(): Pools {
  try {
    const parsed = JSON.parse(readFileSync(poolsPath, "utf8"))
    return typeof parsed === "object" && parsed !== null ? parsed.pools ?? {} : {}
  } catch (error) {
    console.error(`model-pools: cannot read ${poolsPath.pathname}`, error)
    return {}
  }
}

function available(models: Model[], ref: string): boolean {
  const slash = ref.indexOf("/")
  const hash = ref.indexOf("#", slash + 1)
  const providerID = ref.slice(0, slash)
  const id = ref.slice(slash + 1, hash === -1 ? undefined : hash)
  const variant = hash === -1 ? undefined : ref.slice(hash + 1)
  const model = models.find((m) => m.providerID === providerID && m.id === id)
  if (!model) return false
  return variant === undefined || (model.variants ?? []).some((v) => v.id === variant)
}

export default {
  id: "personal.model-pools",
  async setup(ctx) {
    // Pool name and resolved reference per tool call, for the result note.
    const resolved = new Map<string, { pool: string; model: string }>()

    const before = await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return
      const input = event.input as Record<string, unknown> | null
      if (typeof input !== "object" || input === null) return
      const pool = input.model
      if (typeof pool !== "string" || pool.includes("/")) return
      const candidates = pools()[pool]
      if (!candidates?.length) return

      const list = await ctx.model.list()
      const models: Model[] = Array.isArray(list) ? list : (list?.data ?? [])
      // With no candidate available, pass the first one so the built-in tool
      // reports which model is unavailable.
      const model = candidates.find((ref) => available(models, ref)) ?? candidates[0]
      event.input = { ...input, model }
      resolved.set(event.id, { pool, model })
    })

    const after = await ctx.tool.hook("execute.after", (event) => {
      const entry = resolved.get(event.id)
      if (!entry) return
      resolved.delete(event.id)
      if (event.status !== "completed") return
      // The subagent tool returns its launch message as string content.
      const content = event.result.content
      if (typeof content !== "string") return
      const note = `Model: ${entry.model} (pool "${entry.pool}")`
      event.result = { ...event.result, content: `${content}\n${note}` }
    })

    return () => {
      void before.dispose()
      void after.dispose()
    }
  },
}
