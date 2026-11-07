// Capability-specific artifact tools. Mutations are create/set/patch/
// finalize per kind and the kind is fixed by the tool:
// - plan: plan_create, plan_field_set, plan_field_patch, plan_evidence_add,
//   plan_evidence_remove, plan_finalize, plan_status, plan_load_approved.
// - evidence: evidence_create, evidence_overview_put, evidence_finding_put,
//   evidence_finding_remove, evidence_finalize, evidence_load,
//   evidence_summary.
// - review: review_create, review_outcome_put, review_summary_put,
//   review_finding_put, review_finding_remove, review_finalize, review_load,
//   review_summary.
// - report: report_create, report_content_put, report_content_remove,
//   report_finalize, report_load, report_summary.
//
// Summary/status readers omit artifact bodies; full loaders include them.
//
// Authorization model:
// - The owner is the nearest Planner session in the server-assigned session
//   ancestry (ctx.session.get walks parentID) — retained for routing, feedback,
//   and cleanup. The writer is the creating session itself and is the sole
//   mutation authority: the store rejects any session that is not the stored
//   writer, and resuming the same writer session retains write access.
// - primaryAuthor is immutable frontend metadata derived from the creating
//   agent's name/label; owner/writer/session IDs stay internal routing data.
//
// Finalize semantics: evidence/review/report finalization publishes the draft;
// plan finalization makes the draft approvable. Every mutation clears
// finalization until the writer finalizes again.

import { resolve as resolvePath } from "node:path"

import { PLAN_PATCH_FIELDS, PLAN_SET_FIELDS, REPORT_SECTIONS, REVIEW_OUTCOMES, StoreError } from "./store.mjs"

const ERROR_PREFIX = "ARTIFACT_ERROR"

const MAX_ANCESTRY_HOPS = 16

const PLANNER_AGENT = "planner"

export type ToolContext = { sessionID: string; agent: string; messageID: string; id: string }

export type SessionLike = {
  id: string
  parentID?: string
  agent?: string
  location?: { directory?: string }
}

export type SessionGetter = (input: { sessionID: string }) => Promise<unknown>

function errorLines(code: string, message: string): string[] {
  return [ERROR_PREFIX, `${code}: ${message}`]
}

function normalizeAgent(agent: unknown): string | null {
  if (typeof agent !== "string") return null
  const trimmed = agent.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/** Normalize a raw session result; HTTP-style transports may wrap it as {data}. */
function unwrapSession(raw: unknown): SessionLike | null {
  if (raw === null || typeof raw !== "object") return null
  const candidate = raw as Record<string, unknown>
  const inner = candidate.data !== undefined ? candidate.data : candidate
  if (inner === null || typeof inner !== "object") return null
  const session = inner as Record<string, unknown>
  if (typeof session.id !== "string" || !session.id.startsWith("ses_")) return null
  return session as unknown as SessionLike
}

type ResolvedSession = { sessionID: string; agent: string | null; parentID: string | null }

function sameLocation(location: unknown, directory: string): boolean {
  if (location === null || typeof location !== "object") return false
  const raw = (location as Record<string, unknown>).directory
  if (typeof raw !== "string" || raw.length === 0) return false
  return resolvePath(raw) === resolvePath(directory)
}

/**
 * Fetch and validate one session: the returned record must carry the requested
 * ID and sit in the plugin instance's location.
 */
async function fetchValidatedSession(deps: { getSession: SessionGetter; directory: string }, sessionID: string): Promise<ResolvedSession> {
  let raw: unknown
  try {
    raw = await deps.getSession({ sessionID })
  } catch (error) {
    throw new Error(`owner_unresolved: session lookup failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const session = unwrapSession(raw)
  if (!session || session.id !== sessionID) {
    throw new Error(`owner_unresolved: session lookup returned no verifiable session for ${sessionID}`)
  }
  if (!sameLocation(session.location, deps.directory)) {
    throw new Error(`owner_unresolved: session ${sessionID} is not active in this location; same-location ownership only`)
  }
  return {
    sessionID: session.id,
    agent: normalizeAgent(session.agent),
    parentID: typeof session.parentID === "string" && session.parentID.startsWith("ses_") ? session.parentID : null,
  }
}

export type Provenance = { ownerSessionID: string }

/**
 * Resolve the owner for a tool action by walking server-assigned ancestry: the
 * caller itself when it is a Planner, otherwise the nearest Planner ancestor.
 * When no Planner ancestor is reachable the caller owns its own artifact.
 */
export async function resolveProvenance(deps: { getSession: SessionGetter; directory: string }, toolContext: ToolContext): Promise<Provenance> {
  const callerSessionID = toolContext.sessionID
  const caller = await fetchValidatedSession(deps, callerSessionID)
  if (caller.agent === PLANNER_AGENT) {
    return { ownerSessionID: caller.sessionID }
  }
  const visited = new Set<string>([callerSessionID])
  let session = caller
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && session.parentID; hop += 1) {
    const parentID = session.parentID
    if (visited.has(parentID)) break
    visited.add(parentID)
    let parent: ResolvedSession
    try {
      parent = await fetchValidatedSession(deps, parentID)
    } catch {
      break
    }
    if (parent.agent === PLANNER_AGENT) {
      return { ownerSessionID: parent.sessionID }
    }
    session = parent
  }
  return { ownerSessionID: callerSessionID }
}

/**
 * Resolve the writer for a content mutation: the validated calling session.
 * The store compares this against the immutable writerSessionID recorded at
 * creation, so Planner and sibling workers are rejected unless they are the
 * writer (resuming the same worker session retains access).
 */
async function resolveWriter(deps: { getSession: SessionGetter; directory: string }, toolContext: ToolContext): Promise<string> {
  try {
    const caller = await fetchValidatedSession(deps, toolContext.sessionID)
    return caller.sessionID
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`writer_unresolved: caller session ${toolContext.sessionID} cannot be validated: ${detail}`)
  }
}

/**
 * Immutable frontend author metadata derived from the creating agent's name.
 * Never a session ID: owner/writer/session identities remain internal routing
 * data and must not reach frontmatter or model-facing provenance.
 */
export function primaryAuthorOf(agent: unknown): string {
  const normalized = normalizeAgent(agent)
  if (!normalized || normalized === "general") return "Author"
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function formatError(error: unknown): string {
  return errorLines(
    error instanceof StoreError ? error.code : "internal",
    error instanceof Error ? error.message : String(error),
  ).join("\n")
}

// ---------------------------------------------------------------------------
// Compact synthetic-delivery message builders (model sees text; metadata is
// bookkeeping only; description is the short UI label rendered after the
// synthetic event marker).
// ---------------------------------------------------------------------------

function truncate(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= maxLength ? collapsed : collapsed.slice(0, maxLength - 1) + "…"
}

export function artifactDeliveryDescription(input: { action: "feedback" | "approval"; title: string }): string {
  return `${input.action === "approval" ? "Approval" : "Feedback"}: ${truncate(input.title, 80)}`
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}

export function artifactFeedbackMessage(input: {
  kind: string
  title: string
  artifactID: string
  question?: string | null
  selectedText?: string | null
  selectedRange?: { start: number; end: number } | null
}): string {
  const lines: string[] = [`Feedback on ${input.kind} "${truncate(input.title, 120)}"`, `Artifact: ${input.artifactID}`]
  if (input.question && input.question.trim().length > 0) {
    lines.push("", `User question: ${input.question.trim()}`)
  }
  // Exactly one context representation: the quoted excerpt when present,
  // otherwise the selected line range, otherwise nothing (general feedback).
  if (input.selectedText && input.selectedText.length > 0) {
    lines.push("", "> --- begin user selection ---", quoteBlock(input.selectedText), "> --- end user selection ---")
  } else if (input.selectedRange) {
    lines.push("", `Context: the user selected lines ${input.selectedRange.start}-${input.selectedRange.end}; no excerpt is quoted.`)
  }
  return lines.join("\n")
}

export function artifactApprovalMessage(input: { artifactID: string; kind: string; status: string; finalized: boolean }): string {
  return `approval delivered: ${input.artifactID} (kind=${input.kind} status=${input.status} finalized=${input.finalized})`
}

export function artifactDeliveryMetadata(input: {
  artifactID: string
  requestID: string
  kind: string
  submission: "feedback" | "approval"
  recipient?: "owner" | "writer"
}): Record<string, string> {
  const metadata: Record<string, string> = {
    artifactID: input.artifactID,
    requestID: input.requestID,
    kind: input.kind,
    submission: input.submission,
    recipient: input.recipient ?? "owner",
    source: "personal.artifacts",
  }
  return metadata
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export type ArtifactSummary = {
  id: string
  kind: string
  title: string
  description: string
  primaryAuthor: string
  status: string
  path: string
  ownerSessionID: string
  writerSessionID: string
  finalized: boolean
  createdAt: string
  updatedAt: string
}

export type ArtifactView = ArtifactSummary & { location: string; content: string }

export type ArtifactStructure = {
  evidence?: string[]
  findings?: { id: string; title: string }[]
  outcome?: string | null
  planArtifactID?: string
}

export type ArtifactToolDeps = {
  store: {
    createArtifact(input: {
      kind: string
      ownerSessionID: string
      writerSessionID: string
      primaryAuthor: string
      location: string
      title: string
      description: string
      workingDirectory?: string
      planArtifactID?: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    planFieldSet(input: {
      artifactID: string
      location: string
      writerSessionID: string
      field: string
      content: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    planFieldPatch(input: {
      artifactID: string
      location: string
      writerSessionID: string
      field: string
      oldText: string
      newText: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    planEvidenceAddMany(input: {
      artifactID: string
      location: string
      writerSessionID: string
      evidenceIDs: string[]
    }): Promise<{ artifactID: string } & ArtifactSummary>
    planEvidenceRemove(input: {
      artifactID: string
      location: string
      writerSessionID: string
      evidenceID: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    planFinalize(input: { artifactID: string; location: string; writerSessionID: string }): Promise<{ artifactID: string } & ArtifactSummary>
    evidenceOverviewPut(input: {
      artifactID: string
      location: string
      writerSessionID: string
      question?: string | null
      summary?: string
      limitations?: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    evidenceFindingPut(input: {
      artifactID: string
      location: string
      writerSessionID: string
      findingID?: string
      title: string
      content: string
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>
    evidenceFindingRemove(input: {
      artifactID: string
      location: string
      writerSessionID: string
      findingID: string
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>
    evidenceFinalize(input: { artifactID: string; location: string; writerSessionID: string }): Promise<{ artifactID: string } & ArtifactSummary>
    reviewOutcomePut(input: {
      artifactID: string
      location: string
      writerSessionID: string
      outcome: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    reviewSummaryPut(input: {
      artifactID: string
      location: string
      writerSessionID: string
      content: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    reviewFindingPut(input: {
      artifactID: string
      location: string
      writerSessionID: string
      findingID?: string
      title: string
      severity: string
      affected?: string
      evidence?: string
      risk?: string
      correction: string
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>
    reviewFindingRemove(input: {
      artifactID: string
      location: string
      writerSessionID: string
      findingID: string
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>
    reviewFinalize(input: { artifactID: string; location: string; writerSessionID: string }): Promise<{ artifactID: string } & ArtifactSummary>
    reportContentPut(input: {
      artifactID: string
      location: string
      writerSessionID: string
      section: string
      content: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    reportContentRemove(input: {
      artifactID: string
      location: string
      writerSessionID: string
      section: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    reportFinalize(input: { artifactID: string; location: string; writerSessionID: string }): Promise<{ artifactID: string } & ArtifactSummary>
    getArtifact(input: { artifactID: string; location: string }): Promise<ArtifactView>
    getArtifactMetadata(input: { artifactID: string; location: string }): Promise<ArtifactSummary>
    getArtifactStructure(input: { artifactID: string; location: string }): Promise<ArtifactStructure>
    getApprovedPlan(input: { artifactID: string; location: string }): Promise<ArtifactView>
    getEvidence(input: { artifactID: string; location: string }): Promise<ArtifactView>
    getReview(input: { artifactID: string; location: string }): Promise<ArtifactView>
    getReport(input: { artifactID: string; location: string }): Promise<ArtifactView>
    getEvidenceSummary(input: { artifactID: string; location: string }): Promise<
      ArtifactSummary & { question: string | null; summary: string; limitations: string }
    >
    getReviewSummary(input: { artifactID: string; location: string }): Promise<ArtifactSummary & { outcome: string | null; summary: string }>
    getReportSummary(input: { artifactID: string; location: string }): Promise<ArtifactSummary & { planArtifactID: string; summary: string }>
  }
  directory: string
  getSession: SessionGetter
}

function finalizedLabel(finalized: boolean): string {
  return finalized ? "true" : "false"
}

function summaryHeader(summary: ArtifactSummary, prefix: string): string[] {
  return [
    prefix,
    `Kind: ${summary.kind}`,
    `Status: ${summary.status}`,
    `Title: ${summary.title}`,
    `Artifact: ${summary.id}`,
    `Author: ${summary.primaryAuthor}`,
    `Finalized: ${finalizedLabel(summary.finalized)}`,
  ]
}

function structureLines(summary: ArtifactSummary, structure: ArtifactStructure): string[] {
  if (summary.kind === "plan" && structure.evidence) {
    if (structure.evidence.length === 0) return ["Evidence: none"]
    return [`Evidence: ${structure.evidence.join(", ")}`]
  }
  if (summary.kind === "evidence" && structure.findings) {
    if (structure.findings.length === 0) return ["Findings: none"]
    return [`Findings: ${structure.findings.map((finding) => finding.id).join(", ")}`]
  }
  if (summary.kind === "review") {
    const lines: string[] = [`Outcome: ${structure.outcome ?? "unset"}`]
    if (structure.findings && structure.findings.length > 0) {
      lines.push(`Findings: ${structure.findings.map((finding) => finding.id).join(", ")}`)
    }
    return lines
  }
  if (summary.kind === "report" && structure.planArtifactID) {
    return [`Plan: ${structure.planArtifactID}`]
  }
  return []
}

export function addArtifactTools(
  editor: {
    namespace: (namespace: { name: string; description: string }) => void
    add: (tool: unknown) => void
  },
  deps: ArtifactToolDeps,
): void {
  editor.namespace({
    name: "plan",
    description: "Creates, modifies, finalizes, and reads plan artifacts.",
  })
  editor.namespace({
    name: "evidence",
    description: "Creates, modifies, finalizes, and reads evidence artifacts.",
  })
  editor.namespace({
    name: "review",
    description: "Creates, modifies, finalizes, and reads review artifacts.",
  })
  editor.namespace({
    name: "report",
    description: "Creates, modifies, finalizes, and reads report artifacts.",
  })

  type ToolDef = {
    name: string
    namespace: string
    description: string
    input: Record<string, unknown>
    handler: (input: any, toolContext: ToolContext) => Promise<{ content: string }>
  }

  function addTool(tool: ToolDef): void {
    const effectiveName = `${tool.namespace}_${tool.name}`
    editor.add({
      name: tool.name,
      description: tool.description,
      input: tool.input,
      options: { namespace: tool.namespace, codemode: true, permission: effectiveName },
      async execute(input: any, toolContext: ToolContext) {
        try {
          return await tool.handler(input, toolContext)
        } catch (error) {
          return { content: formatError(error) }
        }
      },
    })
  }

  /** Finalize returns the bare artifact ID/status contract: `art_… published` or `art_… finalized`. */
  function bareFinalize(summary: { artifactID: string; status: string }): string {
    return `${summary.artifactID} ${summary.status === "published" ? "published" : "finalized"}`
  }

  // -------------------------------------------------------------------------
  // Plan tools (namespace "plan")
  // -------------------------------------------------------------------------

  addTool({
    name: "create",
    namespace: "plan",
    description:
      "Create an empty plan draft. Returns its ID.",
    input: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, description: "Short plan title (immutable)." },
        description: { type: "string", minLength: 1, description: "One-sentence plan description (immutable)." },
        workingDirectory: { type: "string", minLength: 1, description: "Absolute working directory." },
      },
      required: ["title", "description", "workingDirectory"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext)
      const writer = await resolveWriter(deps, toolContext)
      const created = await deps.store.createArtifact({
        kind: "plan",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: deps.directory,
        title: input.title,
        description: input.description,
        workingDirectory: input.workingDirectory,
      })
      return { content: created.artifactID }
    },
  })

  addTool({
    name: "field_set",
    namespace: "plan",
    description: "Replace goalScope or checks wholesale. Empty content clears checks. Returns the plan ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
        field: { type: "string", enum: [...PLAN_SET_FIELDS] },
        content: { type: "string", description: "Whole-field Markdown content; empty allowed only for checks." },
      },
      required: ["artifactID", "field", "content"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const put = await deps.store.planFieldSet({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        field: input.field,
        content: input.content,
      })
      return { content: put.artifactID }
    },
  })

  addTool({
    name: "field_patch",
    namespace: "plan",
    description:
      "Replace a plan prose field when oldText exactly matches its current value; otherwise return patch_conflict.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
        field: { type: "string", enum: [...PLAN_PATCH_FIELDS] },
        oldText: { type: "string", description: "Exact current field content to replace." },
        newText: { type: "string", description: "Replacement field content." },
      },
      required: ["artifactID", "field", "oldText", "newText"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const patched = await deps.store.planFieldPatch({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        field: input.field,
        oldText: input.oldText,
        newText: input.newText,
      })
      return { content: patched.artifactID }
    },
  })

  addTool({
    name: "evidence_add",
    namespace: "plan",
    description:
      "Attach finalized evidence IDs in order. Validates all before one atomic write, snapshots descriptions, and skips duplicates.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
        evidenceIDs: {
          type: "array",
          items: { type: "string", description: "Evidence artifact ID (art_…)." },
          minItems: 1,
          description: "Ordered evidence artifact IDs to attach (art_…).",
        },
      },
      required: ["artifactID", "evidenceIDs"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const added = await deps.store.planEvidenceAddMany({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        evidenceIDs: input.evidenceIDs,
      })
      return { content: added.artifactID }
    },
  })

  addTool({
    name: "evidence_remove",
    namespace: "plan",
    description:
      "Remove one evidence ID from the plan's membership. Returns its ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
        evidenceID: { type: "string", description: "Evidence artifact ID to detach." },
      },
      required: ["artifactID", "evidenceID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const removed = await deps.store.planEvidenceRemove({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        evidenceID: input.evidenceID,
      })
      return { content: removed.artifactID }
    },
  })

  addTool({
    name: "finalize",
    namespace: "plan",
    description:
      "Finalize a plan draft: requires non-empty goalScope and intendedChanges; checks, context and evidence are optional. The plan becomes approvable. Returns `art_… finalized`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const finalized = await deps.store.planFinalize({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
      })
      return { content: bareFinalize(finalized) }
    },
  })

  addTool({
    name: "status",
    namespace: "plan",
    description:
      "Read a plan's metadata and readiness by ID; returns no body.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const summary = await deps.store.getArtifactMetadata({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      if (summary.kind !== "plan") {
        throw new StoreError(
          "invalid_kind",
          `Plan status applies to plans only; ${input.artifactID} is a ${summary.kind}`,
          { artifactID: input.artifactID, kind: summary.kind },
        )
      }
      return {
        content: ["ARTIFACT_STATUS", ...summaryHeader(summary, "ARTIFACT_STATUS").slice(1)].join("\n"),
      }
    },
  })

  addTool({
    name: "load_approved",
    namespace: "plan",
    description:
      "Load an approved plan by ID with its full Markdown content inline; rejects non-plans (invalid_kind) and unapproved plans (not_approved).",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Approved plan artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const view = await deps.store.getApprovedPlan({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      const structure = await deps.store.getArtifactStructure({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      return {
        content: [...summaryHeader(view, "ARTIFACT_CONTENT"), ...structureLines(view, structure), "", view.content].join("\n"),
      }
    },
  })

  // -------------------------------------------------------------------------
  // Evidence tools (namespace "evidence")
  // -------------------------------------------------------------------------

  addTool({
    name: "create",
    namespace: "evidence",
    description:
      "Create an empty evidence draft. Returns its ID.",
    input: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, description: "Short immutable evidence title." },
        description: { type: "string", minLength: 1, description: "One-sentence evidence description (immutable)." },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext)
      const writer = await resolveWriter(deps, toolContext)
      const created = await deps.store.createArtifact({
        kind: "evidence",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: deps.directory,
        title: input.title,
        description: input.description,
      })
      return { content: created.artifactID }
    },
  })

  addTool({
    name: "overview_put",
    namespace: "evidence",
    description:
      "Set the overview fields in one call: question, Summary, Limitations. Each provided field replaces the stored field; omitted fields stay untouched; pass question=null to clear it. At least one field is required. Returns its ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
        question: { type: ["string", "null"], description: "Main question/topic." },
        summary: { type: "string", description: "Summary prose." },
        limitations: { type: "string", description: "Limitations or Issues prose." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const put = await deps.store.evidenceOverviewPut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        question: input.question,
        summary: input.summary,
        limitations: input.limitations,
      })
      return { content: put.artifactID }
    },
  })

  addTool({
    name: "finding_put",
    namespace: "evidence",
    description:
      "Add (no findingID) or replace in place (findingID) one finding. Appending returns the generated finding ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
        findingID: { type: "string", description: "Omit to append; supply an existing finding ID to replace that finding in place." },
        title: { type: "string", minLength: 1, description: "Descriptive finding title." },
        content: { type: "string", minLength: 1, description: "Self-contained Markdown finding content." },
      },
      required: ["artifactID", "title", "content"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const put = await deps.store.evidenceFindingPut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        findingID: input.findingID,
        title: input.title,
        content: input.content,
      })
      return { content: put.findingID }
    },
  })

  addTool({
    name: "finding_remove",
    namespace: "evidence",
    description:
      "Remove one finding by its stable finding ID. Returns that ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
        findingID: { type: "string", description: "Stable finding ID to remove." },
      },
      required: ["artifactID", "findingID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const removed = await deps.store.evidenceFindingRemove({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        findingID: input.findingID,
      })
      return { content: removed.findingID }
    },
  })

  addTool({
    name: "finalize",
    namespace: "evidence",
    description:
      "Finalize an evidence draft: requires a Summary, Limitations, or at least one finding; publishes it. Returns `art_… published`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const finalized = await deps.store.evidenceFinalize({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
      })
      return { content: bareFinalize(finalized) }
    },
  })

  addTool({
    name: "load",
    namespace: "evidence",
    description:
      "Load an evidence artifact by ID with its full Markdown content inline; rejects non-evidence IDs with invalid_kind.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const view = await deps.store.getEvidence({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      const structure = await deps.store.getArtifactStructure({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      return {
        content: [...summaryHeader(view, "ARTIFACT_CONTENT"), ...structureLines(view, structure), "", view.content].join("\n"),
      }
    },
  })

  addTool({
    name: "summary",
    namespace: "evidence",
    description:
      "Read evidence metadata, question, Summary, and Limitations. Excludes findings.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const summary = await deps.store.getEvidenceSummary({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      const lines = ["ARTIFACT_SUMMARY", ...summaryHeader(summary, "ARTIFACT_SUMMARY").slice(1)]
      if (summary.question) lines.push(`Question: ${summary.question}`)
      if (summary.summary.length > 0) lines.push(`Summary: ${summary.summary}`)
      if (summary.limitations.length > 0) lines.push(`Limitations: ${summary.limitations}`)
      return { content: lines.join("\n") }
    },
  })

  // -------------------------------------------------------------------------
  // Review tools (namespace "review")
  // -------------------------------------------------------------------------

  addTool({
    name: "create",
    namespace: "review",
    description:
      "Create an empty review draft. Returns its ID.",
    input: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, description: "Short review title (immutable)." },
        description: { type: "string", minLength: 1, description: "One-sentence review description (immutable)." },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext)
      const writer = await resolveWriter(deps, toolContext)
      const created = await deps.store.createArtifact({
        kind: "review",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: deps.directory,
        title: input.title,
        description: input.description,
      })
      return { content: created.artifactID }
    },
  })

  addTool({
    name: "outcome_put",
    namespace: "review",
    description:
      "Set the machine-readable review outcome (Pass, Changes required, or Blocked). Returns its ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
        outcome: { type: "string", enum: [...REVIEW_OUTCOMES], description: "Machine-readable review outcome." },
      },
      required: ["artifactID", "outcome"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const put = await deps.store.reviewOutcomePut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        outcome: input.outcome,
      })
      return { content: put.artifactID }
    },
  })

  addTool({
    name: "summary_put",
    namespace: "review",
    description:
      "Set the human-readable Summary prose. Returns its ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
        content: { type: "string", minLength: 1, description: "Summary Markdown." },
      },
      required: ["artifactID", "content"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const put = await deps.store.reviewSummaryPut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        content: input.content,
      })
      return { content: put.artifactID }
    },
  })

  addTool({
    name: "finding_put",
    namespace: "review",
    description:
      "Add (no findingID) or replace in place (findingID) one structured finding. Appending returns the generated finding ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
        findingID: { type: "string", description: "Omit to append; supply an existing finding ID to replace that finding in place." },
        title: { type: "string", minLength: 1, description: "Descriptive finding title." },
        severity: { type: "string", minLength: 1, description: "Severity label (e.g. high, medium, low, blocked)." },
        affected: { type: "string", description: "Affected path/symbol." },
        evidence: { type: "string", description: "Supporting evidence for the finding." },
        risk: { type: "string", description: "Behavioral risk of not correcting it." },
        correction: { type: "string", minLength: 1, description: "Required correction." },
      },
      required: ["artifactID", "title", "severity", "correction"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const put = await deps.store.reviewFindingPut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        findingID: input.findingID,
        title: input.title,
        severity: input.severity,
        affected: input.affected,
        evidence: input.evidence,
        risk: input.risk,
        correction: input.correction,
      })
      return { content: put.findingID }
    },
  })

  addTool({
    name: "finding_remove",
    namespace: "review",
    description:
      "Remove one finding by its stable finding ID. Returns that ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
        findingID: { type: "string", description: "Stable finding ID to remove." },
      },
      required: ["artifactID", "findingID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const removed = await deps.store.reviewFindingRemove({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        findingID: input.findingID,
      })
      return { content: removed.findingID }
    },
  })

  addTool({
    name: "finalize",
    namespace: "review",
    description:
      "Finalize a review: requires the machine-readable outcome and the human-readable Summary; publishes it. Returns `art_… published`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const finalized = await deps.store.reviewFinalize({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
      })
      return { content: bareFinalize(finalized) }
    },
  })

  addTool({
    name: "load",
    namespace: "review",
    description:
      "Load a review artifact by ID with its full Markdown content inline.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const view = await deps.store.getReview({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      const structure = await deps.store.getArtifactStructure({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      return {
        content: [...summaryHeader(view, "ARTIFACT_CONTENT"), ...structureLines(view, structure), "", view.content].join("\n"),
      }
    },
  })

  addTool({
    name: "summary",
    namespace: "review",
    description:
      "Read review metadata, the machine-readable outcome, and the human-readable Summary. Excludes findings.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const summary = await deps.store.getReviewSummary({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      const lines = ["ARTIFACT_SUMMARY", ...summaryHeader(summary, "ARTIFACT_SUMMARY").slice(1)]
      lines.push(`Outcome: ${summary.outcome ?? "unset"}`)
      if (summary.summary.length > 0) lines.push(`Summary: ${summary.summary}`)
      return { content: lines.join("\n") }
    },
  })

  // -------------------------------------------------------------------------
  // Report tools (namespace "report")
  // -------------------------------------------------------------------------

  addTool({
    name: "create",
    namespace: "report",
    description:
      "Create a report artifact linked to an approved plan; title and description default to the plan's. Returns its ID.",
    input: {
      type: "object",
      properties: {
        planArtifactID: { type: "string", description: "Approved plan artifact ID." },
        title: { type: "string", description: "Optional report title override (defaults to Report: <plan title>)." },
        description: { type: "string", description: "Optional report description override (defaults to the plan description)." },
      },
      required: ["planArtifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext)
      const writer = await resolveWriter(deps, toolContext)
      const created = await deps.store.createArtifact({
        kind: "report",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: deps.directory,
        title: input.title,
        description: input.description,
        planArtifactID: input.planArtifactID,
      })
      return { content: created.artifactID }
    },
  })

  addTool({
    name: "content_put",
    namespace: "report",
    description:
      "Replace one whole report section (summary, changed, checks, or unfinished) with content. Returns its ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Report artifact ID." },
        section: { type: "string", enum: [...REPORT_SECTIONS] },
        content: { type: "string", minLength: 1, description: "Whole-section Markdown content." },
      },
      required: ["artifactID", "section", "content"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const put = await deps.store.reportContentPut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        section: input.section,
        content: input.content,
      })
      return { content: put.artifactID }
    },
  })

  addTool({
    name: "content_remove",
    namespace: "report",
    description:
      "Clear one whole report section (summary, changed, checks, or unfinished). Returns its ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Report artifact ID." },
        section: { type: "string", enum: [...REPORT_SECTIONS] },
      },
      required: ["artifactID", "section"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const removed = await deps.store.reportContentRemove({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        section: input.section,
      })
      return { content: removed.artifactID }
    },
  })

  addTool({
    name: "finalize",
    namespace: "report",
    description:
      "Finalize a report: requires the Summary (Changed/Checks/Unfinished stay optional); publishes it. Returns `art_… published`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Report artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext)
      const finalized = await deps.store.reportFinalize({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
      })
      return { content: bareFinalize(finalized) }
    },
  })

  addTool({
    name: "load",
    namespace: "report",
    description:
      "Load a report artifact by ID with its full Markdown content inline.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Report artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const view = await deps.store.getReport({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      const structure = await deps.store.getArtifactStructure({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      return {
        content: [...summaryHeader(view, "ARTIFACT_CONTENT"), ...structureLines(view, structure), "", view.content].join("\n"),
      }
    },
  })

  addTool({
    name: "summary",
    namespace: "report",
    description:
      "Read report metadata, linked plan, and Summary. Excludes detailed sections.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Report artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const summary = await deps.store.getReportSummary({
        artifactID: input.artifactID,
        location: deps.directory,
      })
      const lines = ["ARTIFACT_SUMMARY", ...summaryHeader(summary, "ARTIFACT_SUMMARY").slice(1)]
      lines.push(`Plan: ${summary.planArtifactID}`)
      if (summary.summary.length > 0) lines.push(`Summary: ${summary.summary}`)
      return { content: lines.join("\n") }
    },
  })
}
