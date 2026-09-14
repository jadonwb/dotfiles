// Shared artifact tools (shared-markdown-v1): artifact_publish, artifact_get and
// artifact_patch, plus the compact synthetic-delivery message builders used
// by the personal.artifacts RPC route in ./index.ts.
//
// Authorization model:
// - The acting author is always the calling session from the tool execution
//   context, never a caller-supplied destination.
// - The owner is the nearest Planner session in the server-assigned session
//   ancestry (ctx.session.get walks parentID). For a Planner caller that is
//   the caller itself; when no Planner ancestor is reachable (a standalone
//   session, such as the unrestricted test agent), the author owns its own
//   artifact. A patch must additionally match the stored owner, and the store
//   enforces owner + location equality independently.
// - Same-location operation only in this increment: every fetched session
//   must resolve to the plugin instance's location; moved owners fail
//   visibly.
//
// Runtime note: this module is plain erasable TypeScript with no package
// imports, so `node --test` (type stripping) can exercise it directly.

import { resolve as resolvePath } from "node:path"

import { StoreError } from "./store.mjs"

export const ERROR_PREFIX = "ARTIFACT_ERROR"

export const MAX_ANCESTRY_HOPS = 16

const PLANNER_AGENT = "planner"

export type ToolContext = { sessionID: string; agent: string; messageID: string; id: string }

export type SessionLike = {
  id: string
  parentID?: string
  agent?: string
  location?: { directory?: string }
}

export type SessionGetter = (input: { sessionID: string }) => Promise<unknown>

export function errorLines(code: string, message: string): string[] {
  return [ERROR_PREFIX, `${code}: ${message}`]
}

export function normalizeAgent(agent: unknown): string | null {
  if (typeof agent !== "string") return null
  const trimmed = agent.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Normalize a raw session result. The documented plugin adapter resolves to a
 * raw Session.Info; HTTP-style transports may wrap it as {data}. Both are
 * accepted explicitly; anything else is a lookup failure.
 */
export function unwrapSession(raw: unknown): SessionLike | null {
  if (raw === null || typeof raw !== "object") return null
  const candidate = raw as Record<string, unknown>
  const inner = candidate.data !== undefined ? candidate.data : candidate
  if (inner === null || typeof inner !== "object") return null
  const session = inner as Record<string, unknown>
  if (typeof session.id !== "string" || !session.id.startsWith("ses_")) return null
  return session as unknown as SessionLike
}

export type ResolvedSession = { sessionID: string; agent: string | null; parentID: string | null }

function sameLocation(location: unknown, directory: string): boolean {
  if (location === null || typeof location !== "object") return false
  const raw = (location as Record<string, unknown>).directory
  if (typeof raw !== "string" || raw.length === 0) return false
  // Logical path normalization only (no filesystem access), matching the
  // store's resolved-path convention.
  return resolvePath(raw) === resolvePath(directory)
}

/**
 * Fetch and validate one session: the returned record must carry the
 * requested ID and sit in the plugin instance's location. A missing optional
 * agent field is reported as null — it is never guessed.
 */
export async function fetchValidatedSession(deps: { getSession: SessionGetter; directory: string }, sessionID: string): Promise<ResolvedSession> {
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

export type Provenance = { ownerSessionID: string; authorSessionID: string; ownerAgent: string | null }

/**
 * Resolve the owner for a tool action by walking server-assigned ancestry: the
 * caller itself when it is a Planner, otherwise the nearest Planner ancestor.
 * When no Planner ancestor is reachable (no parent, a cycle, a lookup failure,
 * or the MAX_ANCESTRY_HOPS bound), the author owns its own artifact. The author
 * session is always validated against the plugin location.
 */
export async function resolveProvenance(deps: { getSession: SessionGetter; directory: string }, toolContext: ToolContext): Promise<Provenance> {
  const authorSessionID = toolContext.sessionID
  const author = await fetchValidatedSession(deps, authorSessionID)
  if (author.agent === PLANNER_AGENT) {
    return { ownerSessionID: author.sessionID, authorSessionID, ownerAgent: author.agent }
  }
  const visited = new Set<string>([authorSessionID])
  let session = author
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
      return { ownerSessionID: parent.sessionID, authorSessionID, ownerAgent: parent.agent }
    }
    session = parent
  }
  return { ownerSessionID: authorSessionID, authorSessionID, ownerAgent: author.agent }
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
  return `${input.action === "approval" ? "Artifact approval" : "Artifact feedback"}: ${truncate(input.title, 80)}`
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
  revision: string
  question?: string | null
  selectedText?: string | null
  selectedRange?: { start: number; end: number } | null
}): string {
  const lines: string[] = [
    `Feedback on ${input.kind} "${truncate(input.title, 120)}"`,
    `Artifact: ${input.artifactID}@${input.revision}`,
  ]
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

/**
 * Approval text is at most two lines. An implementation plan is authoritative:
 * the Planner launches ONE background Builder for the exact approved revision.
 * A non-implementation record is a freeze only and never authorizes Builder.
 */
export function artifactApprovalMessage(input: { authority: string; artifactID: string; revision: string }): string {
  if (input.authority === "implementation") {
    return [
      `Approved plan ${input.artifactID}@${input.revision} (authority: implementation).`,
      "Planner: launch ONE background Builder for that exact revision.",
    ].join("\n")
  }
  return [
    `Approved plan ${input.artifactID}@${input.revision} (authority: historical) — freeze only.`,
    "This approval does not authorize Builder.",
  ].join("\n")
}

export function artifactDeliveryMetadata(input: {
  artifactID: string
  revision: string
  requestID: string
  kind: string
  authority: string
  submission: "feedback" | "approval"
}): Record<string, string> {
  return {
    artifactID: input.artifactID,
    revision: input.revision,
    requestID: input.requestID,
    kind: input.kind,
    authority: input.authority,
    submission: input.submission,
    source: "personal.artifacts",
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export type ArtifactSummary = {
  id: string
  kind: string
  title: string
  description: string | null
  status: string
  revision: string
  path: string
  ownerSessionID: string
  authorSessionID: string | null
  createdAt: string
  updatedAt: string
  format: string
  schemaVersion: number
  authority: string
}

export type PatchResult = {
  artifactID: string
  path: string
  revision: string
  title: string
  description: string
  status: string
  kind: string
  ownerSessionID: string
  authorSessionID: string
  authority: string
  snapshot: string
}

export type ArtifactToolDeps = {
  store: {
    publishArtifact(input: {
      kind: string
      ownerSessionID: string
      authorSessionID: string
      location: string
      title: string
      description: string
      body: string
    }): Promise<PatchResult & { description: string }>
    getArtifact(input: { artifactID: string; location: string; revision?: string }): Promise<ArtifactSummary & { content: string; requestedRevision: string | null; snapshot: string }>
    patchArtifact(input: {
      artifactID: string
      location: string
      ownerSessionID: string
      authorSessionID: string
      expectedRevision: string
      replacements?: { oldText: string; newText: string }[]
      title?: string
      description?: string
    }): Promise<PatchResult>
  }
  directory: string
  getSession: SessionGetter
}

export function addArtifactTools(editor: { add: (tool: unknown) => void }, deps: ArtifactToolDeps): void {
  editor.add({
    name: "artifact_publish",
    description:
      "Publish a Markdown artifact to the shared artifact registry: kind plan (Planner), evidence (Search), or review (Review). " +
      "The body is stored verbatim behind a frontmatter header; do not add your own H1 or frontmatter. " +
      "Returns the artifact ID, revision and snapshot reference; the user reviews it in the editor.",
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["plan", "evidence", "review"], description: "Artifact kind; each kind has an allowed role." },
        title: { type: "string", minLength: 1, description: "Short human-readable title." },
        description: { type: "string", minLength: 1, description: "One-sentence description of the artifact." },
        body: { type: "string", minLength: 1, description: "The complete Markdown body, stored verbatim (no frontmatter, no auto H1)." },
      },
      required: ["kind", "title", "description", "body"],
      additionalProperties: false,
    },
    options: { permission: "artifact_publish" },
    async execute(input: { kind: string; title: string; description: string; body: string }, toolContext: ToolContext) {
      try {
        const provenance = await resolveProvenance(deps, toolContext)
        const published = await deps.store.publishArtifact({
          kind: input.kind,
          ownerSessionID: provenance.ownerSessionID,
          authorSessionID: provenance.authorSessionID,
          location: deps.directory,
          title: input.title,
          description: input.description,
          body: input.body,
        })
        return {
          content: [
            "ARTIFACT_PUBLISHED",
            `Artifact: ${published.artifactID}`,
            `Kind: ${published.kind}`,
            `Title: ${published.title}`,
            `Owner: ${published.ownerSessionID}`,
            `Author: ${published.authorSessionID}`,
            `Current markdown: ${published.path}`,
            `Revision: ${published.revision}`,
            `Snapshot: ${published.snapshot}`,
            `Status: ${published.status}`,
            `Authority: ${published.authority}`,
            "Give the user these identifiers. Update with artifact_patch using this exact revision.",
          ].join("\n"),
        }
      } catch (error) {
        return { content: formatError(error) }
      }
    },
  })

  editor.add({
    name: "artifact_get",
    description:
      "Read a shared artifact from the registry: current state by default, or an exact earlier revision when given. " +
      "Returns metadata, provenance, the immutable snapshot reference and the stored Markdown.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Artifact ID returned by artifact_publish." },
        revision: { type: "string", description: "Optional exact revision; omit for the current state." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    options: { permission: "artifact_get" },
    async execute(input: { artifactID: string; revision?: string }, toolContext: ToolContext) {
      try {
        const view = await deps.store.getArtifact({
          artifactID: input.artifactID,
          location: deps.directory,
          revision: input.revision,
        })
        return {
          content: [
            "ARTIFACT",
            `Artifact: ${view.id}`,
            `Kind: ${view.kind}`,
            `Title: ${view.title}`,
            `Status: ${view.status}`,
            `Authority: ${view.authority}`,
            `Owner: ${view.ownerSessionID}`,
            `Author: ${view.authorSessionID ?? "unrecorded (raw-markdown raw-markdown record)"}`,
            `Revision: ${view.revision}`,
            `Snapshot: ${view.snapshot}`,
            view.requestedRevision ? `Requested revision: ${view.requestedRevision}` : "Requested revision: (current)",
            "",
            "--- artifact markdown ---",
            view.content,
          ].join("\n"),
        }
      } catch (error) {
        return { content: formatError(error) }
      }
    },
  })

  editor.add({
    name: "artifact_patch",
    description:
      "Revise a shared artifact you are allowed to touch: exact old/new text replacements applied to the body only, plus optional structured title/description updates. " +
      "Requires the expected revision; matches must be unambiguous; approved plans reject patches. Kind and stored owner must match the caller.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Artifact ID returned by artifact_publish." },
        expectedRevision: { type: "string", description: "Revision the patch was prepared against." },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
          description: "Exact old/new text replacements against the body; each oldText must occur exactly once.",
        },
        title: { type: "string", description: "Optional structured title update." },
        description: { type: "string", description: "Optional structured description update." },
      },
      required: ["artifactID", "expectedRevision"],
      additionalProperties: false,
    },
    options: { permission: "artifact_patch" },
    async execute(
      input: {
        artifactID: string
        expectedRevision: string
        replacements?: { oldText: string; newText: string }[]
        title?: string
        description?: string
      },
      toolContext: ToolContext,
    ) {
      try {
        const provenance = await resolveProvenance(deps, toolContext)
        const patched = await deps.store.patchArtifact({
          artifactID: input.artifactID,
          location: deps.directory,
          ownerSessionID: provenance.ownerSessionID,
          authorSessionID: provenance.authorSessionID,
          expectedRevision: input.expectedRevision,
          replacements: input.replacements ?? [],
          title: input.title,
          description: input.description,
        })
        return {
          content: [
            "ARTIFACT_PATCHED",
            `Artifact: ${patched.artifactID}`,
            `Kind: ${patched.kind}`,
            `Title: ${patched.title}`,
            `Owner: ${patched.ownerSessionID}`,
            `Author: ${patched.authorSessionID}`,
            `Current markdown: ${patched.path}`,
            `Revision: ${patched.revision}`,
            `Snapshot: ${patched.snapshot}`,
            `Status: ${patched.status}`,
            `Authority: ${patched.authority}`,
            "Use the new revision for further patches; the user sees it on refresh.",
          ].join("\n"),
        }
      } catch (error) {
        return { content: formatError(error) }
      }
    },
  })
}
