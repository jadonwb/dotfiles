// Capability-specific artifact tools. Mutations are create/update/finalize per
// kind and the kind is fixed by the tool:
// - memory: memory_init, memory_update, memory_load.
// - plan: plan_create, plan_update, plan_complete, plan_finalize, plan_load.
// - evidence: evidence_create, evidence_update, evidence_finding,
//   evidence_finalize, evidence_load, evidence_summary.
// - review: review_create, review_update, review_finding, review_finalize,
//   review_load, review_summary.
//
// Summary/status readers omit artifact bodies; full loaders include them.
//
// Authorization model:
// - The owner is the nearest primary-agent session in the server-assigned session
//   ancestry (ctx.session.get walks parentID) — retained for routing, feedback,
//   and cleanup. The writer is the creating session itself and is the sole
//   mutation authority: the store rejects any session that is not the stored
//   writer, and resuming the same writer session retains write access.
// - primaryAuthor is immutable frontend metadata derived from the creating
//   agent's name/label; owner/writer/session IDs stay internal routing data.
//
// Finalize semantics: evidence/review finalization publishes the draft; plan
// finalization makes the draft ready for review. Every mutation clears
// finalization until the writer finalizes again.

import { resolve as resolvePath } from "node:path";

import {
  PLAN_PATCH_FIELDS,
  PLAN_SET_FIELDS,
  REVIEW_OUTCOMES,
  StoreError,
} from "./store.mjs";

const ERROR_PREFIX = "ARTIFACT_ERROR";

const MAX_ANCESTRY_HOPS = 16;

// Only kinds with a model-facing loader belong here. Search must never return
// an ID the model has no tool to load.
const SEARCHABLE_KINDS = Object.freeze([
  "memory",
  "session_memory",
  "plan",
  "evidence",
  "review",
]);

// The primary agent that owns a tree of worker sessions. Artifacts authored by
// a worker resolve to this owner so user feedback and session memory route back
// to the main conversation.
const PRIMARY_AGENT = "system";

export type ToolContext = {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
};

export type SessionLike = {
  id: string;
  parentID?: string;
  agent?: string;
  location?: { directory?: string };
};

export type SessionGetter = (input: { sessionID: string }) => Promise<unknown>;

function errorLines(code: string, message: string): string[] {
  return [ERROR_PREFIX, `${code}: ${message}`];
}

function normalizeAgent(agent: unknown): string | null {
  if (typeof agent !== "string") return null;
  const trimmed = agent.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Normalize a raw session result; HTTP-style transports may wrap it as {data}. */
function unwrapSession(raw: unknown): SessionLike | null {
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const inner = candidate.data !== undefined ? candidate.data : candidate;
  if (inner === null || typeof inner !== "object") return null;
  const session = inner as Record<string, unknown>;
  if (typeof session.id !== "string" || !session.id.startsWith("ses_"))
    return null;
  return session as unknown as SessionLike;
}

type ResolvedSession = {
  sessionID: string;
  agent: string | null;
  parentID: string | null;
};

function sameLocation(location: unknown, directory: string): boolean {
  if (location === null || typeof location !== "object") return false;
  const raw = (location as Record<string, unknown>).directory;
  if (typeof raw !== "string" || raw.length === 0) return false;
  return resolvePath(raw) === resolvePath(directory);
}

/**
 * Fetch and validate one session: the returned record must carry the requested
 * ID and sit in the plugin instance's location.
 */
async function fetchValidatedSession(
  deps: { getSession: SessionGetter; directory: string },
  sessionID: string,
): Promise<ResolvedSession> {
  let raw: unknown;
  try {
    raw = await deps.getSession({ sessionID });
  } catch (error) {
    throw new Error(
      `owner_unresolved: session lookup failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const session = unwrapSession(raw);
  if (!session || session.id !== sessionID) {
    throw new Error(
      `owner_unresolved: session lookup returned no verifiable session for ${sessionID}`,
    );
  }
  if (!sameLocation(session.location, deps.directory)) {
    throw new Error(
      `owner_unresolved: session ${sessionID} is not active in this location; same-location ownership only`,
    );
  }
  return {
    sessionID: session.id,
    agent: normalizeAgent(session.agent),
    parentID:
      typeof session.parentID === "string" &&
      session.parentID.startsWith("ses_")
        ? session.parentID
        : null,
  };
}

export type Provenance = { ownerSessionID: string };

/**
 * Resolve the owner for a tool action by walking server-assigned ancestry: the
 * caller itself when it is the primary agent, otherwise the nearest primary-agent
 * ancestor. When none is reachable the caller owns its own artifact.
 */
export async function resolveProvenance(
  deps: { getSession: SessionGetter; directory: string },
  toolContext: ToolContext,
): Promise<Provenance> {
  const callerSessionID = toolContext.sessionID;
  const caller = await fetchValidatedSession(deps, callerSessionID);
  if (caller.agent === PRIMARY_AGENT) {
    return { ownerSessionID: caller.sessionID };
  }
  const visited = new Set<string>([callerSessionID]);
  let session = caller;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && session.parentID; hop += 1) {
    const parentID = session.parentID;
    if (visited.has(parentID)) break;
    visited.add(parentID);
    let parent: ResolvedSession;
    try {
      parent = await fetchValidatedSession(deps, parentID);
    } catch {
      break;
    }
    if (parent.agent === PRIMARY_AGENT) {
      return { ownerSessionID: parent.sessionID };
    }
    session = parent;
  }
  return { ownerSessionID: callerSessionID };
}

/**
 * Resolve the writer for a content mutation: the validated calling session.
 * The store compares this against the immutable writerSessionID recorded at
 * creation, so the primary agent and sibling workers are rejected unless they are the
 * writer (resuming the same worker session retains access).
 */
async function resolveWriter(
  deps: { getSession: SessionGetter; directory: string },
  toolContext: ToolContext,
): Promise<string> {
  try {
    const caller = await fetchValidatedSession(deps, toolContext.sessionID);
    return caller.sessionID;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `writer_unresolved: caller session ${toolContext.sessionID} cannot be validated: ${detail}`,
    );
  }
}

/**
 * Immutable frontend author metadata derived from the creating agent's name.
 * Never a session ID: owner/writer/session identities remain internal routing
 * data and must not reach frontmatter or model-facing provenance.
 */
export function primaryAuthorOf(agent: unknown): string {
  const normalized = normalizeAgent(agent);
  if (!normalized || normalized === "general") return "Author";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatError(error: unknown): string {
  return errorLines(
    error instanceof StoreError ? error.code : "internal",
    error instanceof Error ? error.message : String(error),
  ).join("\n");
}

// ---------------------------------------------------------------------------
// Compact synthetic-delivery message builders (model sees text; metadata is
// bookkeeping only; description is the short UI label rendered after the
// synthetic event marker).
// ---------------------------------------------------------------------------

function truncate(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength
    ? collapsed
    : collapsed.slice(0, maxLength - 1) + "…";
}

export function artifactDeliveryDescription(input: {
  action: "feedback" | "approval";
  title: string;
}): string {
  return `${input.action === "approval" ? "Approval" : "Feedback"}: ${truncate(input.title, 80)}`;
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function artifactFeedbackMessage(input: {
  kind: string;
  title: string;
  artifactID: string;
  question?: string | null;
  selectedText?: string | null;
  selectedRange?: { start: number; end: number } | null;
}): string {
  const lines: string[] = [
    `Feedback on ${input.kind} "${truncate(input.title, 120)}"`,
    `Artifact: ${input.artifactID}`,
  ];
  if (input.question && input.question.trim().length > 0) {
    lines.push("", `User question: ${input.question.trim()}`);
  }
  // Exactly one context representation: the quoted excerpt when present,
  // otherwise the selected line range, otherwise nothing (general feedback).
  if (input.selectedText && input.selectedText.length > 0) {
    lines.push(
      "",
      "> --- begin user selection ---",
      quoteBlock(input.selectedText),
      "> --- end user selection ---",
    );
  } else if (input.selectedRange) {
    lines.push(
      "",
      `Context: the user selected lines ${input.selectedRange.start}-${input.selectedRange.end}; no excerpt is quoted.`,
    );
  }
  return lines.join("\n");
}

export function artifactApprovalMessage(input: {
  artifactID: string;
  kind: string;
  status: string;
  finalized: boolean;
}): string {
  return `approval delivered: ${input.artifactID} (kind=${input.kind} status=${input.status} finalized=${input.finalized})`;
}

export function artifactDeliveryMetadata(input: {
  artifactID: string;
  requestID: string;
  kind: string;
  submission: "feedback" | "approval";
  recipient?: "owner" | "writer";
}): Record<string, string> {
  const metadata: Record<string, string> = {
    artifactID: input.artifactID,
    requestID: input.requestID,
    kind: input.kind,
    submission: input.submission,
    recipient: input.recipient ?? "owner",
    source: "personal.artifacts",
  };
  return metadata;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export type ArtifactSummary = {
  id: string;
  kind: string;
  title: string;
  description: string;
  primaryAuthor: string;
  status: string;
  path: string;
  ownerSessionID: string;
  writerSessionID: string;
  finalized: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactView = ArtifactSummary & {
  location: string;
  content: string;
};

/** One structured `## ` section of project memory or a session memory. */
export type MemorySection = {
  title: string;
  content: string;
};

export type MemoryView = ArtifactView & {
  sections: MemorySection[];
  preamble: string;
};

export type ArtifactStructure = {
  evidence?: string[];
  findings?: { id: string; title: string }[];
  outcome?: string | null;
  previousPlanID?: string | null;
  completedAt?: string | null;
};

export type ArtifactToolDeps = {
  store: {
    createArtifact(input: {
      kind: string;
      ownerSessionID: string;
      writerSessionID: string;
      primaryAuthor: string;
      location: string;
      title: string;
      description: string;
      workingDirectory?: string;
      previousPlanID?: string | null;
      initial?: Record<string, unknown>;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    memoryPut(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      content: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    memoryAppend(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      content: string;
      section?: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    memoryPatch(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      oldText: string;
      newText: string;
      section?: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    planFieldSet(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      field: string;
      content: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    planFieldPatch(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      field: string;
      oldText: string;
      newText: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    planEvidenceAddMany(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      evidenceIDs: string[];
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    planEvidenceRemove(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      evidenceID: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    planUpdate(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      fields: Record<string, string>;
      evidenceIDs?: string[];
      patch?: { field: string; oldText: string; newText: string };
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    planComplete(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      summary: string;
      changed?: string;
      verification?: string;
      unfinished?: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    planFinalize(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    evidenceOverviewPut(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      question?: string | null;
      summary?: string;
      limitations?: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    evidenceFindingPut(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      findingID?: string;
      title: string;
      content: string;
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>;
    evidenceFindingRemove(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      findingID: string;
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>;
    evidenceFinalize(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      question?: string | null;
      summary?: string;
      limitations?: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    reviewOutcomePut(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      outcome: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    reviewSummaryPut(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      content: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    reviewUpdate(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      outcome?: string;
      summary?: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    reviewFindingPut(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      findingID?: string;
      title: string;
      severity: string;
      affected?: string;
      evidence?: string;
      risk?: string;
      correction: string;
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>;
    reviewFindingRemove(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      findingID: string;
    }): Promise<{ artifactID: string; findingID: string } & ArtifactSummary>;
    reviewFinalize(input: {
      artifactID: string;
      location: string;
      writerSessionID: string;
      outcome?: string;
      summary?: string;
    }): Promise<{ artifactID: string } & ArtifactSummary>;
    getArtifact(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactView>;
    getArtifactMetadata(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactSummary>;
    getArtifactStructure(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactStructure>;
    getPlan(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactView>;
    getMemory(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactView>;
    getMemorySummary(input: {
      artifactID: string;
      location: string;
    }): Promise<
      ArtifactSummary & {
        content: string;
        sections: MemorySection[];
        preamble: string;
      }
    >;
    getMemorySection(input: {
      artifactID: string;
      location: string;
      section: string;
    }): Promise<ArtifactSummary & { section: MemorySection }>;
    findProjectMemory(input: {
      location: string;
    }): Promise<MemoryView | null>;
    findSessionMemoryForSession(input: {
      sessionID: string;
      location: string;
    }): Promise<MemoryView | null>;
    artifactSearch(input: {
      location: string;
      query: string;
      kinds?: string[];
      limit?: number;
    }): Promise<{
      results: Array<{
        id: string;
        kind: string;
        title: string;
        status: string;
        updatedAt: string;
        matches: Array<{ line: number; text: string }>;
      }>;
    }>;
    getEvidence(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactView>;
    getReview(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactView>;
    getEvidenceSummary(input: {
      artifactID: string;
      location: string;
    }): Promise<
      ArtifactSummary & {
        question: string | null;
        summary: string;
        limitations: string;
      }
    >;
    getReviewSummary(input: {
      artifactID: string;
      location: string;
    }): Promise<ArtifactSummary & { outcome: string | null; summary: string }>;
  };
  /** Session/registry location (plans, evidence, session memory documents). */
  directory: string;
  /** Project root that owns shared project memory (git common checkout). */
  projectDirectory: string;
  getSession: SessionGetter;
};

/**
 * Memory artifacts live at the project root and session memory documents at the session
 * directory, so a mutation addressed by ID must find which scope owns it while
 * keeping the store's location scoping.
 */
async function memoryLocationFor(
  deps: {
    store: {
      getMemorySummary: (input: {
        artifactID: string;
        location: string;
      }) => Promise<unknown>;
    };
    directory: string;
    projectDirectory: string;
  },
  artifactID: string,
): Promise<string> {
  const candidates = [...new Set([deps.projectDirectory, deps.directory])];
  for (const location of candidates) {
    try {
      await deps.store.getMemorySummary({ artifactID, location });
      return location;
    } catch (error) {
      // An artifact that exists at a scope but has the wrong kind is a real
      // error, not a reason to try the other scope.
      if (error instanceof StoreError && error.code === "invalid_kind") {
        throw error;
      }
    }
  }
  throw new StoreError(
    "not_found",
    `No memory or session memory artifact ${artifactID} in this project`,
  );
}

function finalizedLabel(finalized: boolean): string {
  return finalized ? "true" : "false";
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
  ];
}

function structureLines(
  summary: ArtifactSummary,
  structure: ArtifactStructure,
): string[] {
  if (summary.kind === "plan") {
    const lines: string[] = [];
    if (structure.previousPlanID) {
      lines.push(`Previous plan: ${structure.previousPlanID}`);
    }
    if (structure.completedAt) {
      lines.push(`Completed: ${structure.completedAt}`);
    }
    if (structure.evidence) {
      lines.push(
        structure.evidence.length === 0
          ? "Evidence: none"
          : `Evidence: ${structure.evidence.join(", ")}`,
      );
    }
    return lines;
  }
  if (summary.kind === "evidence" && structure.findings) {
    if (structure.findings.length === 0) return ["Findings: none"];
    return [
      `Findings: ${structure.findings.map((finding) => finding.id).join(", ")}`,
    ];
  }
  if (summary.kind === "review") {
    const lines: string[] = [`Outcome: ${structure.outcome ?? "unset"}`];
    if (structure.findings && structure.findings.length > 0) {
      lines.push(
        `Findings: ${structure.findings.map((finding) => finding.id).join(", ")}`,
      );
    }
    return lines;
  }
  return [];
}

export function addArtifactTools(
  editor: {
    namespace: (namespace: { name: string; description: string }) => void;
    add: (tool: unknown) => void;
  },
  deps: ArtifactToolDeps,
): void {
  editor.namespace({
    name: "artifact",
    description:
      "Searches artifact text in this project to discover memories and evidence without IDs.",
  });
  editor.namespace({
    name: "memory",
    description:
      "Maintains project memory and session memory as live documents.",
  });
  editor.namespace({
    name: "plan",
    description:
      "Creates, modifies, finalizes, and reads plan artifacts. Plans are optional working documents; implementation waits for approval only when the user asked for a plan.",
  });
  editor.namespace({
    name: "evidence",
    description: "Creates, modifies, finalizes, and reads evidence artifacts.",
  });
  editor.namespace({
    name: "review",
    description: "Creates, modifies, finalizes, and reads review artifacts.",
  });

  type ToolDef = {
    name: string;
    namespace: string;
    description: string;
    input: Record<string, unknown>;
    handler: (
      input: any,
      toolContext: ToolContext,
    ) => Promise<{ content: string }>;
  };

  function addTool(tool: ToolDef): void {
    const effectiveName = `${tool.namespace}_${tool.name}`;
    editor.add({
      name: tool.name,
      description: tool.description,
      input: tool.input,
      options: {
        namespace: tool.namespace,
        codemode: true,
        permission: effectiveName,
      },
      async execute(input: any, toolContext: ToolContext) {
        try {
          return await tool.handler(input, toolContext);
        } catch (error) {
          return { content: formatError(error) };
        }
      },
    });
  }

  /** Finalize returns the bare artifact ID/status contract: `art_… published` or `art_… finalized`. */
  function bareFinalize(summary: {
    artifactID: string;
    status: string;
  }): string {
    return `${summary.artifactID} ${summary.status === "published" ? "published" : "finalized"}`;
  }

  // -------------------------------------------------------------------------
  // Memory tools (namespace "memory")
  //
  // Two live documents, both always published and injected into later requests:
  // project memory (one per project, lasting knowledge shared by sessions) and
  // session memory (small running state for this session). Tools work
  // incrementally so the agent records a finding, continues working, and
  // appends the next section instead of writing once at the end.
  // -------------------------------------------------------------------------

  addTool({
    name: "init",
    namespace: "memory",
    description:
      "Get or create a memory document and return its bare artifact ID. scope=project is lasting project knowledge shared by every session; scope=session is this session's exact record — important requirements, decisions, facts, and artifact references that must survive compaction. This does not read the document: use memory_load. content is used only when creating; each memory is a `## ` section titled by what it records.",
    input: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["project", "session"],
          description:
            "project (default) for lasting project knowledge; session for this session's exact record: requirements, decisions, facts, and references.",
        },
        title: {
          type: "string",
          description: "Optional title used only when creating the document.",
        },
        description: {
          type: "string",
          description:
            "Optional one-line description used only when creating the document.",
        },
        content: {
          type: "string",
          description:
            "Optional initial Markdown body used only when creating the document.",
        },
      },
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext);
      const writer = await resolveWriter(deps, toolContext);
      const scope = input.scope === "session" ? "session" : "project";
      const existing =
        scope === "session"
          ? await deps.store.findSessionMemoryForSession({
              sessionID: provenance.ownerSessionID,
              location: deps.directory,
            })
          : await deps.store.findProjectMemory({
              location: deps.projectDirectory,
            });
      if (existing) return { content: existing.id };
      const created = await deps.store.createArtifact({
        kind: scope === "session" ? "session_memory" : "memory",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: scope === "session" ? deps.directory : deps.projectDirectory,
        title:
          typeof input.title === "string" && input.title.trim().length > 0
            ? input.title
            : scope === "session"
              ? "Session memory"
              : "Project memory",
        description:
          typeof input.description === "string" &&
          input.description.trim().length > 0
            ? input.description
            : scope === "session"
              ? "Recorded exact memories for this session."
              : "Lasting recorded memories: decisions, pitfalls, and findings.",
        initial: { content: input.content },
      });
      return { content: created.artifactID };
    },
  });

  addTool({
    name: "update",
    namespace: "memory",
    description:
      "Mutate project memory or session memory. mode=append adds a `## ` section or appends to an existing section title; mode=patch replaces one exact oldText with newText (empty newText deletes) in the document or in a named section; mode=replace replaces the whole document when consolidating. Returns the artifact ID.",
    input: {
      type: "object",
      properties: {
        artifactID: {
          type: "string",
          description: "Memory or session memory artifact ID.",
        },
        mode: {
          type: "string",
          enum: ["append", "patch", "replace"],
          description:
            "append adds content; patch replaces one exact oldText; replace replaces the whole document.",
        },
        content: {
          type: "string",
          description:
            "Markdown body for append or replace. Ignored for patch.",
        },
        oldText: {
          type: "string",
          description: "Exact text to replace; required for patch.",
        },
        newText: {
          type: "string",
          description:
            "Replacement text for patch; empty deletes the matched text.",
        },
        section: {
          type: "string",
          description:
            "Optional unique section title from the injected index. For append, target that section (content must not contain `## ` headings). For patch, search only that section. Not used by replace.",
        },
      },
      required: ["artifactID", "mode"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const location = await memoryLocationFor(deps, input.artifactID);
      if (input.mode === "append") {
        if (typeof input.content !== "string" || input.content.length === 0) {
          throw new StoreError(
            "validation",
            "append requires a non-empty content string",
          );
        }
        const appended = await deps.store.memoryAppend({
          artifactID: input.artifactID,
          location,
          writerSessionID: writer,
          content: input.content,
          section:
            typeof input.section === "string" ? input.section : undefined,
        });
        return { content: appended.artifactID };
      }
      if (input.mode === "patch") {
        if (
          typeof input.oldText !== "string" ||
          typeof input.newText !== "string"
        ) {
          throw new StoreError(
            "validation",
            "patch requires oldText and newText strings",
          );
        }
        const patched = await deps.store.memoryPatch({
          artifactID: input.artifactID,
          location,
          writerSessionID: writer,
          oldText: input.oldText,
          newText: input.newText,
          section:
            typeof input.section === "string" ? input.section : undefined,
        });
        return { content: patched.artifactID };
      }
      if (input.mode === "replace") {
        if (typeof input.section === "string") {
          throw new StoreError(
            "validation",
            "replace does not target a section; omit section",
          );
        }
        if (typeof input.content !== "string") {
          throw new StoreError(
            "validation",
            "replace requires a content string",
          );
        }
        const put = await deps.store.memoryPut({
          artifactID: input.artifactID,
          location,
          writerSessionID: writer,
          content: input.content,
        });
        return { content: put.artifactID };
      }
      throw new StoreError(
        "validation",
        "mode must be append, patch, or replace",
      );
    },
  });

  addTool({
    name: "load",
    namespace: "memory",
    description:
      "Load project memory (or session memory by ID). Omit section for the full document plus its section titles; pass a section title from the injected index to load just that section. Omit artifactID for project memory.",
    input: {
      type: "object",
      properties: {
        artifactID: {
          type: "string",
          description:
            "Optional project or session memory artifact ID; omitted resolves this project's memory.",
        },
        section: {
          type: "string",
          description:
            "Optional unique section title from the injected index; loads only that section.",
        },
      },
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      let artifactID =
        typeof input.artifactID === "string" && input.artifactID.length > 0
          ? input.artifactID
          : undefined;
      if (!artifactID) {
        const existing = await deps.store.findProjectMemory({
          location: deps.projectDirectory,
        });
        if (!existing) {
          throw new StoreError(
            "not_found",
            "No project memory exists yet; call memory_init first",
          );
        }
        artifactID = existing.id;
      }
      const location = await memoryLocationFor(deps, artifactID);
      if (typeof input.section === "string") {
        const result = await deps.store.getMemorySection({
          artifactID,
          location,
          section: input.section,
        });
        return {
          content: [
            "ARTIFACT_SECTION",
            `Kind: ${result.kind}`,
            `Status: ${result.status}`,
            `Title: ${result.title}`,
            `Artifact: ${result.id}`,
            `Section: ${result.section.title}`,
            "",
            result.section.content,
          ].join("\n"),
        };
      }
      const summary = await deps.store.getMemorySummary({
        artifactID,
        location,
      });
      const sectionList = summary.sections
        .map((section) => section.title)
        .join(", ");
      return {
        content: [
          "ARTIFACT_CONTENT",
          `Kind: ${summary.kind}`,
          `Status: ${summary.status}`,
          `Title: ${summary.title}`,
          `Artifact: ${summary.id}`,
          sectionList.length > 0 ? `Sections: ${sectionList}` : null,
          "",
          summary.content,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      };
    },
  });

  addTool({
    name: "search",
    namespace: "artifact",
    description:
      "Search artifact text in this session's directory and shared project memory (memory, session_memory, evidence, plans, reviews) and return matching IDs with line snippets. Use to discover relevant memories and evidence without knowing IDs.",
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words to find; case-insensitive, and all words must occur in the document.",
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional kind filter: memory, session_memory, plan, evidence, review.",
        },
        limit: {
          type: "number",
          description: "Maximum results (default 10, maximum 25).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(input) {
      const limit = Math.min(Number(input.limit) || 10, 25);
      const requestedKinds =
        Array.isArray(input.kinds) && input.kinds.length > 0
          ? input.kinds.filter((kind) => SEARCHABLE_KINDS.includes(kind))
          : [];
      const allKinds =
        requestedKinds.length > 0 ? requestedKinds : [...SEARCHABLE_KINDS];
      // Session artifacts are stored at the session directory and project
      // memory at the project root. Query each at its own scope so every hit
      // is loadable without a location mismatch.
      const scopes: Array<{ location: string; kinds?: string[] }> = [
        { location: deps.directory, kinds: allKinds },
      ];
      if (deps.projectDirectory !== deps.directory) {
        const memoryKinds = allKinds.filter((kind) => kind === "memory");
        if (memoryKinds.length > 0) {
          scopes.push({
            location: deps.projectDirectory,
            kinds: memoryKinds,
          });
        }
      }

      type SearchResult = {
        id: string;
        kind: string;
        title: string;
        status: string;
        updatedAt: string;
        matches: Array<{ line: number; text: string }>;
      };
      const seen = new Map<string, SearchResult>();
      for (const scope of scopes) {
        const found = await deps.store.artifactSearch({
          location: scope.location,
          query: input.query,
          kinds: scope.kinds,
          limit,
        });
        for (const result of found.results) {
          if (!seen.has(result.id)) seen.set(result.id, result);
        }
      }
      const results = [...seen.values()]
        .sort((a, b) =>
          a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
        )
        .slice(0, limit);

      const lines = ["ARTIFACT_SEARCH"];
      if (results.length === 0) {
        lines.push("(no matches)");
        return { content: lines.join("\n") };
      }
      for (const result of results) {
        lines.push(
          `${result.id} [${result.kind}] ${result.title} (${result.status})`,
        );
        for (const match of result.matches) {
          lines.push(`  ${match.line}: ${match.text}`);
        }
      }
      return { content: lines.join("\n") };
    },
  });

  addTool({
    name: "create",
    namespace: "plan",
    description:
      "Create a plan draft with optional initial fields, then update it as scope changes. Returns its ID.",
    input: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Short plan title (immutable).",
        },
        description: {
          type: "string",
          minLength: 1,
          description: "One-sentence plan description (immutable).",
        },
        workingDirectory: {
          type: "string",
          minLength: 1,
          description: "Absolute working directory.",
        },
        goalScope: {
          type: "string",
          description: "Optional initial Goal/Scope Markdown.",
        },
        intendedChanges: {
          type: "string",
          description:
            "Optional initial Intended Changes and Behaviors Markdown.",
        },
        context: {
          type: "string",
          description: "Optional initial Context Markdown.",
        },
        checks: {
          type: "string",
          description: "Optional initial Checks Markdown.",
        },
        previousPlanID: {
          type: "string",
          description:
            "Optional completed plan ID this plan continues or supersedes.",
        },
      },
      required: ["title", "description", "workingDirectory"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext);
      const writer = await resolveWriter(deps, toolContext);
      const created = await deps.store.createArtifact({
        kind: "plan",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: deps.directory,
        title: input.title,
        description: input.description,
        workingDirectory: input.workingDirectory,
        previousPlanID: input.previousPlanID,
        initial: {
          goalScope: input.goalScope,
          intendedChanges: input.intendedChanges,
          context: input.context,
          checks: input.checks,
        },
      });
      return { content: created.artifactID };
    },
  });

  addTool({
    name: "update",
    namespace: "plan",
    description:
      "Replace any subset of plan fields, optionally patch one exact occurrence in intendedChanges or context, and optionally replace the ordered evidence membership. Validates everything before one atomic write. Returns the plan ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
        goalScope: {
          type: "string",
          description: "Whole-field Goal/Scope Markdown.",
        },
        intendedChanges: {
          type: "string",
          description: "Whole-field Intended Changes and Behaviors Markdown.",
        },
        context: {
          type: "string",
          description: "Whole-field Context Markdown.",
        },
        checks: {
          type: "string",
          description: "Whole-field Checks Markdown; empty clears.",
        },
        evidenceIDs: {
          type: "array",
          items: {
            type: "string",
            description: "Evidence artifact ID (art_…).",
          },
          description:
            "Ordered evidence membership; replaces the current list, and an empty array clears it.",
        },
        patch: {
          type: "object",
          properties: {
            field: { type: "string", enum: [...PLAN_PATCH_FIELDS] },
            oldText: {
              type: "string",
              description:
                "Exact current text to replace; must occur exactly once.",
            },
            newText: {
              type: "string",
              description:
                "Replacement text; empty deletes the matched text.",
            },
          },
          required: ["field", "oldText", "newText"],
          additionalProperties: false,
          description:
            "Optional targeted edit. Cannot address a field also set wholesale in the same call.",
        },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const fields: Record<string, string> = {};
      for (const field of PLAN_SET_FIELDS) {
        if (input[field] !== undefined) fields[field] = input[field];
      }
      const updated = await deps.store.planUpdate({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        fields,
        evidenceIDs: input.evidenceIDs,
        patch: input.patch,
      });
      return { content: updated.artifactID };
    },
  });

  addTool({
    name: "complete",
    namespace: "plan",
    description:
      "Record the plan's completion report and freeze the plan. Requires an outcome summary; changed, verification, and unfinished are optional. The plan keeps its status and approval. Returns `art_… completed`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
        summary: {
          type: "string",
          minLength: 1,
          description: "Outcome summary for the completed work.",
        },
        changed: {
          type: "string",
          description: "What actually changed.",
        },
        verification: {
          type: "string",
          description: "Checks actually run.",
        },
        unfinished: {
          type: "string",
          description: "Remaining work, or 'None'.",
        },
      },
      required: ["artifactID", "summary"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const completed = await deps.store.planComplete({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        summary: input.summary,
        changed: input.changed,
        verification: input.verification,
        unfinished: input.unfinished,
      });
      return { content: `${completed.artifactID} completed` };
    },
  });

  addTool({
    name: "finalize",
    namespace: "plan",
    description:
      "Finalize a plan draft: requires non-empty goalScope and intendedChanges; checks, context and evidence are optional. The plan becomes ready for review; implementation waits for approval only when the user asked for a plan. Returns `art_… finalized`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const finalized = await deps.store.planFinalize({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
      });
      return { content: bareFinalize(finalized) };
    },
  });

  addTool({
    name: "load",
    namespace: "plan",
    description:
      "Load any plan by ID with its full Markdown content inline, regardless of draft, finalized, or reviewed status. Rejects non-plans with invalid_kind.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Plan artifact ID." },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const view = await deps.store.getPlan({
        artifactID: input.artifactID,
        location: deps.directory,
      });
      const structure = await deps.store.getArtifactStructure({
        artifactID: input.artifactID,
        location: deps.directory,
      });
      return {
        content: [
          ...summaryHeader(view, "ARTIFACT_CONTENT"),
          ...structureLines(view, structure),
          "",
          view.content,
        ].join("\n"),
      };
    },
  });

  // -------------------------------------------------------------------------
  // Evidence tools (namespace "evidence")
  // -------------------------------------------------------------------------

  addTool({
    name: "create",
    namespace: "evidence",
    description:
      "Create an evidence draft, optionally with its question/Summary/Limitations, then add findings as you confirm them. Returns its ID.",
    input: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Short immutable evidence title.",
        },
        description: {
          type: "string",
          minLength: 1,
          description: "One-sentence evidence description (immutable).",
        },
        question: {
          type: ["string", "null"],
          description: "Optional main question/topic.",
        },
        summary: { type: "string", description: "Optional initial Summary." },
        limitations: {
          type: "string",
          description: "Optional initial Limitations.",
        },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext);
      const writer = await resolveWriter(deps, toolContext);
      const created = await deps.store.createArtifact({
        kind: "evidence",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: deps.directory,
        title: input.title,
        description: input.description,
        initial: {
          question: input.question,
          summary: input.summary,
          limitations: input.limitations,
        },
      });
      return { content: created.artifactID };
    },
  });

  addTool({
    name: "update",
    namespace: "evidence",
    description:
      "Set the overview fields in one call: question, Summary, Limitations. Each provided field replaces the stored field; omitted fields stay untouched; pass question=null to clear it. At least one field is required. Returns its ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
        question: {
          type: ["string", "null"],
          description: "Main question/topic.",
        },
        summary: { type: "string", description: "Summary prose." },
        limitations: {
          type: "string",
          description: "Limitations or Issues prose.",
        },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const put = await deps.store.evidenceOverviewPut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        question: input.question,
        summary: input.summary,
        limitations: input.limitations,
      });
      return { content: put.artifactID };
    },
  });

  addTool({
    name: "finding",
    namespace: "evidence",
    description:
      "Append a finding (no findingID), replace one in place (findingID with title/content), or remove one (findingID with remove=true). Returns the finding ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
        findingID: {
          type: "string",
          description:
            "Omit to append; supply an existing finding ID to replace or remove that finding.",
        },
        title: {
          type: "string",
          minLength: 1,
          description: "Descriptive finding title.",
        },
        content: {
          type: "string",
          minLength: 1,
          description: "Self-contained Markdown finding content.",
        },
        remove: {
          type: "boolean",
          description:
            "Remove the finding addressed by findingID instead of writing it.",
        },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      if (input.remove === true) {
        if (typeof input.findingID !== "string") {
          throw new StoreError(
            "validation",
            "remove requires findingID",
          );
        }
        if (input.title !== undefined || input.content !== undefined) {
          throw new StoreError(
            "validation",
            "remove cannot be combined with title or content",
          );
        }
        const removed = await deps.store.evidenceFindingRemove({
          artifactID: input.artifactID,
          location: deps.directory,
          writerSessionID: writer,
          findingID: input.findingID,
        });
        return { content: removed.findingID };
      }
      if (typeof input.title !== "string" || typeof input.content !== "string") {
        throw new StoreError(
          "validation",
          "title and content are required unless remove=true",
        );
      }
      const put = await deps.store.evidenceFindingPut({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        findingID: input.findingID,
        title: input.title,
        content: input.content,
      });
      return { content: put.findingID };
    },
  });

  addTool({
    name: "finalize",
    namespace: "evidence",
    description:
      "Finalize evidence: optionally set question/Summary/Limitations in the same call, then publish. Requires a Summary, Limitations, or at least one finding. Returns `art_… published`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Evidence artifact ID." },
        question: {
          type: ["string", "null"],
          description: "Optional final question/topic.",
        },
        summary: { type: "string", description: "Optional final Summary." },
        limitations: {
          type: "string",
          description: "Optional final Limitations.",
        },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const finalized = await deps.store.evidenceFinalize({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        question: input.question,
        summary: input.summary,
        limitations: input.limitations,
      });
      return { content: bareFinalize(finalized) };
    },
  });

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
      });
      const structure = await deps.store.getArtifactStructure({
        artifactID: input.artifactID,
        location: deps.directory,
      });
      return {
        content: [
          ...summaryHeader(view, "ARTIFACT_CONTENT"),
          ...structureLines(view, structure),
          "",
          view.content,
        ].join("\n"),
      };
    },
  });

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
      });
      const lines = [
        "ARTIFACT_SUMMARY",
        ...summaryHeader(summary, "ARTIFACT_SUMMARY").slice(1),
      ];
      if (summary.question) lines.push(`Question: ${summary.question}`);
      if (summary.summary.length > 0) lines.push(`Summary: ${summary.summary}`);
      if (summary.limitations.length > 0)
        lines.push(`Limitations: ${summary.limitations}`);
      return { content: lines.join("\n") };
    },
  });

  // -------------------------------------------------------------------------
  // Review tools (namespace "review")
  // -------------------------------------------------------------------------

  addTool({
    name: "create",
    namespace: "review",
    description:
      "Create a review draft, optionally with its outcome and Summary, then add findings as you inspect. Returns its ID.",
    input: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Short review title (immutable).",
        },
        description: {
          type: "string",
          minLength: 1,
          description: "One-sentence review description (immutable).",
        },
        outcome: {
          type: "string",
          enum: [...REVIEW_OUTCOMES],
          description: "Optional initial outcome.",
        },
        summary: {
          type: "string",
          description: "Optional initial human Summary.",
        },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const provenance = await resolveProvenance(deps, toolContext);
      const writer = await resolveWriter(deps, toolContext);
      const created = await deps.store.createArtifact({
        kind: "review",
        ownerSessionID: provenance.ownerSessionID,
        writerSessionID: writer,
        primaryAuthor: primaryAuthorOf(toolContext.agent),
        location: deps.directory,
        title: input.title,
        description: input.description,
        initial: { outcome: input.outcome, summary: input.summary },
      });
      return { content: created.artifactID };
    },
  });

  addTool({
    name: "update",
    namespace: "review",
    description:
      "Set the machine-readable outcome and/or the human Summary in one call. Omitted fields stay untouched. Returns the review ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
        outcome: {
          type: "string",
          enum: [...REVIEW_OUTCOMES],
          description: "Machine-readable review outcome.",
        },
        summary: {
          type: "string",
          minLength: 1,
          description: "Human Summary Markdown.",
        },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const updated = await deps.store.reviewUpdate({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        outcome: input.outcome,
        summary: input.summary,
      });
      return { content: updated.artifactID };
    },
  });

  addTool({
    name: "finding",
    namespace: "review",
    description:
      "Append a finding (no findingID), replace one in place (findingID with the write fields), or remove one (findingID with remove=true). Returns the finding ID.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
        findingID: {
          type: "string",
          description:
            "Omit to append; supply an existing finding ID to replace or remove that finding.",
        },
        title: {
          type: "string",
          minLength: 1,
          description: "Descriptive finding title.",
        },
        severity: {
          type: "string",
          minLength: 1,
          description: "Severity label (e.g. high, medium, low, blocked).",
        },
        affected: { type: "string", description: "Affected path/symbol." },
        evidence: {
          type: "string",
          description: "Supporting evidence for the finding.",
        },
        risk: {
          type: "string",
          description: "Behavioral risk of not correcting it.",
        },
        correction: {
          type: "string",
          minLength: 1,
          description: "Required correction.",
        },
        remove: {
          type: "boolean",
          description:
            "Remove the finding addressed by findingID instead of writing it.",
        },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      if (input.remove === true) {
        if (typeof input.findingID !== "string") {
          throw new StoreError(
            "validation",
            "remove requires findingID",
          );
        }
        if (
          input.title !== undefined ||
          input.severity !== undefined ||
          input.affected !== undefined ||
          input.evidence !== undefined ||
          input.risk !== undefined ||
          input.correction !== undefined
        ) {
          throw new StoreError(
            "validation",
            "remove cannot be combined with review finding fields",
          );
        }
        const removed = await deps.store.reviewFindingRemove({
          artifactID: input.artifactID,
          location: deps.directory,
          writerSessionID: writer,
          findingID: input.findingID,
        });
        return { content: removed.findingID };
      }
      if (
        typeof input.title !== "string" ||
        typeof input.severity !== "string" ||
        typeof input.correction !== "string"
      ) {
        throw new StoreError(
          "validation",
          "title, severity, and correction are required unless remove=true",
        );
      }
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
      });
      return { content: put.findingID };
    },
  });

  addTool({
    name: "finalize",
    namespace: "review",
    description:
      "Finalize a review: optionally set the outcome and human Summary in the same call, then publish. Requires both. Returns `art_… published`.",
    input: {
      type: "object",
      properties: {
        artifactID: { type: "string", description: "Review artifact ID." },
        outcome: {
          type: "string",
          enum: [...REVIEW_OUTCOMES],
          description: "Optional final outcome.",
        },
        summary: {
          type: "string",
          description: "Optional final human Summary.",
        },
      },
      required: ["artifactID"],
      additionalProperties: false,
    },
    async handler(input, toolContext) {
      const writer = await resolveWriter(deps, toolContext);
      const finalized = await deps.store.reviewFinalize({
        artifactID: input.artifactID,
        location: deps.directory,
        writerSessionID: writer,
        outcome: input.outcome,
        summary: input.summary,
      });
      return { content: bareFinalize(finalized) };
    },
  });

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
      });
      const structure = await deps.store.getArtifactStructure({
        artifactID: input.artifactID,
        location: deps.directory,
      });
      return {
        content: [
          ...summaryHeader(view, "ARTIFACT_CONTENT"),
          ...structureLines(view, structure),
          "",
          view.content,
        ].join("\n"),
      };
    },
  });

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
      });
      const lines = [
        "ARTIFACT_SUMMARY",
        ...summaryHeader(summary, "ARTIFACT_SUMMARY").slice(1),
      ];
      lines.push(`Outcome: ${summary.outcome ?? "unset"}`);
      if (summary.summary.length > 0) lines.push(`Summary: ${summary.summary}`);
      return { content: lines.join("\n") };
    },
  });

}
