// RPC contract between the server part (index.ts), which stores each category's
// model, and the TUI picker (tui.ts). Rpc.define only checks error names and
// returns the definition, so a plain object keeps this file free of imports.

export const categories = ["code", "ui", "writing"] as const
export type Category = (typeof categories)[number]
export type Models = Partial<Record<Category, string>>

export function isCategory(value: string): value is Category {
  return (categories as readonly string[]).includes(value)
}

export const ModelCategories = {
  id: "personal.model-categories",
  methods: {
    // Chosen models by category, and the worker's configured model used for
    // categories without one.
    get: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          models: { type: "object", additionalProperties: { type: "string" } },
          fallback: { type: ["string", "null"] },
        },
        required: ["models", "fallback"],
        additionalProperties: false,
      },
    },
    // Sets a category's model as `provider/model`; null returns it to the
    // worker's configured model.
    set: {
      input: {
        type: "object",
        properties: {
          category: { enum: [...categories] },
          model: { type: ["string", "null"] },
        },
        required: ["category", "model"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
    },
  },
  events: {},
} as const
