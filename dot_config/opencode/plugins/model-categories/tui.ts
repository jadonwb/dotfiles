// `/worker-models`: pick a category, then the model the server part routes it
// to. The choice is stored by the server part (index.ts) through RPC.
import { Plugin } from "@opencode/plugin/tui"
import { categories, ModelCategories, type Category } from "./rpc.ts"

const LABELS: Record<Category, string> = { code: "Code", ui: "UI", writing: "Writing" }
// Listed first in the model picker: the subscription that runs workers.
const PREFERRED_PROVIDER = "opencode-go"

export default Plugin.define({
  id: "personal.model-categories",
  setup(context) {
    const pick = async () => {
      const location = context.location ?? context.data.location.default()
      const rpc = context.client.rpc(ModelCategories)
      const { models, fallback } = (await rpc.get({}, { location })) as {
        models: Partial<Record<Category, string>>
        fallback: string | null
      }

      const category = await context.ui.dialog.select({
        title: "Worker model category",
        options: categories.map((c) => ({ title: LABELS[c], value: c, description: models[c] ?? "default" })),
      })
      if (!category) return

      await Promise.all([context.data.location.model.sync(location), context.data.location.provider.sync(location)])
      const providers = new Map((context.data.location.provider.list(location) ?? []).map((p) => [p.id, p.name]))
      const rank = (providerID: string) => (providerID === PREFERRED_PROVIDER ? 0 : 1)
      const options = (context.data.location.model.list(location) ?? [])
        .filter((m) => m.enabled && m.type !== "image")
        .toSorted(
          (a, b) =>
            rank(a.providerID) - rank(b.providerID) ||
            (providers.get(a.providerID) ?? a.providerID).localeCompare(providers.get(b.providerID) ?? b.providerID) ||
            a.name.localeCompare(b.name),
        )
        .map((m) => ({
          title: m.name,
          value: `${m.providerID}/${m.id}`,
          category: providers.get(m.providerID) ?? m.providerID,
        }))

      let reset = false
      const model = await context.ui.dialog.select({
        title: `${LABELS[category]} model`,
        placeholder: "Search",
        current: models[category],
        options,
        actions: [
          {
            bind: "ctrl+d",
            title: "Use worker default",
            side: "right",
            selection: "none",
            onTrigger: () => {
              reset = true
              context.ui.dialog.clear()
            },
          },
        ],
      })
      if (!model && !reset) return

      await rpc.set({ category, model: model ?? null }, { location })
      context.ui.toast.show({
        title: "Worker models",
        message: `${LABELS[category]}: ${model ?? `default (${fallback ?? "session model"})`}`,
        variant: "success",
      })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "personal.model-categories.pick",
          title: "Set worker model by category",
          group: "Agent",
          palette: true,
          slash: { name: "worker-models" },
          run: () => {
            void pick().catch((error: unknown) =>
              context.ui.toast.show({
                title: "Worker models",
                message: error instanceof Error ? error.message : String(error),
                variant: "error",
              }),
            )
          },
        },
      ],
    }))
  },
})
