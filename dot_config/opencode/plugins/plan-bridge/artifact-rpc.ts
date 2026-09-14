// Typed RPC contract for shared artifacts (shared-markdown-v1) with generic reads over
// raw-markdown records.
// Contract module only: no registration and no I/O here. The HTTP surface is
// POST /api/rpc/personal.artifacts/<method> with {input} -> {output}; the
// `location` deepObject query selects the registered instance.
//
// Runtime note (v2.0.3): a plain structural object with `events: {}` is
// required (the documented `@opencode/plugin/rpc` import does not resolve for
// local dir plugins on this build). Outputs use `artifacts`/`artifact` and
// include kind, description, authority, provenance, snapshot references and
// delivery summaries.

const artifactSummary = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", description: "plan, evidence, or review; raw-markdown raw-markdown records read as plan" },
    title: { type: "string" },
    description: { type: ["string", "null"], description: "null for raw-markdown raw-markdown records" },
    status: { type: "string", description: "draft, published, or approved" },
    revision: { type: "string", description: "sha256:<hex> content revision (canonical identity header + body for shared artifacts; raw bytes for raw-markdown records)" },
    path: { type: "string", description: "stable current Markdown file inside the registry" },
    ownerSessionID: { type: "string", description: "owning Planner session" },
    authorSessionID: { type: ["string", "null"], description: "author of the current revision; null for raw-markdown raw-markdown records" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    format: { type: "string", description: "shared-markdown-v1 for shared artifacts, raw-markdown for raw-markdown records" },
    schemaVersion: { type: "number" },
    authority: {
      type: "string",
      description: "implementation for plans that authorize Builder once approved; historical for records that do not authorize Builder",
    },
  },
}

const revisionEntry = {
  type: "object",
  properties: {
    revision: { type: "string" },
    createdAt: { type: "string" },
    authorSessionID: { type: ["string", "null"] },
    snapshot: { type: "string", description: "immutable snapshot file for this revision" },
  },
}

const artifactView = {
  type: "object",
  properties: {
    ...artifactSummary.properties,
    location: { type: "string" },
    content: { type: "string" },
    requestedRevision: { type: ["string", "null"], description: "the exact earlier revision when requested; null for current state" },
    snapshot: { type: "string" },
    revisions: { type: "array", items: revisionEntry },
    feedback: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          revision: { type: "string" },
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
        properties: {
          artifactID: { type: "string" },
          revision: { type: "string", description: "optional exact earlier revision; omit for current state" },
        },
        required: ["artifactID"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { artifact: artifactView } },
      errors: {
        validation: { type: "object", properties: { reason: { type: "string" } } },
        not_found: { type: "object", properties: { artifactID: { type: "string" }, revision: { type: "string" } } },
        lock_conflict: { type: "object", properties: { lock: { type: "string" } } },
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
    feedback: {
      input: {
        type: "object",
        properties: {
          artifactID: { type: "string" },
          revision: { type: "string", description: "the displayed content revision the feedback applies to" },
          requestID: { type: "string", description: "client-generated ID; repeated submissions with the same ID deduplicate" },
          question: {
            type: "string",
            description: "the user's question about the displayed revision (at most 16384 UTF-8 bytes)",
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
        required: ["artifactID", "revision"],
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
        stale_revision: { type: "object", properties: { displayed: { type: "string" }, current: { type: "string" } } },
        lock_conflict: { type: "object", properties: { lock: { type: "string" } } },
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
    approve: {
      input: {
        type: "object",
        properties: {
          artifactID: { type: "string" },
          revision: { type: "string", description: "the displayed content revision to approve" },
          requestID: { type: "string", description: "client-generated ID; repeated submissions with the same ID deduplicate" },
        },
        required: ["artifactID", "revision"],
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
        stale_revision: { type: "object", properties: { displayed: { type: "string" }, current: { type: "string" } } },
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
