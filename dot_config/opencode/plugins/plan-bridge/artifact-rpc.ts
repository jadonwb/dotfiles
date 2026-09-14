// Typed RPC contract for shared artifacts.
// Contract module only: no registration and no I/O here. The HTTP surface is
// POST /api/rpc/personal.artifacts/<method> with {input} -> {output}; the
// `location` deepObject query selects the registered instance.
//
// Runtime note (v2.0.3): a plain structural object with `events: {}` is
// required (the documented `@opencode/plugin/rpc` import does not resolve for
// local dir plugins on this build). Every method is addressed by artifact ID.

const artifactSummary = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", description: "plan, evidence, or review" },
    title: { type: "string" },
    description: { type: ["string", "null"] },
    status: { type: "string", description: "draft, published, or approved" },
    path: { type: "string", description: "the read-only generated view inside the registry" },
    ownerSessionID: { type: "string", description: "owning Planner session" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
}

const artifactView = {
  type: "object",
  properties: {
    ...artifactSummary.properties,
    location: { type: "string" },
    content: { type: "string" },
    feedback: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          question: { type: ["string", "null"] },
          selectedText: { type: ["string", "null"] },
          selectedRange: { type: ["object", "null"] },
          delivery: { type: "object" },
          createdAt: { type: "string" },
        },
      },
    },
    approval: { type: ["object", "null"] },
  },
}

const delivery = {
  type: "object",
  properties: {
    state: { type: "string", description: "pending, delivered, or failed" },
    attemptedAt: { type: ["string", "null"] },
    deliveredAt: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
  },
}

const Artifacts = {
  id: "personal.artifacts",
  // Required on v2.0.3: a plain contract without an `events` field makes
  // ctx.rpc.register throw.
  events: {},
  methods: {
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: { artifacts: { type: "array", items: artifactSummary } } },
      errors: {
        validation: { type: "object", properties: { reason: { type: "string" } } },
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
    get: {
      input: {
        type: "object",
        properties: { artifactID: { type: "string" } },
        required: ["artifactID"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { artifact: artifactView } },
      errors: {
        validation: { type: "object", properties: { reason: { type: "string" } } },
        not_found: { type: "object", properties: { artifactID: { type: "string" } } },
        lock_conflict: { type: "object", properties: { lock: { type: "string" } } },
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
    feedback: {
      input: {
        type: "object",
        properties: {
          artifactID: { type: "string" },
          requestID: { type: "string", description: "client-generated ID; repeated submissions with the same ID deduplicate" },
          question: {
            type: "string",
            description: "the user's question about the artifact (at most 16384 UTF-8 bytes)",
          },
          selectedText: {
            type: "string",
            description: "user-selected Markdown excerpt, when a range was given (at most 65536 UTF-8 bytes)",
          },
          selectedRange: {
            type: "object",
            properties: { start: { type: "number" }, end: { type: "number" } },
            required: ["start", "end"],
          },
        },
        required: ["artifactID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          kind: { type: "string" },
          deduplicated: { type: "boolean" },
          delivery,
          artifact: artifactSummary,
        },
      },
      errors: {
        validation: { type: "object", properties: { reason: { type: "string" } } },
        not_found: { type: "object", properties: { artifactID: { type: "string" } } },
        lock_conflict: { type: "object", properties: { lock: { type: "string" } } },
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
    approve: {
      input: {
        type: "object",
        properties: {
          artifactID: { type: "string" },
          requestID: { type: "string", description: "client-generated ID; repeated submissions with the same ID deduplicate" },
        },
        required: ["artifactID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          kind: { type: "string" },
          deduplicated: { type: "boolean" },
          delivery,
          artifact: artifactSummary,
        },
      },
      errors: {
        validation: { type: "object", properties: { reason: { type: "string" } } },
        not_found: { type: "object", properties: { artifactID: { type: "string" } } },
        lock_conflict: { type: "object", properties: { lock: { type: "string" } } },
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
    retry_delivery: {
      input: {
        type: "object",
        properties: { artifactID: { type: "string" }, requestID: { type: "string" } },
        required: ["artifactID", "requestID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          kind: { type: "string" },
          deduplicated: { type: "boolean" },
          delivery,
          artifact: artifactView,
        },
      },
      errors: {
        validation: { type: "object", properties: { reason: { type: "string" } } },
        not_found: { type: "object", properties: { artifactID: { type: "string" }, requestID: { type: "string" } } },
        lock_conflict: { type: "object", properties: { lock: { type: "string" } } },
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
  },
}

export { Artifacts }
