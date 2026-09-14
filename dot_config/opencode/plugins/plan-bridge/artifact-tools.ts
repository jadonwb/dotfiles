// Shared artifact tools (artifact_publish, artifact_get, artifact_patch) plus
// the compact synthetic-delivery message builders used by the
// personal.artifacts RPC route in ./index.ts.
//
// Authorization model:
// - The owner is the nearest Planner session in the server-assigned session
//   ancestry (ctx.session.get walks parentID). For a Planner caller that is the
//   caller itself; when no Planner ancestor is reachable (a standalone session,
//   such as the unrestricted test agent), the caller owns its own artifact.
// - A patch must match the stored owner, and the store enforces owner +
//   location equality independently.
//
// Runtime note: this module is plain erasable TypeScript with no package
// imports, so `node --test` (type stripping) can exercise it directly.

import { resolve as resolvePath } from "node:path"

import { StoreError } from "./store.mjs"

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

export function artifactApprovalMessage(input: { artifactID: string }): string {
  return `approval delivered: ${input.artifactID}`
}

export function artifactDeliveryMetadata(input: {
  artifactID: string
  requestID: string
  kind: string
  submission: "feedback" | "approval"
}): Record<string, string> {
  return {
    artifactID: input.artifactID,
    requestID: input.requestID,
    kind: input.kind,
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
  description: string
  status: string
  path: string
  ownerSessionID: string
  createdAt: string
  updatedAt: string
}

export type ArtifactToolDeps = {
  store: {
    publishArtifact(input: {
      kind: string
      ownerSessionID: string
      location: string
      title: string
      description: string
      body: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
    getArtifact(input: { artifactID: string; location: string }): Promise<ArtifactSummary & { location: string; content: string }>
    patchArtifact(input: {
      artifactID: string
      location: string
      ownerSessionID: string
      replacements?: { oldText: string; newText: string }[]
      title?: string
      description?: string
    }): Promise<{ artifactID: string } & ArtifactSummary>
  }
  directory: string
  getSession: SessionGetter
}

export function addArtifactTools(editor: { add: (tool: unknown) => void }, deps: ArtifactToolDeps): void {
  editor.add({
    name: "artifact_publish",
    description:
      "Publish a Markdown artifact to the shared artifact registry: kind plan (Planner), evidence (Search), or review (Review). " +
      "The body is stored verbatim and must not include YAML frontmatter. Returns the artifact ID and the path of the read-only generated view; the user reviews it in the editor.",
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["plan", "evidence", "review"], description: "Artifact kind; each kind has an allowed role." },
        title: { type: "string", minLength: 1, description: "Short human-readable title." },
        description: { type: "string", minLength: 1, description: "One-sentence description of the artifact." },
        body: { type: "string", minLength: 1, description: "The complete Markdown body, stored verbatim; must not include YAML frontmatter." },
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
          location: deps.directory,
          title: input.title,
          description: input.description,
          body: input.body,
        })
        return {
          content: [
            "ARTIFACT_PUBLISHED",
            `Kind: ${published.kind}`,
            `Title: ${published.title}`,
            `Artifact: ${published.artifactID}`,
            `Path: ${published.path}`,
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
      "Read a shared artifact from the registry by ID. Returns the path of the read-only generated view; read that file with the read tool. " +
      "This tool does not inline the Markdown.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Artifact ID returned by artifact_publish." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    options: { permission: "artifact_get" },
    async execute(input: { artifactID: string }, toolContext: ToolContext) {
      try {
        const view = await deps.store.getArtifact({
          artifactID: input.artifactID,
          location: deps.directory,
        })
        return {
          content: ["ARTIFACT", `Path: ${view.path}`].join("\n"),
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
      "Matches must be unambiguous; approved plans reject patches. The stored owner must match the caller.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Artifact ID returned by artifact_publish." },
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
      required: ["artifactID"],
      additionalProperties: false,
    },
    options: { permission: "artifact_patch" },
    async execute(
      input: {
        artifactID: string
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
          replacements: input.replacements ?? [],
          title: input.title,
          description: input.description,
        })
        return {
          content: [
            "ARTIFACT_PATCHED",
            `Kind: ${patched.kind}`,
            `Title: ${patched.title}`,
            `Artifact: ${patched.artifactID}`,
            `Path: ${patched.path}`,
          ].join("\n"),
        }
      } catch (error) {
        return { content: formatError(error) }
      }
    },
  })
}
