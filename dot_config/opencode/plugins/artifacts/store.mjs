// Artifact registry: a Node-compatible, filesystem-backed store for structured
// artifacts exchanged between sessions and the Neovim client.
//
// Each artifact is one authoritative record (record.json) holding a flat
// kind-specific content model, plus one generated read-only view (current.md)
// rendered by ./format.mjs. Records may use only this flat model; unsupported
// record shapes are rejected.
//
// Kind-specific content (record.json):
// - memory: a per-session Markdown working memory (`content`) that is always
//   published and editable. It is injected into the session context and carried
//   across compaction, so it is never a readiness-gated draft.
// - plan: `workingDirectory` plus four flat prose fields (goalScope,
//   intendedChanges, context, checks) and an evidence membership array of
//   snapshotted entries {id: art_..., description} keyed only by the evidence
//   artifact ID. Goal/Scope and Checks are whole-field sets; Intended Changes
//   and Context use exact oldText→newText replacement with a declared
//   patch_conflict unless the old text occurs exactly once.
// - evidence: main question/topic plus Summary and Limitations prose, and an
//   ordered array of detailed findings {id, title, content}. Findings keep
//   stable IDs for their author only; the IDs never enter the rendered view or
//   the primary-agent context.
// - review: machine-readable outcome ("Pass", "Changes required", or
//   "Blocked"), human-readable Summary prose, and ordered findings {id, title,
//   severity, affected, evidence, risk, correction}.
// - report: linked planArtifactID plus Summary, Changed, Checks, and Unfinished
//   prose (the report surface), finalized to published like evidence
//   and reviews.
//
// Ownership: `ownerSessionID` is the primary-agent-facing identity (routing,
// feedback, cleanup) and `writerSessionID` is the immutable sole mutation
// authority — the session that created the artifact. Mutations reject any
// caller that is not the writer. `primaryAuthor` is immutable frontend metadata
// (a name/label derived from the creating agent); owner/writer/session IDs stay
// internal routing data and never enter the rendered frontmatter.
//
// Readiness: every content mutation clears the `finalized` flag.
// plan_finalize validates the flat prose fields and marks the plan ready for
// review (status stays draft); evidence/review/report finalization validates
// useful content and transitions the visible draft to `published`. Approval is
// an optional review marker, not an implementation gate: an approved plan that
// is edited returns to draft so it can be reviewed again. Memory is always
// published and editable.
//
// Design rules:
// - All paths are derived internally from the store root plus generated IDs.
// - Every lookup is scoped to the location recorded on the artifact.
// - record.json is authoritative and written last; the derived view is written
//   first so an interrupted write is repairable by regeneration.
// - Mutations serialize on an exclusive per-artifact lock file (lock_conflict,
//   never bypassed; a stale lock is removed by hand).
// - Pure Node (node:*) so `node --test` can exercise it without Bun.

import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
} from "node:path";

import { bodyOf, renderView } from "./format.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{8}$/;
const FINDING_ID_PATTERN = /^fin_[a-f0-9]{8}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

const MAX_MARKDOWN_LENGTH = 2_000_000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_SESSION_LENGTH = 128;
const MAX_AUTHOR_LENGTH = 200;
/** Feedback question limit (UTF-8 bytes). */
const MAX_QUESTION_BYTES = 16 * 1024;
/** User-selected excerpt limit (UTF-8 bytes). */
const MAX_SELECTION_BYTES = 64 * 1024;

export const ARTIFACT_KINDS = Object.freeze([
  "memory",
  "checkpoint",
  "plan",
  "evidence",
  "review",
  "report",
]);
// Lifecycle is kind-specific: memory (project) and checkpoint (session) are
// always published live documents; plans use draft/approved (approval is a
// review marker, not a gate); evidence, reviews, and reports use
// draft/published/read — created as drafts, finalized to published, and
// dismissed with read.
export const ARTIFACT_STATUSES = Object.freeze([
  "draft",
  "published",
  "approved",
  "read",
]);

/** Machine-readable review outcomes. */
export const REVIEW_OUTCOMES = Object.freeze([
  "Pass",
  "Changes required",
  "Blocked",
]);

/** Report prose sections addressed by report_update. */
export const REPORT_SECTIONS = Object.freeze([
  "summary",
  "changed",
  "checks",
  "unfinished",
]);

/** Plan prose fields that accept whole-field replacement. */
export const PLAN_SET_FIELDS = Object.freeze([
  "goalScope",
  "intendedChanges",
  "context",
  "checks",
]);

/** Plan prose fields that use exact oldText→newText patching. */
export const PLAN_PATCH_FIELDS = Object.freeze(["intendedChanges", "context"]);

/** Flat fields that must contain text before a plan may be finalized. */
export const REQUIRED_PLAN_FIELDS = Object.freeze([
  "goalScope",
  "intendedChanges",
]);

/** Error with a stable machine-readable code used by tools and RPC handlers. */
export class StoreError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.data = data;
  }
}

/** Default registry root: $XDG_STATE_HOME/opencode/plan-bridge or ~/.local/state/opencode/plan-bridge. */
export function defaultStateRoot() {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "opencode", "plan-bridge");
}

function newSharedArtifactID() {
  return "art_" + randomBytes(4).toString("hex");
}

function newFindingID() {
  return "fin_" + randomBytes(4).toString("hex");
}

function nowISO() {
  return new Date().toISOString();
}

function freshDelivery() {
  return {
    state: "pending",
    attemptedAt: null,
    deliveredAt: null,
    error: null,
  };
}

function assertNonEmptyString(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreError("validation", `${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new StoreError(
      "validation",
      `${label} must be at most ${maxLength} characters`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new StoreError(
      "validation",
      `${label} must not contain control characters`,
    );
  }
}

function normalizeLocation(location) {
  if (typeof location !== "string" || location.length === 0) {
    throw new StoreError(
      "validation",
      "location must be a non-empty directory path",
    );
  }
  if (!isAbsolute(location)) {
    throw new StoreError(
      "validation",
      `location must be an absolute directory path, got ${JSON.stringify(location)}`,
    );
  }
  return resolvePath(location);
}

function assertArtifactID(artifactID) {
  if (typeof artifactID !== "string" || !ARTIFACT_ID_PATTERN.test(artifactID)) {
    throw new StoreError(
      "validation",
      `artifactID must match ${ARTIFACT_ID_PATTERN}`,
    );
  }
}

function assertRequestID(requestID) {
  if (typeof requestID !== "string" || !REQUEST_ID_PATTERN.test(requestID)) {
    throw new StoreError(
      "validation",
      `requestID must match ${REQUEST_ID_PATTERN}`,
    );
  }
}

function serializeRecord(record) {
  return JSON.stringify(record, null, 2) + "\n";
}

/** The displayed frontmatter fields of the generated view (frontend data only). */
function viewHeaderOf(record) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    title: record.title,
    primaryAuthor: record.primaryAuthor,
    description: record.description,
  };
}

function isArtifactIDListEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.id === "string" &&
    ARTIFACT_ID_PATTERN.test(entry.id) &&
    typeof entry.description === "string" &&
    entry.description.length > 0
  );
}

function isFindingEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.id === "string" &&
    FINDING_ID_PATTERN.test(entry.id)
  );
}

function validateRecord(record, artifactID) {
  if (record === null || typeof record !== "object" || Array.isArray(record))
    return "record must be an object";
  if (record.id !== artifactID) return "record id does not match directory";
  if (typeof record.id !== "string" || !ARTIFACT_ID_PATTERN.test(record.id))
    return "invalid artifact id";
  if (typeof record.kind !== "string" || !ARTIFACT_KINDS.includes(record.kind))
    return "invalid kind";
  if (
    typeof record.ownerSessionID !== "string" ||
    record.ownerSessionID.length === 0
  )
    return "missing ownerSessionID";
  if (
    typeof record.writerSessionID !== "string" ||
    record.writerSessionID.length === 0
  )
    return "missing writerSessionID";
  if (typeof record.location !== "string" || record.location.length === 0)
    return "missing location";
  if (typeof record.title !== "string" || record.title.length === 0)
    return "missing title";
  if (typeof record.description !== "string" || record.description.length === 0)
    return "missing description";
  if (
    typeof record.primaryAuthor !== "string" ||
    record.primaryAuthor.length === 0
  )
    return "missing primaryAuthor";
  if (
    typeof record.status !== "string" ||
    !ARTIFACT_STATUSES.includes(record.status)
  )
    return "invalid status";
  if (typeof record.finalized !== "boolean")
    return "invalid finalized readiness flag";
  // Records must use the flat kind-specific model; unsupported shapes are rejected.
  if (record.body !== undefined)
    return "legacy whole-document body records are not accepted";
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0)
    return "missing createdAt";
  if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0)
    return "missing updatedAt";
  if (!Array.isArray(record.feedback)) return "feedback must be an array";
  for (const entry of record.feedback) {
    if (!entry || typeof entry !== "object")
      return "feedback entries must be objects";
    if (
      typeof entry.requestID !== "string" ||
      !REQUEST_ID_PATTERN.test(entry.requestID)
    )
      return "invalid feedback requestID";
    if (
      entry.recipient !== undefined &&
      entry.recipient !== "owner" &&
      entry.recipient !== "writer"
    )
      return "invalid feedback recipient";
    if (!entry.delivery || typeof entry.delivery.state !== "string")
      return "feedback entry missing delivery state";
  }
  if (
    record.approval !== null &&
    (typeof record.approval !== "object" ||
      !record.approval ||
      typeof record.approval.requestID !== "string")
  ) {
    return "invalid approval";
  }
  if (
    record.readAt !== undefined &&
    record.readAt !== null &&
    (typeof record.readAt !== "object" ||
      !record.readAt ||
      typeof record.readAt.requestID !== "string" ||
      typeof record.readAt.readAt !== "string")
  ) {
    return "invalid readAt";
  }
  if (record.sections !== undefined)
    return "legacy plan sections are not accepted";
  if (record.topics !== undefined)
    return "legacy evidence topics are not accepted";
  if (record.verdict !== undefined)
    return "legacy review verdict is not accepted";

  if (record.kind === "memory" || record.kind === "checkpoint") {
    if (typeof record.content !== "string")
      return `${record.kind} content must be a string`;
    if (record.content.length > MAX_MARKDOWN_LENGTH)
      return `${record.kind} content is too long`;
  }
  if (record.kind === "plan") {
    if (
      typeof record.workingDirectory !== "string" ||
      record.workingDirectory.length === 0
    )
      return "missing plan workingDirectory";
    for (const field of PLAN_SET_FIELDS.concat(PLAN_PATCH_FIELDS)) {
      if (typeof record[field] !== "string")
        return `plan ${field} must be a string`;
    }
    if (typeof record.checks !== "string")
      return "plan checks must be a string";
    if (!Array.isArray(record.evidence))
      return "plan evidence must be an array";
    const seen = new Set();
    for (const entry of record.evidence) {
      if (!isArtifactIDListEntry(entry))
        return "invalid plan evidence membership entry";
      if (seen.has(entry.id)) return "duplicate plan evidence membership";
      seen.add(entry.id);
    }
  }
  if (record.kind === "evidence") {
    if (record.question !== null && typeof record.question !== "string")
      return "evidence question must be a string or null";
    if (typeof record.summary !== "string")
      return "evidence summary must be a string";
    if (typeof record.limitations !== "string")
      return "evidence limitations must be a string";
    if (!Array.isArray(record.findings))
      return "evidence findings must be an array";
    for (const finding of record.findings) {
      if (!isFindingEntry(finding)) return "invalid evidence finding id";
      if (typeof finding.title !== "string" || finding.title.length === 0)
        return "evidence finding title must be a non-empty string";
      if (typeof finding.content !== "string" || finding.content.length === 0)
        return "evidence finding content must be a non-empty string";
    }
  }
  if (record.kind === "review") {
    if (record.outcome !== null && !REVIEW_OUTCOMES.includes(record.outcome))
      return "invalid review outcome";
    if (typeof record.summary !== "string")
      return "review summary must be a string";
    if (!Array.isArray(record.findings))
      return "review findings must be an array";
    for (const finding of record.findings) {
      if (!isFindingEntry(finding)) return "invalid review finding id";
      if (typeof finding.title !== "string" || finding.title.length === 0)
        return "finding title must be a non-empty string";
      for (const key of [
        "severity",
        "affected",
        "evidence",
        "risk",
        "correction",
      ]) {
        if (typeof finding[key] !== "string")
          return `finding ${key} must be a string`;
      }
      if (finding.severity.length === 0)
        return "finding severity must be a non-empty string";
      if (finding.correction.length === 0)
        return "finding correction must be a non-empty string";
    }
  }
  if (record.kind === "report") {
    if (
      record.planArtifactID !== null &&
      (typeof record.planArtifactID !== "string" ||
        !ARTIFACT_ID_PATTERN.test(record.planArtifactID))
    ) {
      return "invalid report planArtifactID";
    }
    for (const field of REPORT_SECTIONS) {
      if (typeof record[field] !== "string")
        return `report ${field} must be a string`;
    }
  }
  return null;
}

/**
 * Create a registry bound to `root` (defaults to the shared state root).
 * `root` is store configuration (tests point it at a fixture directory);
 * artifact paths are still always derived internally, never caller-supplied.
 */
export function createStore(options = {}) {
  if (
    options.root !== undefined &&
    (typeof options.root !== "string" || options.root.length === 0)
  ) {
    throw new StoreError(
      "validation",
      "store root must be a non-empty string when provided",
    );
  }
  const root = resolvePath(options.root ?? defaultStateRoot());
  const artifactsDir = join(root, "artifacts");
  // Project memory is one document per project location; checkpoints are one
  // document per session. Both indexes are pointers only, so injection and
  // mutation stay O(1) instead of rescanning the registry.
  const projectMemoryIndexPath = join(root, "project-memory-index.json");
  const checkpointIndexPath = join(root, "checkpoint-index.json");

  async function readIndex(path) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      return {};
    }
  }

  async function writeIndex(path, index) {
    await mkdir(root, { recursive: true, mode: DIR_MODE });
    await writeFileAtomic(
      path,
      JSON.stringify(index, null, 2) + "\n",
      FILE_MODE,
    );
  }

  function artifactDirOf(artifactID) {
    return join(artifactsDir, artifactID);
  }
  function recordPathOf(artifactID) {
    return join(artifactDirOf(artifactID), "record.json");
  }
  function currentPathOf(artifactID) {
    return join(artifactDirOf(artifactID), "current.md");
  }
  function lockPathOf(artifactID) {
    return join(artifactDirOf(artifactID), "lock");
  }

  async function ensureDirectories() {
    // mkdir -p is idempotent, so this runs on every operation instead of
    // caching a flag: a deleted registry (runtime reset) is recreated on the
    // next read, keeping list/get an empty success rather than ENOENT.
    await mkdir(artifactsDir, { recursive: true, mode: DIR_MODE });
    await chmod(artifactsDir, DIR_MODE).catch(() => {});
  }

  async function syncDirectory(dir) {
    // Best effort: some systems refuse directory fsync; atomicity of the
    // rename itself never depends on this.
    try {
      const handle = await open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* ignore */
    }
  }

  /** Atomic replace: write temp sibling, fsync, rename over the target. */
  async function writeFileAtomic(target, data, mode) {
    const dir = dirname(target);
    const temp = join(
      dir,
      `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const handle = await open(temp, "w", mode);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    await chmod(target, mode).catch(() => {});
    await syncDirectory(dir);
  }

  async function readRecord(artifactID) {
    let raw;
    try {
      raw = await readFile(recordPathOf(artifactID), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new StoreError(
        "io",
        `Registry record for ${artifactID} is not valid JSON`,
      );
    }
    const problem = validateRecord(record, artifactID);
    if (problem)
      throw new StoreError(
        "io",
        `Registry record for ${artifactID} is invalid: ${problem}`,
      );
    return record;
  }

  /** Rewrite the derived view from the record (repairs an interrupted write). */
  async function writeCurrentView(artifactID, record) {
    const rendered = await renderView(viewHeaderOf(record), bodyOf(record));
    await writeFileAtomic(currentPathOf(artifactID), rendered, FILE_MODE);
    return rendered;
  }

  /**
   * Return the view derived from the authoritative record, reconciling a stale
   * or missing current.md so reads can never serve bytes that disagree with the
   * record (for example after an interrupted view-first/record-last update).
   */
  async function readCurrentView(artifactID, record) {
    const rendered = await renderView(viewHeaderOf(record), bodyOf(record));
    let existing = null;
    try {
      existing = await readFile(currentPathOf(artifactID), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing !== rendered) {
      await writeFileAtomic(currentPathOf(artifactID), rendered, FILE_MODE);
    }
    return rendered;
  }

  /**
   * Serialize a mutation on an exclusive per-artifact lock. An existing lock
   * is reported as lock_conflict; it is never bypassed. The lock is released
   * in finally.
   */
  async function withLock(artifactID, mutate) {
    const lock = lockPathOf(artifactID);
    let handle;
    try {
      handle = await open(lock, "wx", FILE_MODE);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new StoreError(
          "lock_conflict",
          `Artifact ${artifactID} is locked by another mutation; no changes were made. ` +
            `If the lock is stale (its holder crashed), remove ${lock} and retry; the record is intact.`,
          { artifactID, lock },
        );
      }
      throw error;
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: nowISO() })}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      return await mutate();
    } finally {
      try {
        await unlink(lock);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  /** Load a record scoped to the location: unknown IDs and cross-location lookups are both not_found. */
  async function loadScoped(artifactID, location, { label = "artifact" } = {}) {
    const record = await readRecord(artifactID);
    if (!record || record.location !== location) {
      throw new StoreError(
        "not_found",
        `No ${label} ${artifactID} at this location`,
        { artifactID },
      );
    }
    return record;
  }

  function artifactSummaryOf(record) {
    return {
      id: record.id,
      kind: record.kind,
      title: record.title,
      description: record.description,
      primaryAuthor: record.primaryAuthor,
      status: record.status,
      path: currentPathOf(record.id),
      // ownerSessionID stays consumer-visible for the Neovim attached-session
      // filter; writerSessionID is internal routing/delivery data and is
      // stripped from the RPC wire contract in index.ts.
      ownerSessionID: record.ownerSessionID,
      writerSessionID: record.writerSessionID,
      finalized: record.finalized === true,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function artifactViewOf(record, content) {
    return {
      ...artifactSummaryOf(record),
      location: record.location,
      content,
      feedback: record.feedback,
      approval: record.approval,
    };
  }

  /**
   * Create one artifact. The kind is fixed by the caller's tool; the owner is
   * the primary-agent-facing session and the writer the creating session (the sole
   * mutation authority); primaryAuthor is immutable frontend metadata.
   * title/description/workingDirectory are immutable; content is assembled
   * with the kind-specific operations. Every artifact starts as a draft with
   * `finalized: false`. Reports may additionally link to a plan, from
   * which title/description are derived when not supplied.
   */
  async function createArtifact({
    kind,
    ownerSessionID,
    writerSessionID,
    primaryAuthor,
    location,
    title,
    description,
    workingDirectory,
    planArtifactID,
    initial = {},
  }) {
    if (typeof kind !== "string" || !ARTIFACT_KINDS.includes(kind)) {
      throw new StoreError(
        "validation",
        `kind must be one of ${ARTIFACT_KINDS.join(", ")}`,
        { kind },
      );
    }
    assertNonEmptyString(ownerSessionID, "ownerSessionID", MAX_SESSION_LENGTH);
    assertNonEmptyString(
      writerSessionID,
      "writerSessionID",
      MAX_SESSION_LENGTH,
    );
    assertNonEmptyString(primaryAuthor, "primaryAuthor", MAX_AUTHOR_LENGTH);
    const trimmedPrimaryAuthor = primaryAuthor.trim();
    if (trimmedPrimaryAuthor.length === 0) {
      throw new StoreError("validation", "primaryAuthor must not be empty");
    }
    const normalizedLocation = normalizeLocation(location);
    if (kind === "plan") {
      assertNonEmptyString(
        workingDirectory,
        "workingDirectory",
        MAX_DESCRIPTION_LENGTH,
      );
      if (!isAbsolute(workingDirectory)) {
        throw new StoreError(
          "validation",
          "workingDirectory must be an absolute directory path",
        );
      }
    }
    let trimmedTitle = typeof title === "string" ? title.trim() : "";
    let trimmedDescription =
      typeof description === "string" ? description.trim() : "";
    if (
      kind === "report" &&
      planArtifactID !== undefined &&
      planArtifactID !== null
    ) {
      assertArtifactID(planArtifactID);
      await ensureDirectories();
      const planRecord = await loadScoped(planArtifactID, normalizedLocation, {
        label: "plan artifact",
      });
      if (planRecord.kind !== "plan") {
        throw new StoreError(
          "invalid_kind",
          `Reports link to plans only; ${planArtifactID} is a ${planRecord.kind}`,
          {
            artifactID: planArtifactID,
            kind: planRecord.kind,
          },
        );
      }
      // A report records work done against a plan. The plan may be a draft, in
      // review, or already reviewed; report creation is not an approval gate.
      if (trimmedTitle.length === 0)
        trimmedTitle = `Report: ${planRecord.title}`;
      if (trimmedDescription.length === 0)
        trimmedDescription = planRecord.description;
    }
    if (trimmedTitle.length === 0)
      throw new StoreError("validation", "title must not be empty");
    if (trimmedDescription.length === 0)
      throw new StoreError("validation", "description must not be empty");
    if (trimmedTitle.length > MAX_TITLE_LENGTH)
      throw new StoreError(
        "validation",
        `title must be at most ${MAX_TITLE_LENGTH} characters`,
      );
    if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH)
      throw new StoreError(
        "validation",
        `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    // eslint-disable-next-line no-control-regex
    if (
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(
        trimmedTitle + trimmedDescription,
      )
    ) {
      throw new StoreError(
        "validation",
        "title and description must not contain control characters",
      );
    }

    await ensureDirectories();
    const artifactID = newSharedArtifactID();
    const createdAt = nowISO();
    const record = {
      id: artifactID,
      kind,
      ownerSessionID,
      writerSessionID,
      primaryAuthor: trimmedPrimaryAuthor,
      location: normalizedLocation,
      title: trimmedTitle,
      description: trimmedDescription,
      status: "draft",
      finalized: false,
      createdAt,
      updatedAt: createdAt,
      feedback: [],
      approval: null,
      readAt: null,
    };
    if (kind === "memory" || kind === "checkpoint") {
      if (initial.content !== undefined)
        assertMemoryMarkdown(initial.content, "initial content", {
          allowEmpty: true,
        });
      record.content =
        typeof initial.content === "string" ? initial.content : "";
      // Project memory and the session checkpoint are live working documents,
      // not drafts to publish or dismiss. They are always readable and editable.
      record.status = "published";
      record.finalized = true;
    }
    if (kind === "plan") {
      record.workingDirectory = resolvePath(workingDirectory);
      for (const field of PLAN_SET_FIELDS) {
        if (initial[field] !== undefined)
          assertMemoryMarkdown(initial[field], `initial ${field}`, {
            allowEmpty: true,
          });
        record[field] = typeof initial[field] === "string" ? initial[field] : "";
      }
      record.evidence = [];
    }
    if (kind === "evidence") {
      if (
        initial.question !== undefined &&
        initial.question !== null &&
        typeof initial.question !== "string"
      ) {
        throw new StoreError(
          "validation",
          "initial question must be a string or null",
        );
      }
      for (const field of ["summary", "limitations"]) {
        if (initial[field] !== undefined)
          assertMemoryMarkdown(initial[field], `initial ${field}`, {
            allowEmpty: true,
          });
      }
      record.question =
        typeof initial.question === "string" &&
        initial.question.trim().length > 0
          ? initial.question.trim()
          : null;
      record.summary =
        typeof initial.summary === "string" ? initial.summary : "";
      record.limitations =
        typeof initial.limitations === "string" ? initial.limitations : "";
      record.findings = [];
    }
    if (kind === "review") {
      if (
        initial.outcome !== undefined &&
        initial.outcome !== null &&
        !REVIEW_OUTCOMES.includes(initial.outcome)
      ) {
        throw new StoreError(
          "validation",
          `initial outcome must be one of ${REVIEW_OUTCOMES.join(", ")}`,
        );
      }
      if (initial.summary !== undefined)
        assertMemoryMarkdown(initial.summary, "initial summary", {
          allowEmpty: true,
        });
      record.outcome = initial.outcome ?? null;
      record.summary =
        typeof initial.summary === "string" ? initial.summary : "";
      record.findings = [];
    }
    if (kind === "report") {
      for (const field of REPORT_SECTIONS) {
        if (initial[field] !== undefined)
          assertMemoryMarkdown(initial[field], `initial ${field}`, {
            allowEmpty: true,
          });
      }
      record.planArtifactID = planArtifactID ?? null;
      record.summary =
        typeof initial.summary === "string" ? initial.summary : "";
      record.changed =
        typeof initial.changed === "string" ? initial.changed : "";
      record.checks = typeof initial.checks === "string" ? initial.checks : "";
      record.unfinished =
        typeof initial.unfinished === "string" ? initial.unfinished : "";
    }

    // Commit order: the derived view first, the authoritative record last.
    await mkdir(artifactDirOf(artifactID), { recursive: true, mode: DIR_MODE });
    await chmod(artifactDirOf(artifactID), DIR_MODE).catch(() => {});
    await writeCurrentView(artifactID, record);
    await writeFileAtomic(
      recordPathOf(artifactID),
      serializeRecord(record),
      FILE_MODE,
    );

    if (kind === "memory") {
      const index = await readIndex(projectMemoryIndexPath);
      index[normalizedLocation] = artifactID;
      await writeIndex(projectMemoryIndexPath, index);
    }
    if (kind === "checkpoint") {
      const index = await readIndex(checkpointIndexPath);
      index[`${normalizedLocation}\u0000${ownerSessionID}`] = artifactID;
      await writeIndex(checkpointIndexPath, index);
    }

    return { artifactID, ...artifactSummaryOf(record) };
  }

  /**
   * Load the record for a content mutation and apply the mutation invariants:
   * kind, writer authorization, approved-plan freeze, and the readiness rule
   * that every content mutation clears `finalized` (evidence/reviews/reports
   * also return to the visible draft state so they must be finalized again). No
   * files are written here; the caller commits by writing view then record.
   */
  async function prepareContentMutation({
    artifactID,
    location,
    writerSessionID,
    expectKind,
  }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    const record = await loadScoped(artifactID, normalizedLocation);
    const expected = Array.isArray(expectKind) ? expectKind : [expectKind];
    if (!expected.includes(record.kind)) {
      throw new StoreError(
        "invalid_kind",
        `Content mutations apply to ${expected.join(" and ")} only; ${artifactID} is a ${record.kind}`,
        { artifactID, kind: record.kind },
      );
    }
    // Project memory is shared by every primary session in the project, so it
    // is the one kind without a writer-session restriction. Everything else is
    // still owned by the session that authored it.
    if (
      record.kind !== "memory" &&
      record.writerSessionID !== writerSessionID
    ) {
      throw new StoreError(
        "forbidden",
        `Content mutations are restricted to the writer session (${record.writerSessionID})`,
        { artifactID, writerSessionID: record.writerSessionID },
      );
    }
    // Project memory and the session checkpoint are live documents: edits keep
    // them published and readable.
    if (record.kind === "memory" || record.kind === "checkpoint") {
      record.status = "published";
      record.finalized = true;
      record.readAt = null;
      return record;
    }
    // A reviewed plan that changes is a draft again, so the user can review the
    // new version. Approval is a marker, not a freeze.
    if (record.kind === "plan" && record.status === "approved") {
      record.status = "draft";
      record.readAt = null;
      if (record.approval) record.approval = null;
    }
    // Evidence/reviews/reports reset to the visible draft on edit.
    if (record.kind !== "plan") {
      record.status = "draft";
      record.readAt = null;
      if (record.approval) record.approval = null;
    }
    record.finalized = false;
    return record;
  }

  /** Commit a content mutation with the view-first/record-last discipline. */
  async function commitMutation(artifactID, record) {
    record.updatedAt = nowISO();
    await writeCurrentView(artifactID, record);
    await writeFileAtomic(
      recordPathOf(artifactID),
      serializeRecord(record),
      FILE_MODE,
    );
    return { artifactID, ...artifactSummaryOf(record) };
  }

  function assertProseField(value, label) {
    if (typeof value !== "string" || value.length === 0) {
      throw new StoreError("validation", `${label} must be a non-empty string`);
    }
    if (value.length > MAX_MARKDOWN_LENGTH) {
      throw new StoreError(
        "validation",
        `${label} must be at most ${MAX_MARKDOWN_LENGTH} characters`,
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new StoreError(
        "validation",
        `${label} must not contain control characters`,
      );
    }
  }

  /**
   * Whole-field set for Goal/Scope and Checks: replaces the entire stored prose
   * field unconditionally. There is no oldText base and no conflict signal.
   */
  async function planFieldSet({
    artifactID,
    location,
    writerSessionID,
    field,
    content,
  }) {
    if (!PLAN_SET_FIELDS.includes(field)) {
      throw new StoreError(
        "validation",
        `field must be one of ${PLAN_SET_FIELDS.join(", ")}`,
        { field },
      );
    }
    if (!(field === "checks" && content === ""))
      assertProseField(content, "content");

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "plan",
      });
      record[field] = content;
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Section-bounded oldText→newText replacement for Intended Changes and
   * Context: succeeds only when the stored field string exactly equals
   * oldText (empty oldText is valid only for a currently empty field).
   * Otherwise the write is refused with patch_conflict and the record is
   * untouched; the caller must re-read the current content and re-base.
   */
  async function planFieldPatch({
    artifactID,
    location,
    writerSessionID,
    field,
    oldText,
    newText,
  }) {
    if (!PLAN_PATCH_FIELDS.includes(field)) {
      throw new StoreError(
        "validation",
        "field must be one of intendedChanges, context",
        { field },
      );
    }
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new StoreError("validation", "oldText and newText must be strings");
    }
    if (
      oldText.length > MAX_MARKDOWN_LENGTH ||
      newText.length > MAX_MARKDOWN_LENGTH
    ) {
      throw new StoreError(
        "validation",
        `oldText and newText must be at most ${MAX_MARKDOWN_LENGTH} characters`,
      );
    }
    // eslint-disable-next-line no-control-regex
    if (
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(oldText) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(newText)
    ) {
      throw new StoreError(
        "validation",
        "oldText and newText must not contain control characters",
      );
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "plan",
      });
      const current = record[field];
      // Empty oldText is only valid for inserting into an empty field. A
      // non-empty oldText must occur exactly once, so one bullet or paragraph
      // can be changed without restating the whole field.
      let position = -1;
      if (oldText.length === 0) {
        if (current.length !== 0) {
          throw new StoreError(
            "patch_conflict",
            `Patch refused for plan ${field}: empty oldText is only valid when the field is empty. Re-read the field, use a unique oldText, and retry. No write was made.`,
            { artifactID, field },
          );
        }
        position = 0;
      } else {
        const first = current.indexOf(oldText);
        if (
          first === -1 ||
          current.indexOf(oldText, first + oldText.length) !== -1
        ) {
          throw new StoreError(
            "patch_conflict",
            `Patch refused for plan ${field}: oldText must occur exactly once in the current content. ` +
              `Re-read the field, choose a unique base, and retry. No write was made.`,
            { artifactID, field },
          );
        }
        position = first;
      }
      record[field] =
        current.slice(0, position) +
        newText +
        current.slice(position + oldText.length);
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Add one or more published evidence artifacts to a plan's membership list in
   * one ordered atomic call. Every evidenceID is validated FIRST (pattern,
   * same location, kind=evidence, finalized+published) before any change; on
   * any invalid member no membership, snapshot, or view is written, so the
   * whole array add is all-or-nothing. Each evidence's immutable short
   * description is snapshotted into the plan record automatically (readable
   * after later artifact cleanup); membership is keyed only by the evidence
   * artifact ID. Existing members keep their relative order, then new unique
   * IDs are appended in first-input order (duplicates against existing
   * membership or earlier entries in the same call are skipped). One locked
   * commitMutation writes the whole result.
   */
  async function planEvidenceAddMany({
    artifactID,
    location,
    writerSessionID,
    evidenceIDs,
  }) {
    if (!Array.isArray(evidenceIDs) || evidenceIDs.length === 0) {
      throw new StoreError(
        "validation",
        "evidenceIDs must be a non-empty array of evidence artifact IDs",
      );
    }
    for (const evidenceID of evidenceIDs) {
      assertArtifactID(evidenceID);
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "plan",
      });
      const normalizedLocation = resolvePath(location);
      // Validate every unique member before mutating anything: location,
      // kind, and readiness all pass or the whole array add fails with no
      // membership change, no snapshot append, and no view written.
      const snapshots = [];
      const validated = new Set();
      for (const evidenceID of evidenceIDs) {
        if (validated.has(evidenceID)) continue;
        validated.add(evidenceID);
        const evidenceRecord = await loadScoped(
          evidenceID,
          normalizedLocation,
          { label: "evidence artifact" },
        );
        if (evidenceRecord.kind !== "evidence") {
          throw new StoreError(
            "invalid_kind",
            `Plan evidence membership applies to evidence artifacts only; ${evidenceID} is a ${evidenceRecord.kind}`,
            { artifactID: evidenceID, kind: evidenceRecord.kind },
          );
        }
        if (
          evidenceRecord.finalized !== true ||
          evidenceRecord.status !== "published"
        ) {
          throw new StoreError(
            "not_ready",
            `Plan evidence membership requires a finalized, published evidence artifact; ${evidenceID} is ${evidenceRecord.status}`,
            { artifactID: evidenceID, status: evidenceRecord.status },
          );
        }
        snapshots.push({
          id: evidenceID,
          description: evidenceRecord.description,
        });
      }
      const existing = new Set(record.evidence.map((entry) => entry.id));
      for (const snapshot of snapshots) {
        if (existing.has(snapshot.id)) continue;
        existing.add(snapshot.id);
        record.evidence.push(snapshot);
      }
      return commitMutation(artifactID, record);
    });
  }

  /** Remove one evidence artifact from a plan's membership list by its artifact ID. */
  async function planEvidenceRemove({
    artifactID,
    location,
    writerSessionID,
    evidenceID,
  }) {
    assertArtifactID(evidenceID);

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "plan",
      });
      const position = record.evidence.findIndex(
        (entry) => entry.id === evidenceID,
      );
      if (position === -1) {
        throw new StoreError(
          "not_found",
          `No plan evidence membership for ${evidenceID}`,
          { artifactID, evidenceID },
        );
      }
      record.evidence.splice(position, 1);
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Combined plan mutation: replace any subset of prose fields, optionally
   * patch one exact occurrence in Intended Changes or Context, and optionally
   * replace the ordered evidence membership. All validation happens before a
   * single locked commit, so a bad field or evidence member leaves the plan
   * untouched.
   */
  async function planUpdate({
    artifactID,
    location,
    writerSessionID,
    fields = {},
    evidenceIDs,
    patch,
  }) {
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      throw new StoreError("validation", "fields must be an object");
    }
    const providedFields = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );
    const hasFields = providedFields.length > 0;
    const hasEvidence = evidenceIDs !== undefined;
    const hasPatch = patch !== undefined && patch !== null;
    if (!hasFields && !hasEvidence && !hasPatch) {
      throw new StoreError(
        "validation",
        "plan update requires at least one field, patch, or evidenceIDs",
      );
    }

    for (const [field, content] of providedFields) {
      if (!PLAN_SET_FIELDS.includes(field)) {
        throw new StoreError(
          "validation",
          `field must be one of ${PLAN_SET_FIELDS.join(", ")}`,
          { field },
        );
      }
      if (!(field === "checks" && content === "")) {
        assertProseField(content, `plan ${field}`);
      }
    }

    let patchField;
    if (hasPatch) {
      if (typeof patch !== "object" || Array.isArray(patch)) {
        throw new StoreError("validation", "patch must be an object");
      }
      patchField = patch.field;
      if (!PLAN_PATCH_FIELDS.includes(patchField)) {
        throw new StoreError(
          "validation",
          `patch.field must be one of ${PLAN_PATCH_FIELDS.join(", ")}`,
          { field: patchField },
        );
      }
      if (
        typeof patch.oldText !== "string" ||
        typeof patch.newText !== "string"
      ) {
        throw new StoreError(
          "validation",
          "patch.oldText and patch.newText must be strings",
        );
      }
      if (
        patch.oldText.length > MAX_MARKDOWN_LENGTH ||
        patch.newText.length > MAX_MARKDOWN_LENGTH
      ) {
        throw new StoreError(
          "validation",
          `patch.oldText and patch.newText must be at most ${MAX_MARKDOWN_LENGTH} characters`,
        );
      }
      // eslint-disable-next-line no-control-regex
      if (
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(patch.oldText) ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(patch.newText)
      ) {
        throw new StoreError(
          "validation",
          "patch.oldText and patch.newText must not contain control characters",
        );
      }
      if (
        hasFields &&
        Object.prototype.hasOwnProperty.call(fields, patchField)
      ) {
        throw new StoreError(
          "validation",
          "cannot replace and patch the same plan field in one call",
          { field: patchField },
        );
      }
    }

    if (hasEvidence) {
      if (!Array.isArray(evidenceIDs)) {
        throw new StoreError(
          "validation",
          "evidenceIDs must be an array of evidence artifact IDs",
        );
      }
      for (const evidenceID of evidenceIDs) {
        assertArtifactID(evidenceID);
      }
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "plan",
      });

      if (hasPatch) {
        const current = record[patchField];
        let position = -1;
        if (patch.oldText.length === 0) {
          if (current.length !== 0) {
            throw new StoreError(
              "patch_conflict",
              `Patch refused for plan ${patchField}: empty oldText is only valid when the field is empty. Re-read the field, use a unique oldText, and retry. No write was made.`,
              { artifactID, field: patchField },
            );
          }
          position = 0;
        } else {
          const first = current.indexOf(patch.oldText);
          if (
            first === -1 ||
            current.indexOf(patch.oldText, first + patch.oldText.length) !== -1
          ) {
            throw new StoreError(
              "patch_conflict",
              `Patch refused for plan ${patchField}: oldText must occur exactly once in the current content. Re-read the field, choose a unique base, and retry. No write was made.`,
              { artifactID, field: patchField },
            );
          }
          position = first;
        }
        record[patchField] =
          current.slice(0, position) +
          patch.newText +
          current.slice(position + patch.oldText.length);
      }

      for (const [field, content] of providedFields) {
        record[field] = content;
      }

      if (hasEvidence) {
        const normalizedLocation = resolvePath(location);
        const snapshots = [];
        const validated = new Set();
        for (const evidenceID of evidenceIDs) {
          if (validated.has(evidenceID)) continue;
          validated.add(evidenceID);
          const evidenceRecord = await loadScoped(
            evidenceID,
            normalizedLocation,
            { label: "evidence artifact" },
          );
          if (evidenceRecord.kind !== "evidence") {
            throw new StoreError(
              "invalid_kind",
              `Plan evidence membership applies to evidence artifacts only; ${evidenceID} is a ${evidenceRecord.kind}`,
              { artifactID: evidenceID, kind: evidenceRecord.kind },
            );
          }
          if (
            evidenceRecord.finalized !== true ||
            evidenceRecord.status !== "published"
          ) {
            throw new StoreError(
              "not_ready",
              `Plan evidence membership requires a finalized, published evidence artifact; ${evidenceID} is ${evidenceRecord.status}`,
              { artifactID: evidenceID, status: evidenceRecord.status },
            );
          }
          snapshots.push({
            id: evidenceID,
            description: evidenceRecord.description,
          });
        }
        record.evidence = snapshots;
      }

      return commitMutation(artifactID, record);
    });
  }

  /**
   * Validate and finalize a plan draft. Requires non-empty Goal/Scope,
   * Intended Changes (Checks, Context and evidence stay optional) and
   * validates the flat record. Success makes the draft ready for review (status
   * stays draft); it does not emit delivery or change status.
   */
  async function planFinalize({ artifactID, location, writerSessionID }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertNonEmptyString(
      writerSessionID,
      "writerSessionID",
      MAX_SESSION_LENGTH,
    );

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation, {
        label: "plan artifact",
      });
      if (record.kind !== "plan") {
        throw new StoreError(
          "invalid_kind",
          `Plan finalization applies to plans only; ${artifactID} is a ${record.kind}`,
          { artifactID, kind: record.kind },
        );
      }
      if (record.writerSessionID !== writerSessionID) {
        throw new StoreError(
          "forbidden",
          `Plan finalization is restricted to the writer session (${record.writerSessionID})`,
          { artifactID, writerSessionID: record.writerSessionID },
        );
      }
      for (const required of REQUIRED_PLAN_FIELDS) {
        if (
          typeof record[required] !== "string" ||
          record[required].length === 0
        ) {
          throw new StoreError(
            "validation",
            `Plan finalization requires non-empty ${required}`,
            { artifactID, field: required },
          );
        }
      }
      for (const entry of record.evidence) {
        if (!isArtifactIDListEntry(entry)) {
          throw new StoreError(
            "validation",
            "Plan finalization requires valid evidence membership entries",
            { artifactID },
          );
        }
      }
      record.finalized = true;
      return commitMutation(artifactID, record);
    });
  }

  /** Validate free-form Markdown for a memory mutation. */
  function assertMemoryMarkdown(value, label, { allowEmpty = false } = {}) {
    if (typeof value !== "string")
      throw new StoreError("validation", `${label} must be a string`);
    if (!allowEmpty && value.length === 0)
      throw new StoreError("validation", `${label} must not be empty`);
    if (value.length > MAX_MARKDOWN_LENGTH) {
      throw new StoreError(
        "validation",
        `${label} must be at most ${MAX_MARKDOWN_LENGTH} characters`,
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new StoreError(
        "validation",
        `${label} must not contain control characters`,
      );
    }
  }

  /** Replace the complete session-memory body. */
  async function memoryPut({ artifactID, location, writerSessionID, content }) {
    assertMemoryMarkdown(content, "content", { allowEmpty: true });
    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: ["memory", "checkpoint"],
      });
      record.content = content;
      return commitMutation(artifactID, record);
    });
  }

  /** Append one Markdown block to session memory, separated by a blank line. */
  async function memoryAppend({
    artifactID,
    location,
    writerSessionID,
    content,
  }) {
    assertMemoryMarkdown(content, "content");
    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: ["memory", "checkpoint"],
      });
      const base = record.content.replace(/\s+$/u, "");
      const next = base.length === 0 ? content : `${base}\n\n${content}`;
      if (next.length > MAX_MARKDOWN_LENGTH) {
        throw new StoreError(
          "validation",
          `resulting memory must be at most ${MAX_MARKDOWN_LENGTH} characters`,
          { artifactID },
        );
      }
      record.content = next;
      return commitMutation(artifactID, record);
    });
  }

  /** Replace one exact occurrence in session memory; a stale base is refused. */
  async function memoryPatch({
    artifactID,
    location,
    writerSessionID,
    oldText,
    newText,
  }) {
    assertMemoryMarkdown(oldText, "oldText");
    assertMemoryMarkdown(newText, "newText", { allowEmpty: true });
    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: ["memory", "checkpoint"],
      });
      const first = record.content.indexOf(oldText);
      if (
        first === -1 ||
        record.content.indexOf(oldText, first + oldText.length) !== -1
      ) {
        throw new StoreError(
          "patch_conflict",
          "Memory patch refused: oldText must occur exactly once in the current memory. Re-read the memory and re-base the patch. No write was made.",
          { artifactID },
        );
      }
      const next =
        record.content.slice(0, first) +
        newText +
        record.content.slice(first + oldText.length);
      if (next.length > MAX_MARKDOWN_LENGTH) {
        throw new StoreError(
          "validation",
          `resulting memory must be at most ${MAX_MARKDOWN_LENGTH} characters`,
          { artifactID },
        );
      }
      record.content = next;
      return commitMutation(artifactID, record);
    });
  }

  /** Full memory/checkpoint loader, read-only and kind-locked. */
  async function getMemory({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "memory artifact",
    });
    if (record.kind !== "memory" && record.kind !== "checkpoint") {
      throw new StoreError(
        "invalid_kind",
        `Memory loading applies to memory and checkpoint only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    const content = await readCurrentView(artifactID, record);
    return artifactViewOf(record, content);
  }

  /** Compact memory read used by context injection and the summary tool. */
  async function getMemorySummary({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "memory artifact",
    });
    if (record.kind !== "memory" && record.kind !== "checkpoint") {
      throw new StoreError(
        "invalid_kind",
        `Memory summaries apply to memory and checkpoint only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    return { ...artifactSummaryOf(record), content: record.content };
  }

  /** Project memory for a location, or null when none exists. */
  async function findProjectMemory({ location }) {
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();

    const index = await readIndex(projectMemoryIndexPath);
    if (Object.prototype.hasOwnProperty.call(index, normalizedLocation)) {
      const indexed = index[normalizedLocation];
      if (typeof indexed === "string" && ARTIFACT_ID_PATTERN.test(indexed)) {
        const record = await readRecord(indexed);
        if (
          record &&
          record.kind === "memory" &&
          record.location === normalizedLocation
        ) {
          return artifactViewOf(record, record.content);
        }
      }
    }

    // Missing or stale index (first run after an upgrade): scan once and
    // repair it.
    const names = await readdir(artifactsDir);
    let found = null;
    for (const name of names) {
      if (!ARTIFACT_ID_PATTERN.test(name)) continue;
      const record = await readRecord(name);
      if (
        !record ||
        record.location !== normalizedLocation ||
        record.kind !== "memory"
      )
        continue;
      if (!found || record.updatedAt > found.updatedAt) found = record;
    }
    index[normalizedLocation] = found ? found.id : null;
    await writeIndex(projectMemoryIndexPath, index).catch(() => {});
    return found ? artifactViewOf(found, found.content) : null;
  }

  /** Session checkpoint for a session at a location, or null. */
  async function findCheckpointForSession({ sessionID, location }) {
    assertNonEmptyString(sessionID, "sessionID", MAX_SESSION_LENGTH);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();

    const key = `${normalizedLocation}\u0000${sessionID}`;
    const index = await readIndex(checkpointIndexPath);
    if (Object.prototype.hasOwnProperty.call(index, key)) {
      const indexed = index[key];
      if (typeof indexed === "string" && ARTIFACT_ID_PATTERN.test(indexed)) {
        const record = await readRecord(indexed);
        if (
          record &&
          record.kind === "checkpoint" &&
          record.location === normalizedLocation &&
          record.ownerSessionID === sessionID
        ) {
          return artifactViewOf(record, record.content);
        }
      }
    }

    const names = await readdir(artifactsDir);
    let found = null;
    for (const name of names) {
      if (!ARTIFACT_ID_PATTERN.test(name)) continue;
      const record = await readRecord(name);
      if (
        !record ||
        record.location !== normalizedLocation ||
        record.kind !== "checkpoint" ||
        record.ownerSessionID !== sessionID
      )
        continue;
      if (!found || record.updatedAt > found.updatedAt) found = record;
    }
    index[key] = found ? found.id : null;
    await writeIndex(checkpointIndexPath, index).catch(() => {});
    return found ? artifactViewOf(found, found.content) : null;
  }

  /**
   * Plain-text search over artifact views for one location, so an agent can
   * discover memories and evidence without knowing an ID. Terms are
   * case-insensitive and all must occur somewhere in the document; snippets are
   * the first few lines that contain any term.
   */
  async function artifactSearch({ location, query, kinds, limit = 10 }) {
    const terms = String(query ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    if (terms.length === 0) {
      throw new StoreError("validation", "query must not be empty");
    }
    const allowed =
      Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null;
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const names = await readdir(artifactsDir);
    const results = [];
    for (const name of names) {
      if (!ARTIFACT_ID_PATTERN.test(name)) continue;
      const record = await readRecord(name);
      if (!record || record.location !== normalizedLocation) continue;
      if (allowed && !allowed.has(record.kind)) continue;
      // Search the stored body directly. Rendering the view would run
      // Prettier and may rewrite current.md on a read-only search.
      let text;
      try {
        text = bodyOf(record);
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      const matches = [];
      const lines = text.split("\n");
      for (let index = 0; index < lines.length && matches.length < 3; index++) {
        const line = lines[index].trim();
        if (line.length === 0) continue;
        const lineLower = line.toLowerCase();
        if (!terms.some((term) => lineLower.includes(term))) continue;
        matches.push({
          line: index + 1,
          text: line.length > 220 ? `${line.slice(0, 220)}…` : line,
        });
      }
      results.push({
        id: record.id,
        kind: record.kind,
        title: record.title,
        status: record.status,
        updatedAt: record.updatedAt,
        matches,
      });
    }
    results.sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    );
    return { results: results.slice(0, Math.min(Number(limit) || 10, 25)) };
  }

  /**
   * Set the evidence overview fields (question, Summary, Limitations) in one
   * call. Each provided field replaces that stored field wholesale; an omitted
   * field is untouched. question may be cleared by passing null or an empty
   * string.
   */
  async function evidenceOverviewPut({
    artifactID,
    location,
    writerSessionID,
    question,
    summary,
    limitations,
  }) {
    const provided = { question, summary, limitations };
    const hasAny = Object.values(provided).some((value) => value !== undefined);
    if (!hasAny) {
      throw new StoreError(
        "validation",
        "evidence overview requires at least one of question, summary, limitations",
      );
    }
    if (
      question !== undefined &&
      question !== null &&
      typeof question !== "string"
    ) {
      throw new StoreError("validation", "question must be a string or null");
    }
    for (const [key, value] of Object.entries({ summary, limitations })) {
      if (value !== undefined && typeof value !== "string") {
        throw new StoreError(
          "validation",
          `${key} must be a string when provided`,
        );
      }
      if (typeof value === "string" && value.length > MAX_MARKDOWN_LENGTH) {
        throw new StoreError(
          "validation",
          `${key} must be at most ${MAX_MARKDOWN_LENGTH} characters`,
        );
      }
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "evidence",
      });
      if (question !== undefined) {
        const trimmed = typeof question === "string" ? question.trim() : "";
        record.question = trimmed.length > 0 ? trimmed : null;
      }
      if (summary !== undefined) record.summary = summary;
      if (limitations !== undefined) record.limitations = limitations;
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Append (no findingID) or replace in place (findingID) one detailed evidence
   * finding. Findings keep stable IDs; replacing an unknown supplied ID is
   * not_found.
   */
  async function evidenceFindingPut({
    artifactID,
    location,
    writerSessionID,
    findingID,
    title,
    content,
  }) {
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new StoreError(
        "validation",
        "finding title must be a non-empty string",
      );
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new StoreError(
        "validation",
        `finding title must be at most ${MAX_TITLE_LENGTH} characters`,
      );
    }
    assertProseField(content, "finding content");
    if (findingID !== undefined && findingID !== null) {
      if (
        typeof findingID !== "string" ||
        !FINDING_ID_PATTERN.test(findingID)
      ) {
        throw new StoreError(
          "validation",
          `findingID must match ${FINDING_ID_PATTERN}`,
        );
      }
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "evidence",
      });
      const base = { title: title.trim(), content };
      let targetID = findingID;
      if (targetID) {
        const existing = record.findings.find(
          (candidate) => candidate.id === targetID,
        );
        if (!existing) {
          throw new StoreError(
            "not_found",
            `No evidence finding with ID ${targetID}`,
            { artifactID, findingID: targetID },
          );
        }
        const position = record.findings.findIndex(
          (candidate) => candidate.id === targetID,
        );
        record.findings[position] = { id: targetID, ...base };
      } else {
        targetID = newFindingID();
        record.findings.push({ id: targetID, ...base });
      }
      const summary = await commitMutation(artifactID, record);
      return { ...summary, findingID: targetID };
    });
  }

  /** Remove one evidence finding by stable ID. */
  async function evidenceFindingRemove({
    artifactID,
    location,
    writerSessionID,
    findingID,
  }) {
    if (typeof findingID !== "string" || !FINDING_ID_PATTERN.test(findingID)) {
      throw new StoreError(
        "validation",
        `findingID must match ${FINDING_ID_PATTERN}`,
      );
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "evidence",
      });
      const position = record.findings.findIndex(
        (candidate) => candidate.id === findingID,
      );
      if (position === -1) {
        throw new StoreError(
          "not_found",
          `No evidence finding with ID ${findingID}`,
          { artifactID, findingID },
        );
      }
      record.findings.splice(position, 1);
      const summary = await commitMutation(artifactID, record);
      return { ...summary, findingID };
    });
  }

  /**
   * Finalize an evidence draft: requires a Summary, Limitations, or at least
   * one finding with content, and transitions the visible status from draft to
   * published. Publishability is the editor's mark-read gate; the record remains
   * editable (a later content mutation returns it to draft).
   */
  async function evidenceFinalize({
    artifactID,
    location,
    writerSessionID,
    question,
    summary,
    limitations,
  }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertNonEmptyString(
      writerSessionID,
      "writerSessionID",
      MAX_SESSION_LENGTH,
    );
    if (
      question !== undefined &&
      question !== null &&
      typeof question !== "string"
    ) {
      throw new StoreError("validation", "question must be a string or null");
    }
    if (summary !== undefined)
      assertMemoryMarkdown(summary, "summary", { allowEmpty: true });
    if (limitations !== undefined)
      assertMemoryMarkdown(limitations, "limitations", { allowEmpty: true });

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation, {
        label: "evidence artifact",
      });
      if (record.kind !== "evidence") {
        throw new StoreError(
          "invalid_kind",
          `Evidence finalization applies to evidence only; ${artifactID} is a ${record.kind}`,
          { artifactID, kind: record.kind },
        );
      }
      if (record.writerSessionID !== writerSessionID) {
        throw new StoreError(
          "forbidden",
          `Evidence finalization is restricted to the writer session (${record.writerSessionID})`,
          { artifactID, writerSessionID: record.writerSessionID },
        );
      }
      if (question !== undefined) {
        const trimmed = typeof question === "string" ? question.trim() : "";
        record.question = trimmed.length > 0 ? trimmed : null;
      }
      if (summary !== undefined) record.summary = summary;
      if (limitations !== undefined) record.limitations = limitations;
      const hasUsefulContent =
        record.summary.length > 0 ||
        record.limitations.length > 0 ||
        record.findings.some((finding) => finding.content.length > 0);
      if (!hasUsefulContent) {
        throw new StoreError(
          "validation",
          "Evidence finalization requires a Summary, Limitations, or at least one finding",
          { artifactID },
        );
      }
      for (const finding of record.findings) {
        if (
          typeof finding.title !== "string" ||
          finding.title.length === 0 ||
          typeof finding.content !== "string" ||
          finding.content.length === 0
        ) {
          throw new StoreError(
            "validation",
            "Evidence finalization requires complete findings",
            { artifactID },
          );
        }
      }
      record.finalized = true;
      record.status = "published";
      record.readAt = null;
      return commitMutation(artifactID, record);
    });
  }

  /** Set the machine-readable review outcome (Pass, Changes required, or Blocked). */
  async function reviewOutcomePut({
    artifactID,
    location,
    writerSessionID,
    outcome,
  }) {
    if (!REVIEW_OUTCOMES.includes(outcome)) {
      throw new StoreError(
        "validation",
        "outcome must be Pass, Changes required, or Blocked",
        { outcome },
      );
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "review",
      });
      record.outcome = outcome;
      return commitMutation(artifactID, record);
    });
  }

  /** Set the human-readable review Summary (may be multi-line Markdown). */
  async function reviewSummaryPut({
    artifactID,
    location,
    writerSessionID,
    content,
  }) {
    assertProseField(content, "summary content");

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "review",
      });
      record.summary = content;
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Set the machine-readable outcome and/or the human Summary in one locked
   * commit. Omitted fields are untouched.
   */
  async function reviewUpdate({
    artifactID,
    location,
    writerSessionID,
    outcome,
    summary,
  }) {
    const hasOutcome = outcome !== undefined;
    const hasSummary = summary !== undefined;
    if (!hasOutcome && !hasSummary) {
      throw new StoreError(
        "validation",
        "review update requires outcome, summary, or both",
      );
    }
    if (hasOutcome && !REVIEW_OUTCOMES.includes(outcome)) {
      throw new StoreError(
        "validation",
        "outcome must be Pass, Changes required, or Blocked",
        { outcome },
      );
    }
    if (hasSummary) assertProseField(summary, "summary content");

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "review",
      });
      if (hasOutcome) record.outcome = outcome;
      if (hasSummary) record.summary = summary;
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Append (no findingID) or replace in place (findingID) one structured review
   * finding. Each finding carries severity, affected path/symbol, evidence,
   * risk, and correction; repeating fields stay addressable by stable ID.
   */
  async function reviewFindingPut({
    artifactID,
    location,
    writerSessionID,
    findingID,
    title,
    severity,
    affected,
    evidence,
    risk,
    correction,
  }) {
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new StoreError(
        "validation",
        "finding title must be a non-empty string",
      );
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new StoreError(
        "validation",
        `finding title must be at most ${MAX_TITLE_LENGTH} characters`,
      );
    }
    if (typeof severity !== "string" || severity.trim().length === 0) {
      throw new StoreError(
        "validation",
        "finding severity must be a non-empty string",
      );
    }
    if (typeof correction !== "string" || correction.trim().length === 0) {
      throw new StoreError(
        "validation",
        "finding correction must be a non-empty string",
      );
    }
    for (const [key, value] of Object.entries({ affected, evidence, risk })) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new StoreError(
          "validation",
          `finding ${key} must be a string when provided`,
        );
      }
    }
    if (findingID !== undefined && findingID !== null) {
      if (
        typeof findingID !== "string" ||
        !FINDING_ID_PATTERN.test(findingID)
      ) {
        throw new StoreError(
          "validation",
          `findingID must match ${FINDING_ID_PATTERN}`,
        );
      }
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "review",
      });
      const base = {
        title: title.trim(),
        severity: severity.trim(),
        affected: typeof affected === "string" ? affected : "",
        evidence: typeof evidence === "string" ? evidence : "",
        risk: typeof risk === "string" ? risk : "",
        correction: correction.trim(),
      };
      let targetID = findingID;
      if (targetID) {
        const existing = record.findings.find(
          (candidate) => candidate.id === targetID,
        );
        if (!existing) {
          throw new StoreError(
            "not_found",
            `No review finding with ID ${targetID}`,
            { artifactID, findingID: targetID },
          );
        }
        const position = record.findings.findIndex(
          (candidate) => candidate.id === targetID,
        );
        record.findings[position] = { id: targetID, ...base };
      } else {
        targetID = newFindingID();
        record.findings.push({ id: targetID, ...base });
      }
      const summary = await commitMutation(artifactID, record);
      return { ...summary, findingID: targetID };
    });
  }

  /** Remove one review finding by stable ID. */
  async function reviewFindingRemove({
    artifactID,
    location,
    writerSessionID,
    findingID,
  }) {
    if (typeof findingID !== "string" || !FINDING_ID_PATTERN.test(findingID)) {
      throw new StoreError(
        "validation",
        `findingID must match ${FINDING_ID_PATTERN}`,
      );
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "review",
      });
      const position = record.findings.findIndex(
        (candidate) => candidate.id === findingID,
      );
      if (position === -1) {
        throw new StoreError(
          "not_found",
          `No review finding with ID ${findingID}`,
          { artifactID, findingID },
        );
      }
      record.findings.splice(position, 1);
      const summary = await commitMutation(artifactID, record);
      return { ...summary, findingID };
    });
  }

  /**
   * Finalize a review: requires the machine-readable outcome and the
   * human-readable Summary. Transitions the visible draft to published; the
   * content remains editable (a later content mutation returns it to draft).
   */
  async function reviewFinalize({
    artifactID,
    location,
    writerSessionID,
    outcome,
    summary,
  }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertNonEmptyString(
      writerSessionID,
      "writerSessionID",
      MAX_SESSION_LENGTH,
    );
    if (
      outcome !== undefined &&
      outcome !== null &&
      !REVIEW_OUTCOMES.includes(outcome)
    ) {
      throw new StoreError(
        "validation",
        `outcome must be one of ${REVIEW_OUTCOMES.join(", ")}`,
        { outcome },
      );
    }
    if (summary !== undefined) assertProseField(summary, "summary");

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation, {
        label: "review artifact",
      });
      if (record.kind !== "review") {
        throw new StoreError(
          "invalid_kind",
          `Review finalization applies to reviews only; ${artifactID} is a ${record.kind}`,
          { artifactID, kind: record.kind },
        );
      }
      if (record.writerSessionID !== writerSessionID) {
        throw new StoreError(
          "forbidden",
          `Review finalization is restricted to the writer session (${record.writerSessionID})`,
          { artifactID, writerSessionID: record.writerSessionID },
        );
      }
      if (outcome !== undefined) record.outcome = outcome;
      if (summary !== undefined) record.summary = summary;
      if (!REVIEW_OUTCOMES.includes(record.outcome)) {
        throw new StoreError(
          "validation",
          "Review finalization requires an outcome (Pass, Changes required, or Blocked)",
          { artifactID },
        );
      }
      if (typeof record.summary !== "string" || record.summary.length === 0) {
        throw new StoreError(
          "validation",
          "Review finalization requires a Summary",
          { artifactID },
        );
      }
      record.finalized = true;
      record.status = "published";
      record.readAt = null;
      return commitMutation(artifactID, record);
    });
  }

  /** Replace one whole report prose section (summary, changed, checks, unfinished). */
  async function reportContentPut({
    artifactID,
    location,
    writerSessionID,
    section,
    content,
  }) {
    if (!REPORT_SECTIONS.includes(section)) {
      throw new StoreError(
        "validation",
        "section must be one of summary, changed, checks, unfinished",
        { section },
      );
    }
    assertProseField(content, "content");

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "report",
      });
      record[section] = content;
      return commitMutation(artifactID, record);
    });
  }

  /** Clear one whole report prose section back to empty. */
  async function reportContentRemove({
    artifactID,
    location,
    writerSessionID,
    section,
  }) {
    if (!REPORT_SECTIONS.includes(section)) {
      throw new StoreError(
        "validation",
        "section must be one of summary, changed, checks, unfinished",
        { section },
      );
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "report",
      });
      record[section] = "";
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Replace any subset of report sections in one locked commit. An empty string
   * clears that section. Omitted sections are untouched.
   */
  async function reportUpdate({
    artifactID,
    location,
    writerSessionID,
    sections,
  }) {
    if (
      sections === null ||
      typeof sections !== "object" ||
      Array.isArray(sections)
    ) {
      throw new StoreError("validation", "sections must be an object");
    }
    const provided = Object.entries(sections).filter(
      ([, value]) => value !== undefined,
    );
    if (provided.length === 0) {
      throw new StoreError(
        "validation",
        "report update requires at least one section",
      );
    }
    for (const [field, value] of provided) {
      if (!REPORT_SECTIONS.includes(field)) {
        throw new StoreError(
          "validation",
          `section must be one of ${REPORT_SECTIONS.join(", ")}`,
          { section: field },
        );
      }
      if (typeof value !== "string") {
        throw new StoreError(
          "validation",
          `report ${field} must be a string`,
        );
      }
      assertMemoryMarkdown(value, field, { allowEmpty: true });
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await prepareContentMutation({
        artifactID,
        location,
        writerSessionID,
        expectKind: "report",
      });
      for (const [field, value] of provided) {
        record[field] = value;
      }
      return commitMutation(artifactID, record);
    });
  }

  /**
   * Finalize a report: requires the Summary and transitions the visible status
   * from draft to published, which is what lets the editor mark it read/dismiss
   * it and the primary agent and Review consume it.
   */
  async function reportFinalize({
    artifactID,
    location,
    writerSessionID,
    summary,
    changed,
    checks,
    unfinished,
  }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertNonEmptyString(
      writerSessionID,
      "writerSessionID",
      MAX_SESSION_LENGTH,
    );
    const providedSections = { summary, changed, checks, unfinished };
    for (const [field, value] of Object.entries(providedSections)) {
      if (value !== undefined)
        assertMemoryMarkdown(value, field, { allowEmpty: true });
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation, {
        label: "report artifact",
      });
      if (record.kind !== "report") {
        throw new StoreError(
          "invalid_kind",
          `Report finalization applies to reports only; ${artifactID} is a ${record.kind}`,
          { artifactID, kind: record.kind },
        );
      }
      if (record.writerSessionID !== writerSessionID) {
        throw new StoreError(
          "forbidden",
          `Report finalization is restricted to the writer session (${record.writerSessionID})`,
          { artifactID, writerSessionID: record.writerSessionID },
        );
      }
      for (const [field, value] of Object.entries(providedSections)) {
        if (value !== undefined) record[field] = value;
      }
      if (typeof record.summary !== "string" || record.summary.length === 0) {
        throw new StoreError(
          "validation",
          "Report finalization requires a Summary",
          { artifactID },
        );
      }
      record.finalized = true;
      record.status = "published";
      record.readAt = null;
      return commitMutation(artifactID, record);
    });
  }

  /** Every visible artifact for the location; record metadata only. */
  async function listArtifacts({ location }) {
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const names = await readdir(artifactsDir);
    const summaries = [];
    for (const name of names) {
      if (!ARTIFACT_ID_PATTERN.test(name)) continue;
      const record = await readRecord(name);
      if (!record || record.location !== normalizedLocation) continue;
      summaries.push(artifactSummaryOf(record));
    }
    summaries.sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    );
    return summaries;
  }

  /** The latest view of one artifact, addressed by ID only. */
  async function getArtifact({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "artifact",
    });
    const content = await readCurrentView(artifactID, record);
    return artifactViewOf(record, content);
  }

  /**
   * Metadata-only lookup for compact readers: the summary shape
   * without rendering or reconciling the generated view and without returning
   * the body content.
   */
  async function getArtifactMetadata({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "artifact",
    });
    return artifactSummaryOf(record);
  }

  /**
   * Read-only structural IDs for the full load tools: ordered machine IDs that
   * stay out of the rendered Markdown but remain available to the authoring
   * worker. Returns `undefined` fields for kinds that do not carry that
   * structure. Finding IDs never enter the primary-agent context or rendered Markdown.
   */
  async function getArtifactStructure({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "artifact",
    });
    if (record.kind === "plan") {
      return { evidence: record.evidence.map((entry) => entry.id) };
    }
    if (record.kind === "evidence") {
      return {
        findings: record.findings.map((finding) => ({
          id: finding.id,
          title: finding.title,
        })),
      };
    }
    if (record.kind === "review") {
      return {
        outcome: record.outcome,
        findings: record.findings.map((finding) => ({
          id: finding.id,
          title: finding.title,
        })),
      };
    }
    return { planArtifactID: record.planArtifactID };
  }

  /**
   * Load any plan by ID with its full generated view inline, regardless of
   * status. Plans are working documents; implementation reads them directly
   * rather than waiting for an approval gate.
   */
  async function getPlan({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "plan artifact",
    });
    if (record.kind !== "plan") {
      throw new StoreError(
        "invalid_kind",
        `Plan loading applies to plans only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    const content = await readCurrentView(artifactID, record);
    return artifactViewOf(record, content);
  }

  /**
   * Evidence loader for the primary agent and Review: full content inline, exclusively for
   * kind=evidence (any status; state-neutral — evidence_load never marks read
   * and never mutates the record). Plan/review/report IDs are rejected with
   * invalid_kind, so the loader can never be used to read plan
   * bodies or bodies of another kind.
   */
  async function getEvidence({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "evidence artifact",
    });
    if (record.kind !== "evidence") {
      throw new StoreError(
        "invalid_kind",
        `Evidence loading applies to evidence only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    const content = await readCurrentView(artifactID, record);
    return artifactViewOf(record, content);
  }

  /**
   * Review loader for follow-up corrections: full content inline, read-only and
   * kind-locked to review. The primary agent reads the finalized Review by ID to
   * apply correction work; this never marks the review read.
   */
  async function getReview({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "review artifact",
    });
    if (record.kind !== "review") {
      throw new StoreError(
        "invalid_kind",
        `Review loading applies to reviews only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    const content = await readCurrentView(artifactID, record);
    return artifactViewOf(record, content);
  }

  /**
   * Report loader for Review: full content inline, read-only and kind-locked to
   * report. Review receives only the Report ID and uses report_load to recover
   * the linked plan (via planArtifactID) and its evidence.
   */
  async function getReport({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "report artifact",
    });
    if (record.kind !== "report") {
      throw new StoreError(
        "invalid_kind",
        `Report loading applies to reports only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    const content = await readCurrentView(artifactID, record);
    return artifactViewOf(record, content);
  }

  /**
   * primary agent summary read for evidence: compact overview fields (question,
   * Summary, Limitations) with NO detailed findings. The full body stays
   * available only to the primary agent and Review via getEvidence.
   */
  async function getEvidenceSummary({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "evidence artifact",
    });
    if (record.kind !== "evidence") {
      throw new StoreError(
        "invalid_kind",
        `Evidence summaries apply to evidence only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    return {
      ...artifactSummaryOf(record),
      question: record.question,
      summary: record.summary,
      limitations: record.limitations,
    };
  }

  /**
   * primary agent summary read for review: compact outcome + human Summary with NO
   * detailed findings. The full body stays available to the primary agent via getReview.
   */
  async function getReviewSummary({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "review artifact",
    });
    if (record.kind !== "review") {
      throw new StoreError(
        "invalid_kind",
        `Review summaries apply to reviews only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    return {
      ...artifactSummaryOf(record),
      outcome: record.outcome,
      summary: record.summary,
    };
  }

  /**
   * primary agent summary read for report: compact metadata plus status and the
   * linked plan + Summary, with NO Changed/Checks/Unfinished detail. The full
   * report stays available to Review via getReport.
   */
  async function getReportSummary({ artifactID, location }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    await ensureDirectories();
    const record = await loadScoped(artifactID, normalizedLocation, {
      label: "report artifact",
    });
    if (record.kind !== "report") {
      throw new StoreError(
        "invalid_kind",
        `Report summaries apply to reports only; ${artifactID} is a ${record.kind}`,
        {
          artifactID,
          kind: record.kind,
        },
      );
    }
    return {
      ...artifactSummaryOf(record),
      planArtifactID: record.planArtifactID,
      summary: record.summary,
    };
  }

  /**
   * Feedback core. Byte limits are enforced before anything is recorded and
   * request IDs deduplicate. The explicit `recipient` ("owner" or "writer",
   * defaulting to "owner") selects which stored session identity receives the
   * notification and is recorded with the submission so a later delivery is
   * unambiguous.
   */
  async function addArtifactFeedback({
    artifactID,
    location,
    requestID,
    question,
    selectedText,
    selectedRange,
    recipient,
  }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertRequestID(requestID);
    const validatedRecipient = recipient === "writer" ? "writer" : "owner";
    const hasQuestion =
      typeof question === "string" && question.trim().length > 0;
    const hasSelection =
      typeof selectedText === "string" && selectedText.length > 0;
    if (!hasQuestion && !hasSelection) {
      throw new StoreError(
        "validation",
        "feedback requires a question or a selected excerpt",
      );
    }
    if (
      hasQuestion &&
      Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES
    ) {
      throw new StoreError(
        "validation",
        `question must be at most ${MAX_QUESTION_BYTES} UTF-8 bytes`,
        {
          limit: MAX_QUESTION_BYTES,
        },
      );
    }
    if (
      hasSelection &&
      Buffer.byteLength(selectedText, "utf8") > MAX_SELECTION_BYTES
    ) {
      throw new StoreError(
        "validation",
        `selectedText must be at most ${MAX_SELECTION_BYTES} UTF-8 bytes`,
        {
          limit: MAX_SELECTION_BYTES,
        },
      );
    }
    if (
      selectedText !== undefined &&
      selectedText !== null &&
      typeof selectedText !== "string"
    ) {
      throw new StoreError(
        "validation",
        "selectedText must be a string when provided",
      );
    }
    if (selectedRange !== undefined && selectedRange !== null) {
      if (
        !selectedRange ||
        typeof selectedRange !== "object" ||
        typeof selectedRange.start !== "number" ||
        typeof selectedRange.end !== "number"
      ) {
        throw new StoreError(
          "validation",
          "selectedRange must be {start, end} line numbers when provided",
        );
      }
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation);
      const existing = record.feedback.find(
        (entry) => entry.requestID === requestID,
      );
      if (existing) {
        return {
          requestID,
          deduplicated: true,
          delivery: existing.delivery,
          feedback: existing,
          artifact: artifactSummaryOf(record),
        };
      }
      const createdAt = nowISO();
      const entry = {
        requestID,
        recipient: validatedRecipient,
        question: hasQuestion ? question : null,
        selectedText: hasSelection ? selectedText : null,
        selectedRange: hasSelection && selectedRange ? selectedRange : null,
        delivery: freshDelivery(),
        createdAt,
      };
      record.feedback.push(entry);
      record.updatedAt = createdAt;
      await writeFileAtomic(
        recordPathOf(artifactID),
        serializeRecord(record),
        FILE_MODE,
      );
      return {
        requestID,
        deduplicated: false,
        delivery: entry.delivery,
        feedback: entry,
        artifact: artifactSummaryOf(record),
      };
    });
  }

  /**
   * Approval core. PLAN-ONLY: approval is an optional review marker, not an
   * implementation gate. An edited plan returns to draft for re-review. Only a finalized plan can be marked reviewed: incomplete
   * drafts are rejected with not_ready before the gate can be reached.
   * Evidence, reviews, and reports are marked read via markArtifactRead, never
   * approved. An existing approval is the recorded decision and is never
   * replaced; a repeated approval returns it.
   */
  async function approveArtifact({ artifactID, location, requestID }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertRequestID(requestID);

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation);
      if (record.kind !== "plan") {
        throw new StoreError(
          "invalid_kind",
          `Approval applies to plans only; ${artifactID} is a ${record.kind}. Evidence, reviews, and reports use mark-read.`,
          { artifactID, kind: record.kind },
        );
      }
      if (record.approval) {
        return {
          requestID: record.approval.requestID,
          deduplicated: true,
          delivery: record.approval.delivery,
          approval: record.approval,
          artifact: artifactSummaryOf(record),
        };
      }
      if (record.finalized !== true || record.status !== "draft") {
        throw new StoreError(
          "not_ready",
          `Plan ${artifactID} is not ready for approval (finalized=${record.finalized}, status=${record.status}); finalize it first`,
          { artifactID, status: record.status, finalized: record.finalized },
        );
      }
      const createdAt = nowISO();
      const approval = { requestID, delivery: freshDelivery(), createdAt };
      record.approval = approval;
      record.status = "approved";
      record.updatedAt = createdAt;
      await writeCurrentView(artifactID, record);
      await writeFileAtomic(
        recordPathOf(artifactID),
        serializeRecord(record),
        FILE_MODE,
      );
      return {
        requestID,
        deduplicated: false,
        delivery: approval.delivery,
        approval,
        artifact: artifactSummaryOf(record),
      };
    });
  }

  /**
   * Mark-read core. EVIDENCE/REVIEW/REPORT/MEMORY (never plans): the editor's
   * dismissal of a finalized evidence, review, or report artifact. There is NO
   * approval record and NO delivery bookkeeping; the record carries only a
   * `readAt` marker and the status becomes `read`. A repeated mark-read with a
   * different request ID deduplicates like approval; a content mutation returns
   * the item to draft.
   */
  async function markArtifactRead({ artifactID, location, requestID }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertRequestID(requestID);

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation);
      if (record.kind === "plan") {
        throw new StoreError(
          "invalid_kind",
          `Mark-read applies to evidence, reviews, reports, and memory; ${artifactID} is a plan. Plans use approve_plan.`,
          { artifactID, kind: record.kind },
        );
      }
      if (record.readAt) {
        return {
          requestID: record.readAt.requestID,
          deduplicated: true,
          readAt: record.readAt,
          artifact: artifactSummaryOf(record),
        };
      }
      const createdAt = nowISO();
      const readAt = { requestID, readAt: createdAt };
      record.readAt = readAt;
      record.status = "read";
      record.updatedAt = createdAt;
      await writeCurrentView(artifactID, record);
      await writeFileAtomic(
        recordPathOf(artifactID),
        serializeRecord(record),
        FILE_MODE,
      );
      return {
        requestID,
        deduplicated: false,
        readAt,
        artifact: artifactSummaryOf(record),
      };
    });
  }

  /**
   * Delivery bookkeeping. The submission type is explicit: `kind` is
   * "feedback" or "approval", and the entry is looked up in exactly that
   * record section. request IDs deduplicate per submission type, so the same
   * request ID may legally exist in both feedback and approval; the explicit
   * kind prevents marking the wrong delivery record. The recorded decision is
   * never altered by delivery bookkeeping: a failed notification keeps the
   * decision and can be retried explicitly with the same requestID.
   */
  async function markArtifactDelivery({
    artifactID,
    location,
    requestID,
    kind,
    state,
    error,
  }) {
    assertArtifactID(artifactID);
    const normalizedLocation = normalizeLocation(location);
    assertRequestID(requestID);
    if (kind !== "feedback" && kind !== "approval") {
      throw new StoreError(
        "validation",
        "delivery kind must be feedback or approval",
        { kind },
      );
    }
    if (state !== "pending" && state !== "delivered" && state !== "failed") {
      throw new StoreError(
        "validation",
        "delivery state must be pending, delivered, or failed",
      );
    }

    await ensureDirectories();
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation);
      let entry;
      if (kind === "approval") {
        entry =
          record.approval && record.approval.requestID === requestID
            ? record.approval
            : undefined;
      } else {
        entry = record.feedback.find(
          (candidate) => candidate.requestID === requestID,
        );
      }
      if (!entry) {
        throw new StoreError(
          "not_found",
          `No ${kind} submission with request ID ${requestID}`,
          {
            requestID,
            kind,
          },
        );
      }
      const now = nowISO();
      entry.delivery.state = state;
      entry.delivery.attemptedAt = now;
      if (state === "delivered") {
        entry.delivery.deliveredAt = now;
        entry.delivery.error = null;
      } else if (state === "failed") {
        entry.delivery.error =
          typeof error === "string" && error.length > 0
            ? error.slice(0, 500)
            : "delivery failed";
      }
      record.updatedAt = now;
      await writeFileAtomic(
        recordPathOf(artifactID),
        serializeRecord(record),
        FILE_MODE,
      );
      return {
        requestID,
        kind,
        delivery: entry.delivery,
        artifact: artifactSummaryOf(record),
      };
    });
  }

  return {
    root,
    createArtifact,
    memoryPut,
    memoryAppend,
    memoryPatch,
    getMemory,
    getMemorySummary,
    findProjectMemory,
    findCheckpointForSession,
    artifactSearch,
    planFieldSet,
    planFieldPatch,
    planEvidenceAddMany,
    planEvidenceRemove,
    planUpdate,
    planFinalize,
    evidenceOverviewPut,
    evidenceFindingPut,
    evidenceFindingRemove,
    evidenceFinalize,
    reviewOutcomePut,
    reviewSummaryPut,
    reviewUpdate,
    reviewFindingPut,
    reviewFindingRemove,
    reviewFinalize,
    reportContentPut,
    reportContentRemove,
    reportUpdate,
    reportFinalize,
    listArtifacts,
    getArtifact,
    getArtifactMetadata,
    getArtifactStructure,
    getPlan,
    getEvidence,
    getReview,
    getReport,
    getEvidenceSummary,
    getReviewSummary,
    getReportSummary,
    addArtifactFeedback,
    approveArtifact,
    markArtifactRead,
    markArtifactDelivery,
  };
}
