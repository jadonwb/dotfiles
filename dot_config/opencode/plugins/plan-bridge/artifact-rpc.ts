// Typed RPC contract for shared artifacts.
// Contract module only: no registration and no I/O here. The HTTP surface is
// POST /api/rpc/personal.artifacts/<method> with {input} -> {output}; the
// `location` deepObject query selects the registered instance.
//
// The contract carries `events: {}`, which ctx.rpc.register requires for local
// dir plugins. Lifecycle is kind-specific: approve_plan applies to plans only;
// mark_read to evidence, reviews, and reports only; retry_plan_delivery
// redelivers plan approvals only. `list` keeps a strict empty-object input: the
// client always sends the normalized {"input":{}} object body.
//
// Metadata separation: the summary carries only frontend metadata (title,
// description, primaryAuthor, status) plus owner-scoping metadata required for
// the Neovim attached-session filter (ownerSessionID). writerSessionID is
// internal routing/delivery data and is never exposed on the wire; the
// per-artifact summary is produced by store.mjs and stripped in index.ts.

const artifactSummary = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", description: "plan, evidence, review, or report" },
    title: { type: "string" },
    description: { type: ["string", "null"] },
    primaryAuthor: { type: "string", description: "immutable frontend author label derived from the creating agent" },
    status: { type: "string", description: "draft, published, approved, or read" },
    path: { type: "string", description: "the read-only generated view inside the registry" },
    ownerSessionID: { type: "string", description: "owner-scoping session used only for attached-session filtering" },
    finalized: { type: "boolean", description: "readiness: false until the writer finalizes the draft" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "id",
    "kind",
    "title",
    "description",
    "primaryAuthor",
    "status",
    "path",
    "ownerSessionID",
    "finalized",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
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
  required: ["location", "content", "feedback", "approval", ...artifactSummary.required],
  additionalProperties: false,
}

const delivery = {
  type: "object",
  properties: {
    state: { type: "string", description: "pending, delivered, or failed" },
    attemptedAt: { type: ["string", "null"] },
    deliveredAt: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
  },
  required: ["state", "attemptedAt", "deliveredAt", "error"],
  additionalProperties: false,
}

const commonErrors = {
  validation: { type: "object", properties: { reason: { type: "string" } } },
  not_found: { type: "object", properties: { artifactID: { type: "string" } } },
  invalid_kind: { type: "object", properties: { artifactID: { type: "string" }, kind: { type: "string" } } },
  not_ready: { type: "object", properties: { artifactID: { type: "string" }, status: { type: "string" }, finalized: { type: "boolean" } } },
  lock_conflict: { type: "object", properties: { lock: { type: "string" } } },
  io: { type: "object", properties: { detail: { type: "string" } } },
}

const Artifacts = {
  id: "personal.artifacts",
  events: {},
  methods: {
    // Strict empty-object input: the client always sends the normalized
    // {"input":{}} object body.
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { artifacts: { type: "array", items: artifactSummary } },
        required: ["artifacts"],
        additionalProperties: false,
      },
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
      output: { type: "object", properties: { artifact: artifactView }, required: ["artifact"], additionalProperties: false },
      errors: commonErrors,
    },
    feedback: {
      input: {
        type: "object",
        properties: {
          artifactID: { type: "string" },
          requestID: { type: "string", description: "client-generated ID; repeated submissions with the same ID deduplicate" },
          recipient: {
            type: "string",
            enum: ["owner", "writer"],
            description:
              "which stored session identity receives the notification: owner (the Planner) or writer (the artifact's authoring session). Defaults to owner when omitted.",
          },
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
        required: ["requestID", "kind", "deduplicated", "delivery", "artifact"],
        additionalProperties: false,
      },
      errors: commonErrors,
    },
    approve_plan: {
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
        required: ["requestID", "kind", "deduplicated", "delivery", "artifact"],
        additionalProperties: false,
      },
      errors: commonErrors,
    },
    mark_read: {
      input: {
        type: "object",
        properties: {
          artifactID: { type: "string" },
          requestID: { type: "string", description: "client-generated ID; repeated submissions with the same ID deduplicate" },
        },
        required: ["artifactID"],
        additionalProperties: false,
      },
      // No `delivery` in the response: mark_read is evidence/review/report
      // dismissal and never emits an owner notification.
      output: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          kind: { type: "string" },
          deduplicated: { type: "boolean" },
          artifact: artifactSummary,
        },
        required: ["requestID", "kind", "deduplicated", "artifact"],
        additionalProperties: false,
      },
      errors: commonErrors,
    },
    retry_plan_delivery: {
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
        required: ["requestID", "kind", "deduplicated", "delivery", "artifact"],
        additionalProperties: false,
      },
      errors: {
        ...commonErrors,
        not_found: {
          type: "object",
          properties: { artifactID: { type: "string" }, requestID: { type: "string" } },
        },
      },
    },
  },
}

export { Artifacts }