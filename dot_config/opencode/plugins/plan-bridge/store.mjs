// Plan-bridge registry: a Node-compatible, filesystem-backed store for
// Markdown artifacts exchanged between sessions and the Neovim client.
//
// Two document formats share one registry (same root, same artifacts/
// directory):
//
// - shared-markdown-v1 (`art_` IDs): the frontmatter format in ./format.mjs,
//   kinds plan|evidence|review, owner = Planner session, per-revision author
//   provenance, and lean history metadata that references immutable snapshot
//   files instead of embedding content. Served by `artifact_publish/get/patch`
//   and `personal.artifacts`.
// - raw-markdown (`pln_` IDs): Markdown with no frontmatter, revision hashed
//   over the exact raw bytes, history entries embedding full content. Read-only:
//   the generic reads below expose these documents and never rewrite them.
//
// Authority: a record-only `authority` field distinguishes plans that authorize
// Builder once approved ("implementation") from records that do not
// ("historical", the default when the field is absent). It is never part of the
// Markdown frontmatter or the content hash, and patch, feedback, and approval
// never accept or change it from callers or file bytes.
//
// Design rules:
// - All paths are derived internally from the store root plus generated IDs;
//   callers never supply filesystem paths.
// - Every lookup is scoped to the location recorded on the artifact; a
//   mismatched location is reported as not found so existence never leaks
//   across locations.
// - record.json inside each artifact directory is the authoritative registry
//   record. It is replaced atomically (temp file + rename) and is always the
//   last file written by a mutation. Derived files (current.md, snapshots)
//   are written first, so an interrupted write is reconciled from the record:
//   raw-markdown records recreate them from embedded history content, and
//   shared-markdown-v1 regenerates current.md from the committed snapshot and
//   lifecycle state. A missing snapshot is unrecoverable data loss and fails
//   visibly; the store never fabricates content.
// - Mutations serialize on an exclusive per-artifact lock file. An existing
//   lock is reported (lock_conflict), never silently bypassed. A lock left by
//   a crashed process is stale-lock recoverable by hand (remove the file);
//   the next mutation reconciles derived files from the record, so no record
//   is discarded.
// - Pure Node (node:*) so `node --test` can exercise it without Bun.

import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path"

import {
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  canonicalRevision,
  documentRevision,
  parseDocument,
  serializeDocument,
} from "./format.mjs"

/** Record version of raw-markdown documents. */
const SCHEMA_VERSION = 1
/** Registry record schema version of shared artifacts. */
const SCHEMA_VERSION_SHARED = 2

/**
 * Record-only authority values. `implementation` plans authorize Builder
 * after approval; `historical` plans are freezes only. Absent fields never
 * authorize and read as `historical`.
 */
const AUTHORITY_HISTORICAL = "historical"
const AUTHORITY_IMPLEMENTATION = "implementation"
const AUTHORITIES = [AUTHORITY_HISTORICAL, AUTHORITY_IMPLEMENTATION]

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const SNAPSHOT_MODE = 0o400

const RAW_ID_PATTERN = /^pln_[A-Za-z0-9_-]{8,64}$/
const SHARED_ID_PATTERN = /^art_[A-Za-z0-9_-]{8,64}$/
const ARTIFACT_ID_PATTERN = /^(pln|art)_[A-Za-z0-9_-]{8,64}$/
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/

const MAX_MARKDOWN_LENGTH = 2_000_000
const MAX_TITLE_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_SESSION_LENGTH = 128
/** Feedback question limit (UTF-8 bytes). */
const MAX_QUESTION_BYTES = 16 * 1024
/** User-selected excerpt limit (UTF-8 bytes). */
const MAX_SELECTION_BYTES = 64 * 1024

/** Format marker of raw-markdown files: raw Markdown, no frontmatter. */
const ARTIFACT_FORMAT_RAW = "raw-markdown"
/** Format marker of shared-markdown-v1 files: see ./format.mjs. */
const ARTIFACT_FORMAT_SHARED = "shared-markdown-v1"

/** Error with a stable machine-readable code used by tools and RPC handlers. */
export class StoreError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = "StoreError"
    this.code = code
    this.data = data
  }
}

/** Default registry root: $XDG_STATE_HOME/opencode/plan-bridge or ~/.local/state/opencode/plan-bridge. */
export function defaultStateRoot() {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(base, "opencode", "plan-bridge")
}

/**
 * Revision identity of a raw-markdown document: derived from the exact
 * UTF-8 Markdown contents. Shared artifacts use the canonical revision from
 * ./format.mjs instead.
 */
export function revisionID(content) {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex")
}

function newSharedArtifactID() {
  return "art_" + randomBytes(16).toString("base64url")
}

function nowISO() {
  return new Date().toISOString()
}

function freshDelivery() {
  return { state: "pending", attemptedAt: null, deliveredAt: null, error: null }
}

function assertNonEmptyString(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreError("validation", `${label} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new StoreError("validation", `${label} must be at most ${maxLength} characters`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new StoreError("validation", `${label} must not contain control characters`)
  }
}

function normalizeLocation(location) {
  if (typeof location !== "string" || location.length === 0) {
    throw new StoreError("validation", "location must be a non-empty directory path")
  }
  if (!isAbsolute(location)) {
    throw new StoreError("validation", `location must be an absolute directory path, got ${JSON.stringify(location)}`)
  }
  return resolvePath(location)
}

function assertArtifactID(artifactID) {
  if (typeof artifactID !== "string" || !ARTIFACT_ID_PATTERN.test(artifactID)) {
    throw new StoreError("validation", `artifactID must match ${ARTIFACT_ID_PATTERN}`)
  }
}

function assertRevision(revision) {
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    throw new StoreError("validation", `revision must match ${REVISION_PATTERN}`)
  }
}

function assertRequestID(requestID) {
  if (typeof requestID !== "string" || !REQUEST_ID_PATTERN.test(requestID)) {
    throw new StoreError("validation", `requestID must match ${REQUEST_ID_PATTERN}`)
  }
}

function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + 1)
  }
  return count
}

function serializeRecord(record) {
  return JSON.stringify(record, null, 2) + "\n"
}

/**
 * The seven identity/descriptive header fields of a shared artifact, keyed
 * exactly as in ./format.mjs. These (plus the body) are the content revision
 * hash input; updated_at and status are excluded.
 */
function sharedIdentity({ id, kind, title, description, ownerSessionID, authorSessionID, createdAt }) {
  return {
    id,
    kind,
    title,
    description,
    owner_session_id: ownerSessionID,
    author_session_id: authorSessionID,
    created_at: createdAt,
  }
}

function sharedHeaderOf(record, authorSessionID, updatedAt, status) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    description: record.description,
    owner_session_id: record.ownerSessionID,
    author_session_id: authorSessionID,
    created_at: record.createdAt,
    updated_at: updatedAt,
    status,
  }
}

/** Authority of a record: absent fields never authorize and read as historical. */
function authorityOf(record) {
  return record.authority === AUTHORITY_IMPLEMENTATION ? AUTHORITY_IMPLEMENTATION : AUTHORITY_HISTORICAL
}

/**
 * Create a registry bound to `root` (defaults to the shared state root).
 * `root` is store configuration (tests point it at a fixture directory);
 * artifact paths are still always derived internally, never caller-supplied.
 */
export function createStore(options = {}) {
  if (options.root !== undefined && (typeof options.root !== "string" || options.root.length === 0)) {
    throw new StoreError("validation", "store root must be a non-empty string when provided")
  }
  const root = resolvePath(options.root ?? defaultStateRoot())
  const artifactsDir = join(root, "artifacts")
  let ensured = false

  function artifactDirOf(artifactID) {
    return join(artifactsDir, artifactID)
  }
  function recordPathOf(artifactID) {
    return join(artifactDirOf(artifactID), "record.json")
  }
  function currentPathOf(artifactID) {
    return join(artifactDirOf(artifactID), "current.md")
  }
  // Snapshot file names use the bare hex digest; ":" is not filesystem-safe.
  function snapshotPathOf(artifactID, revision) {
    return join(artifactDirOf(artifactID), "revisions", revision.slice("sha256:".length) + ".md")
  }
  function lockPathOf(artifactID) {
    return join(artifactDirOf(artifactID), "lock")
  }

  async function ensureDirectories() {
    if (ensured) return
    await mkdir(artifactsDir, { recursive: true, mode: DIR_MODE })
    await chmod(artifactsDir, DIR_MODE).catch(() => {})
    ensured = true
  }

  async function syncDirectory(dir) {
    // Best effort: some systems refuse directory fsync; atomicity of the
    // rename itself never depends on this.
    try {
      const handle = await open(dir, "r")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch {
      /* ignore */
    }
  }

  /** Atomic replace: write temp sibling, fsync, rename over the target. */
  async function writeFileAtomic(target, data, mode) {
    const dir = dirname(target)
    const temp = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`)
    const handle = await open(temp, "w", mode)
    try {
      await handle.writeFile(data, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temp, target)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    await chmod(target, mode).catch(() => {})
    await syncDirectory(dir)
  }

  /**
   * Exclusive create (wx). For immutable snapshots that already exist with
   * identical bytes this is a reuse, not a conflict; differing bytes are an
   * integrity error.
   */
  async function writeFileExclusive(target, data, mode) {
    try {
      const handle = await open(target, "wx", mode)
      try {
        await handle.writeFile(data, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(dirname(target))
      return true
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const existing = await readFile(target, "utf8")
      if (existing !== data) {
        throw new StoreError("io", `Immutable file already exists with different content: ${target}`)
      }
      return false
    }
  }

  function validateRawRecord(record, artifactID) {
    if (record.schemaVersion !== SCHEMA_VERSION) return "unsupported schemaVersion"
    if (record.id !== artifactID) return "record id does not match directory"
    if (typeof record.id !== "string" || !RAW_ID_PATTERN.test(record.id)) return "invalid raw-markdown artifact id"
    if (typeof record.ownerSessionID !== "string" || record.ownerSessionID.length === 0) return "missing ownerSessionID"
    if (typeof record.location !== "string" || record.location.length === 0) return "missing location"
    if (typeof record.title !== "string") return "missing title"
    if (record.status !== "draft" && record.status !== "approved") return "invalid status"
    if (typeof record.revision !== "string" || !REVISION_PATTERN.test(record.revision)) return "invalid revision"
    if (!Array.isArray(record.history) || record.history.length === 0) return "history must be a non-empty array"
    for (const entry of record.history) {
      if (!entry || typeof entry !== "object") return "history entries must be objects"
      if (typeof entry.revision !== "string" || !REVISION_PATTERN.test(entry.revision)) return "invalid history revision"
      if (typeof entry.content !== "string") return "history entry missing content"
      if (typeof entry.createdAt !== "string") return "history entry missing createdAt"
    }
    if (!Array.isArray(record.feedback)) return "feedback must be an array"
    for (const entry of record.feedback) {
      if (!entry || typeof entry !== "object") return "feedback entries must be objects"
      if (typeof entry.requestID !== "string" || !REQUEST_ID_PATTERN.test(entry.requestID)) return "invalid feedback requestID"
      if (typeof entry.revision !== "string" || !REVISION_PATTERN.test(entry.revision)) return "invalid feedback revision"
      if (!entry.delivery || typeof entry.delivery.state !== "string") return "feedback entry missing delivery state"
    }
    if (record.approval !== null && (typeof record.approval !== "object" || !record.approval || typeof record.approval.requestID !== "string")) {
      return "invalid approval"
    }
    return null
  }

  function validateSharedRecord(record, artifactID) {
    if (record.schemaVersion !== SCHEMA_VERSION_SHARED) return "unsupported schemaVersion"
    if (record.id !== artifactID) return "record id does not match directory"
    if (typeof record.id !== "string" || !SHARED_ID_PATTERN.test(record.id)) return "invalid shared artifact id"
    if (typeof record.kind !== "string" || !ARTIFACT_KINDS.includes(record.kind)) return "invalid kind"
    if (typeof record.ownerSessionID !== "string" || record.ownerSessionID.length === 0) return "missing ownerSessionID"
    if (typeof record.location !== "string" || record.location.length === 0) return "missing location"
    if (typeof record.title !== "string" || record.title.length === 0) return "missing title"
    if (typeof record.description !== "string" || record.description.length === 0) return "missing description"
    if (typeof record.status !== "string" || !ARTIFACT_STATUSES.includes(record.status)) return "invalid status"
    if (typeof record.revision !== "string" || !REVISION_PATTERN.test(record.revision)) return "invalid revision"
    if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return "missing createdAt"
    if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) return "missing updatedAt"
    if (record.authority !== undefined && record.authority !== null && !AUTHORITIES.includes(record.authority)) return "invalid authority"
    if (!Array.isArray(record.history) || record.history.length === 0) return "history must be a non-empty array"
    for (const entry of record.history) {
      if (!entry || typeof entry !== "object") return "history entries must be objects"
      if (typeof entry.revision !== "string" || !REVISION_PATTERN.test(entry.revision)) return "invalid history revision"
      if (typeof entry.createdAt !== "string" || entry.createdAt.length === 0) return "history entry missing createdAt"
      if (typeof entry.authorSessionID !== "string" || entry.authorSessionID.length === 0) return "history entry missing authorSessionID"
      if ("content" in entry) return "shared history entries reference snapshots and must not embed content"
    }
    if (!Array.isArray(record.feedback)) return "feedback must be an array"
    for (const entry of record.feedback) {
      if (!entry || typeof entry !== "object") return "feedback entries must be objects"
      if (typeof entry.requestID !== "string" || !REQUEST_ID_PATTERN.test(entry.requestID)) return "invalid feedback requestID"
      if (typeof entry.revision !== "string" || !REVISION_PATTERN.test(entry.revision)) return "invalid feedback revision"
      if (!entry.delivery || typeof entry.delivery.state !== "string") return "feedback entry missing delivery state"
    }
    if (record.approval !== null && (typeof record.approval !== "object" || !record.approval || typeof record.approval.requestID !== "string")) {
      return "invalid approval"
    }
    return null
  }

  function validateRecord(record, artifactID) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) return "record must be an object"
    if (record.schemaVersion === SCHEMA_VERSION) return validateRawRecord(record, artifactID)
    if (record.schemaVersion === SCHEMA_VERSION_SHARED) return validateSharedRecord(record, artifactID)
    return "unsupported schemaVersion"
  }

  async function readRecord(artifactID) {
    let raw
    try {
      raw = await readFile(recordPathOf(artifactID), "utf8")
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    let record
    try {
      record = JSON.parse(raw)
    } catch {
      throw new StoreError("io", `Registry record for ${artifactID} is not valid JSON`)
    }
    const problem = validateRecord(record, artifactID)
    if (problem) throw new StoreError("io", `Registry record for ${artifactID} is invalid: ${problem}`)
    return record
  }

  function currentContent(record) {
    const entry = record.history[record.history.length - 1]
    return entry.content
  }

  /**
   * Read and integrity-check one authoritative shared-markdown-v1 snapshot. A missing
   * or corrupt snapshot is visible data loss, never fabricated content.
   */
  async function readSharedSnapshot(artifactID, entry) {
    const path = snapshotPathOf(artifactID, entry.revision)
    let text
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new StoreError(
          "io",
          `Authoritative snapshot for revision ${entry.revision} is missing: ${path}; the record cannot be served without it`,
          { revision: entry.revision, path },
        )
      }
      throw error
    }
    let parsed
    try {
      parsed = parseDocument(text)
    } catch (error) {
      throw new StoreError("io", `Snapshot for revision ${entry.revision} is not a valid shared artifact document: ${error.message}`, {
        revision: entry.revision,
        path,
      })
    }
    const actual = canonicalRevision(parsed.header, parsed.body)
    if (actual !== entry.revision) {
      throw new StoreError("io", `Snapshot for revision ${entry.revision} does not match its recorded digest (found ${actual}): ${path}`, {
        revision: entry.revision,
        path,
        actual,
      })
    }
    return { text, body: parsed.body }
  }

  /** Derive the current document of a shared-markdown-v1 record from committed state. */
  async function derivedCurrentDocument(artifactID, record) {
    const current = record.history[record.history.length - 1]
    const snapshot = await readSharedSnapshot(artifactID, current)
    const header = sharedHeaderOf(record, current.authorSessionID, record.updatedAt, record.status)
    return serializeDocument(header, snapshot.body)
  }

  /** Rewrite current.md from the committed revision and lifecycle state. */
  async function rewriteCurrentFromRecord(artifactID, record) {
    const derived = await derivedCurrentDocument(artifactID, record)
    let existing = null
    try {
      existing = await readFile(currentPathOf(artifactID), "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (existing !== derived) {
      await writeFileAtomic(currentPathOf(artifactID), derived, FILE_MODE)
    }
  }

  async function listSnapshotNames(artifactID) {
    try {
      return await readdir(join(artifactDirOf(artifactID), "revisions"))
    } catch (error) {
      if (error.code === "ENOENT") return []
      throw error
    }
  }

  /**
   * Derived-file repair. Must be called while holding the artifact lock (or
   * before the record exists at publish time). The record is authoritative:
   * current.md is rewritten whenever its bytes differ from the record's
   * committed state, and missing snapshots are recreated (raw-markdown) or
   * reported as unrecoverable data loss (shared-markdown-v1).
   */
  async function reconcileDerived(artifactID, record) {
    if (record.schemaVersion === SCHEMA_VERSION_SHARED) {
      const names = await listSnapshotNames(artifactID)
      for (const entry of record.history) {
        if (!names.includes(entry.revision.slice("sha256:".length) + ".md")) {
          throw new StoreError(
            "io",
            `Authoritative snapshot for revision ${entry.revision} is missing: ${snapshotPathOf(artifactID, entry.revision)}`,
            { revision: entry.revision, path: snapshotPathOf(artifactID, entry.revision) },
          )
        }
      }
      await rewriteCurrentFromRecord(artifactID, record)
      return
    }
    const content = currentContent(record)
    const current = currentPathOf(artifactID)
    let existing = null
    try {
      existing = await readFile(current, "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (existing !== content) {
      await writeFileAtomic(current, content, FILE_MODE)
    }
    for (const entry of record.history) {
      await writeFileExclusive(snapshotPathOf(artifactID, entry.revision), entry.content, SNAPSHOT_MODE)
    }
  }

  /**
   * Serialize a mutation on an exclusive per-artifact lock. An existing lock
   * is reported as lock_conflict; it is never bypassed. The lock is released
   * in finally.
   */
  async function withLock(artifactID, mutate) {
    const lock = lockPathOf(artifactID)
    let handle
    try {
      handle = await open(lock, "wx", FILE_MODE)
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new StoreError(
          "lock_conflict",
          `Artifact ${artifactID} is locked by another mutation; no changes were made. ` +
            `If the lock is stale (its holder crashed), remove ${lock} and retry; the record is intact.`,
          { artifactID, lock },
        )
      }
      throw error
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: nowISO() })}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      return await mutate()
    } finally {
      try {
        await unlink(lock)
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }

  /** Load a record scoped to the location: unknown IDs and cross-location lookups are both not_found. */
  async function loadScoped(artifactID, location, { label = "artifact" } = {}) {
    const record = await readRecord(artifactID)
    if (!record || record.location !== location) {
      throw new StoreError("not_found", `No ${label} ${artifactID} at this location`, { artifactID })
    }
    return record
  }

  /** Generic summary: shared-markdown-v1 as stored, raw-markdown with derived defaults. */
  function artifactSummaryOf(record) {
    if (record.schemaVersion === SCHEMA_VERSION_SHARED) {
      const current = record.history[record.history.length - 1]
      return {
        id: record.id,
        kind: record.kind,
        title: record.title,
        description: record.description,
        status: record.status,
        revision: record.revision,
        path: currentPathOf(record.id),
        ownerSessionID: record.ownerSessionID,
        authorSessionID: current.authorSessionID,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        format: ARTIFACT_FORMAT_SHARED,
        schemaVersion: SCHEMA_VERSION_SHARED,
        authority: authorityOf(record),
      }
    }
    return {
      id: record.id,
      kind: "plan",
      title: record.title,
      description: null,
      status: record.status,
      revision: record.revision,
      path: currentPathOf(record.id),
      ownerSessionID: record.ownerSessionID,
      authorSessionID: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      format: ARTIFACT_FORMAT_RAW,
      schemaVersion: SCHEMA_VERSION,
      authority: AUTHORITY_HISTORICAL,
    }
  }

  /** Generic view; `content` is supplied by the caller. */
  function artifactViewOf(record, content, requestedRevision, snapshot) {
    return {
      ...artifactSummaryOf(record),
      location: record.location,
      content,
      requestedRevision: requestedRevision ?? null,
      snapshot,
      revisions: record.history.map((entry) => ({
        revision: entry.revision,
        createdAt: entry.createdAt,
        authorSessionID: entry.authorSessionID ?? null,
        snapshot: snapshotPathOf(record.id, entry.revision),
      })),
      feedback: record.feedback,
      approval: record.approval,
    }
  }

  /**
   * Publish a shared-markdown-v1 shared artifact. The body is supplied separately and
   * stored verbatim behind the frontmatter (no H1 is inserted); identity,
   * kind, owner and timestamps are tool-managed.
   */
  async function publishArtifact({ kind, ownerSessionID, authorSessionID, location, title, description, body }) {
    if (typeof kind !== "string" || !ARTIFACT_KINDS.includes(kind)) {
      throw new StoreError("validation", "kind must be one of plan, evidence, review", { kind })
    }
    assertNonEmptyString(ownerSessionID, "ownerSessionID", MAX_SESSION_LENGTH)
    assertNonEmptyString(authorSessionID, "authorSessionID", MAX_SESSION_LENGTH)
    const normalizedLocation = normalizeLocation(location)
    assertNonEmptyString(title, "title", MAX_TITLE_LENGTH)
    assertNonEmptyString(description, "description", MAX_DESCRIPTION_LENGTH)
    if (typeof body !== "string" || body.length === 0) {
      throw new StoreError("validation", "body must be a non-empty string")
    }
    if (body.length > MAX_MARKDOWN_LENGTH) {
      throw new StoreError("validation", `body must be at most ${MAX_MARKDOWN_LENGTH} characters`)
    }
    const trimmedTitle = title.trim()
    const trimmedDescription = description.trim()
    if (trimmedTitle.length === 0) throw new StoreError("validation", "title must not be empty")
    if (trimmedDescription.length === 0) throw new StoreError("validation", "description must not be empty")

    await ensureDirectories()
    const artifactID = newSharedArtifactID()
    const createdAt = nowISO()
    // Plans start draft; evidence and reviews start published.
    const status = kind === "plan" ? "draft" : "published"
    const revision = canonicalRevision(
      sharedIdentity({ id: artifactID, kind, title: trimmedTitle, description: trimmedDescription, ownerSessionID, authorSessionID, createdAt }),
      body,
    )
    const snapshotDocument = serializeDocument(
      {
        ...sharedIdentity({ id: artifactID, kind, title: trimmedTitle, description: trimmedDescription, ownerSessionID, authorSessionID, createdAt }),
        updated_at: createdAt,
        status,
      },
      body,
    )
    if (documentRevision(snapshotDocument) !== revision) {
      throw new StoreError("io", "generated snapshot does not match its revision")
    }
    const record = {
      schemaVersion: SCHEMA_VERSION_SHARED,
      id: artifactID,
      kind,
      ownerSessionID,
      location: normalizedLocation,
      title: trimmedTitle,
      description: trimmedDescription,
      status,
      revision,
      // Plan publications are authoritative; evidence/review never authorize.
      authority: kind === "plan" ? AUTHORITY_IMPLEMENTATION : AUTHORITY_HISTORICAL,
      createdAt,
      updatedAt: createdAt,
      history: [{ revision, createdAt, authorSessionID }],
      feedback: [],
      approval: null,
    }

    // Commit order: derived files first, the authoritative record last.
    await mkdir(artifactDirOf(artifactID), { recursive: true, mode: DIR_MODE })
    await chmod(artifactDirOf(artifactID), DIR_MODE).catch(() => {})
    await mkdir(dirname(snapshotPathOf(artifactID, revision)), { recursive: true, mode: DIR_MODE })
    await writeFileExclusive(snapshotPathOf(artifactID, revision), snapshotDocument, SNAPSHOT_MODE)
    await writeFileAtomic(currentPathOf(artifactID), snapshotDocument, FILE_MODE)
    await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)

    return {
      artifactID,
      path: currentPathOf(artifactID),
      revision,
      title: record.title,
      description: record.description,
      status: record.status,
      kind: record.kind,
      ownerSessionID: record.ownerSessionID,
      authorSessionID,
      authority: authorityOf(record),
      snapshot: snapshotPathOf(artifactID, revision),
    }
  }

  /** Generic list: every visible artifact; record metadata only, no snapshot reads. */
  async function listArtifacts({ location }) {
    const normalizedLocation = normalizeLocation(location)
    await ensureDirectories()
    const names = await readdir(artifactsDir)
    const summaries = []
    for (const name of names) {
      if (!ARTIFACT_ID_PATTERN.test(name)) continue
      const record = await readRecord(name)
      if (!record || record.location !== normalizedLocation) continue
      summaries.push(artifactSummaryOf(record))
    }
    summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return summaries
  }

  /** Record-only generic summary (no snapshot reads); used for authz decisions. */
  async function describeArtifact({ artifactID, location }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    await ensureDirectories()
    const record = await loadScoped(artifactID, normalizedLocation, { label: "artifact" })
    return { ...artifactSummaryOf(record), location: record.location }
  }

  /**
   * Generic get: current state, or the exact earlier revision when one is
   * requested. Earlier shared-markdown-v1 content comes from the immutable snapshot
   * (creation-time status header); current shared-markdown-v1 content is derived from
   * the committed revision and lifecycle state.
   */
  async function getArtifact({ artifactID, location, revision }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    if (revision !== undefined && revision !== null) assertRevision(revision)
    await ensureDirectories()
    const record = await loadScoped(artifactID, normalizedLocation, { label: "artifact" })
    if (revision === undefined || revision === null) {
      const content =
        record.schemaVersion === SCHEMA_VERSION_SHARED
          ? await derivedCurrentDocument(artifactID, record)
          : currentContent(record)
      return artifactViewOf(record, content, null, snapshotPathOf(artifactID, record.revision))
    }
    const entry = record.history.find((candidate) => candidate.revision === revision)
    if (!entry) {
      throw new StoreError("not_found", `Artifact ${artifactID} has no revision ${revision}`, { artifactID, revision })
    }
    const content =
      record.schemaVersion === SCHEMA_VERSION_SHARED
        ? (await readSharedSnapshot(artifactID, entry)).text
        : entry.content
    return {
      ...artifactViewOf(record, content, revision, snapshotPathOf(artifactID, revision)),
      revision,
    }
  }

  /**
   * Shared-markdown-v1 patch: applies unambiguous replacements to the body only and
   * optionally updates title/description through explicit structured fields
   * (never frontmatter text edits). Identity, kind, owner and timestamps are
   * tool-managed; the acting author is recorded on the new revision. The
   * expected revision guards against stale patches.
   */
  async function patchArtifact({ artifactID, location, ownerSessionID, authorSessionID, expectedRevision, replacements = [], title, description }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertNonEmptyString(ownerSessionID, "ownerSessionID", MAX_SESSION_LENGTH)
    assertNonEmptyString(authorSessionID, "authorSessionID", MAX_SESSION_LENGTH)
    assertRevision(expectedRevision)
    if (!Array.isArray(replacements)) {
      throw new StoreError("validation", "replacements must be an array of {oldText, newText}")
    }
    for (const replacement of replacements) {
      if (!replacement || typeof replacement !== "object") {
        throw new StoreError("validation", "each replacement must be an object")
      }
      const { oldText, newText } = replacement
      if (typeof oldText !== "string" || oldText.length === 0) {
        throw new StoreError("validation", "replacement oldText must be a non-empty string")
      }
      if (typeof newText !== "string") {
        throw new StoreError("validation", "replacement newText must be a string")
      }
      if (oldText === newText) {
        throw new StoreError("validation", "replacement oldText and newText must differ")
      }
    }
    const hasTitle = title !== undefined && title !== null
    const hasDescription = description !== undefined && description !== null
    if (hasTitle) assertNonEmptyString(title, "title", MAX_TITLE_LENGTH)
    if (hasDescription) assertNonEmptyString(description, "description", MAX_DESCRIPTION_LENGTH)
    if (replacements.length === 0 && !hasTitle && !hasDescription) {
      throw new StoreError("validation", "a patch requires replacements or an explicit title/description update")
    }

    await ensureDirectories()
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation, { label: "artifact" })
      if (record.schemaVersion !== SCHEMA_VERSION_SHARED) {
        throw new StoreError("forbidden", `Artifact ${artifactID} is a raw-markdown record; it is read-only`, { artifactID })
      }
      if (record.ownerSessionID !== ownerSessionID) {
        throw new StoreError(
          "forbidden",
          `Patching is restricted to the owning session (${record.ownerSessionID})`,
          { artifactID, ownerSessionID: record.ownerSessionID },
        )
      }
      if (record.status === "approved") {
        throw new StoreError("approved", "This artifact is approved; patches are rejected", {
          artifactID,
          revision: record.revision,
        })
      }
      if (record.revision !== expectedRevision) {
        throw new StoreError(
          "stale_revision",
          `Expected revision ${expectedRevision} does not match the current revision ${record.revision}`,
          { expected: expectedRevision, current: record.revision },
        )
      }

      // Repair derived files first: an interrupted earlier write must not
      // leak into the patched content. A missing authoritative snapshot
      // fails here instead of fabricating a base.
      await reconcileDerived(artifactID, record)

      const currentEntry = record.history[record.history.length - 1]
      let body = (await readSharedSnapshot(artifactID, currentEntry)).body
      for (let index = 0; index < replacements.length; index += 1) {
        const { oldText, newText } = replacements[index]
        const occurrences = countOccurrences(body, oldText)
        if (occurrences === 0) {
          throw new StoreError("patch_conflict", `Replacement ${index + 1}: the text to replace does not appear in the current body`, {
            index,
          })
        }
        if (occurrences > 1) {
          throw new StoreError(
            "patch_conflict",
            `Replacement ${index + 1}: the text to replace appears ${occurrences} times; matches must be unambiguous`,
            { index, occurrences },
          )
        }
        const at = body.indexOf(oldText)
        body = body.slice(0, at) + newText + body.slice(at + oldText.length)
      }

      const newTitle = hasTitle ? title.trim() : record.title
      const newDescription = hasDescription ? description.trim() : record.description
      if (newTitle.length === 0) throw new StoreError("validation", "title must not be empty")
      if (newDescription.length === 0) throw new StoreError("validation", "description must not be empty")

      const createdAt = nowISO()
      const identity = sharedIdentity({
        id: record.id,
        kind: record.kind,
        title: newTitle,
        description: newDescription,
        ownerSessionID: record.ownerSessionID,
        authorSessionID,
        createdAt: record.createdAt,
      })
      const newRevision = canonicalRevision(identity, body)
      if (record.history.some((entry) => entry.revision === newRevision)) {
        throw new StoreError("patch_conflict", "The patch produces content identical to an existing revision; no change was recorded", {
          revision: newRevision,
        })
      }

      const snapshotDocument = serializeDocument({ ...identity, updated_at: createdAt, status: record.status }, body)
      if (documentRevision(snapshotDocument) !== newRevision) {
        throw new StoreError("io", "generated snapshot does not match its revision")
      }

      // Commit order: snapshot, derived current file, authoritative record last.
      await writeFileExclusive(snapshotPathOf(artifactID, newRevision), snapshotDocument, SNAPSHOT_MODE)
      record.revision = newRevision
      record.history.push({ revision: newRevision, createdAt, authorSessionID })
      if (hasTitle) record.title = newTitle
      if (hasDescription) record.description = newDescription
      record.updatedAt = createdAt
      await writeFileAtomic(currentPathOf(artifactID), snapshotDocument, FILE_MODE)
      await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)

      return {
        artifactID,
        path: currentPathOf(artifactID),
        revision: newRevision,
        title: record.title,
        description: record.description,
        status: record.status,
        kind: record.kind,
        ownerSessionID: record.ownerSessionID,
        authorSessionID,
        authority: authorityOf(record),
        snapshot: snapshotPathOf(artifactID, newRevision),
      }
    })
  }

  /**
   * Feedback core. Raw-markdown documents stay readable and accept feedback;
   * shared-markdown-v1 records behave as before. Byte limits are enforced before
   * anything is recorded, request IDs deduplicate, and stale displayed
   * revisions are rejected.
   */
  async function addFeedbackCore({ artifactID, location, revision, requestID, question, selectedText, selectedRange }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertRevision(revision)
    assertRequestID(requestID)
    const hasQuestion = typeof question === "string" && question.trim().length > 0
    const hasSelection = typeof selectedText === "string" && selectedText.length > 0
    if (!hasQuestion && !hasSelection) {
      throw new StoreError("validation", "feedback requires a question or a selected excerpt")
    }
    // Enforced before recording or delivery: oversized input leaves no
    // submission behind.
    if (hasQuestion && Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) {
      throw new StoreError("validation", `question must be at most ${MAX_QUESTION_BYTES} UTF-8 bytes`, {
        limit: MAX_QUESTION_BYTES,
      })
    }
    if (hasSelection && Buffer.byteLength(selectedText, "utf8") > MAX_SELECTION_BYTES) {
      throw new StoreError("validation", `selectedText must be at most ${MAX_SELECTION_BYTES} UTF-8 bytes`, {
        limit: MAX_SELECTION_BYTES,
      })
    }
    if (selectedText !== undefined && selectedText !== null && typeof selectedText !== "string") {
      throw new StoreError("validation", "selectedText must be a string when provided")
    }
    if (selectedRange !== undefined && selectedRange !== null) {
      if (
        !selectedRange ||
        typeof selectedRange !== "object" ||
        typeof selectedRange.start !== "number" ||
        typeof selectedRange.end !== "number"
      ) {
        throw new StoreError("validation", "selectedRange must be {start, end} line numbers when provided")
      }
    }

    await ensureDirectories()
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation)
      const summarize = () => artifactSummaryOf(record)
      const existing = record.feedback.find((entry) => entry.requestID === requestID)
      if (existing) {
        return {
          requestID,
          deduplicated: true,
          delivery: existing.delivery,
          feedback: existing,
          summary: summarize(),
        }
      }
      if (revision !== record.revision) {
        throw new StoreError(
          "stale_revision",
          `Displayed revision ${revision} does not match the current revision ${record.revision}; refresh the plan and retry`,
          { displayed: revision, current: record.revision },
        )
      }
      const createdAt = nowISO()
      const entry = {
        requestID,
        revision,
        question: hasQuestion ? question : null,
        selectedText: hasSelection ? selectedText : null,
        selectedRange: hasSelection && selectedRange ? selectedRange : null,
        delivery: freshDelivery(),
        createdAt,
      }
      record.feedback.push(entry)
      record.updatedAt = createdAt
      await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)
      return { requestID, deduplicated: false, delivery: entry.delivery, feedback: entry, summary: summarize() }
    })
  }

  /**
   * Approval core. Only plan artifacts can be approved (raw-markdown records are
   * always plans). Approval validates the displayed content revision under
   * lock, records that exact revision, and — for shared-markdown-v1 — regenerates the
   * current frontmatter with status "approved" without changing the content
   * revision. Manual frontmatter edits never authorize or reopen anything:
   * authorization is this recorded decision. Authority is never changed here;
   * a plan that is not implementation freezes as a decision and does not authorize Builder.
   */
  async function approveCore({ artifactID, location, revision, requestID }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertRevision(revision)
    assertRequestID(requestID)

    await ensureDirectories()
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation)
      if (record.schemaVersion === SCHEMA_VERSION_SHARED && record.kind !== "plan") {
        throw new StoreError("validation", `Only plan artifacts can be approved; ${artifactID} has kind ${record.kind}`, {
          artifactID,
          kind: record.kind,
        })
      }
      const summarize = () => artifactSummaryOf(record)
      if (record.approval) {
        if (record.approval.revision === revision) {
          // The decision for this exact revision is already recorded; a second
          // approval never replaces it and never re-records under a new ID.
          return {
            requestID: record.approval.requestID,
            deduplicated: true,
            delivery: record.approval.delivery,
            approval: record.approval,
            summary: summarize(),
          }
        }
        throw new StoreError(
          "stale_revision",
          `This plan is already approved at revision ${record.approval.revision}; the displayed revision ${revision} is not the approved one`,
          { displayed: revision, current: record.revision },
        )
      }
      if (revision !== record.revision) {
        throw new StoreError(
          "stale_revision",
          `Displayed revision ${revision} does not match the current revision ${record.revision}; refresh the plan and retry`,
          { displayed: revision, current: record.revision },
        )
      }
      const createdAt = nowISO()
      const approval = {
        requestID,
        revision,
        delivery: freshDelivery(),
        createdAt,
      }
      record.approval = approval
      record.status = "approved"
      record.updatedAt = createdAt
      if (record.schemaVersion === SCHEMA_VERSION_SHARED) {
        // Regenerate the displayed frontmatter from lifecycle state. The
        // content revision is unchanged: updated_at and status are excluded
        // from the canonical hash.
        await rewriteCurrentFromRecord(artifactID, record)
      }
      await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)
      return { requestID, deduplicated: false, delivery: approval.delivery, approval, summary: summarize() }
    })
  }

  /**
   * Delivery-bookkeeping core. The recorded decision (feedback entry or
   * approval) is never altered by delivery bookkeeping: a failed notification
   * keeps the decision and can be retried explicitly with the same requestID.
   */
  async function markDeliveryCore({ artifactID, location, requestID, state, error }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertRequestID(requestID)
    if (state !== "pending" && state !== "delivered" && state !== "failed") {
      throw new StoreError("validation", "delivery state must be pending, delivered, or failed")
    }

    await ensureDirectories()
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation)
      const summarize = () => artifactSummaryOf(record)
      let kind = null
      let entry = record.feedback.find((candidate) => candidate.requestID === requestID)
      if (entry) {
        kind = "feedback"
      } else if (record.approval && record.approval.requestID === requestID) {
        entry = record.approval
        kind = "approval"
      }
      if (!entry) {
        throw new StoreError("not_found", `No feedback or approval submission with request ID ${requestID}`, {
          requestID,
        })
      }
      const now = nowISO()
      entry.delivery.state = state
      entry.delivery.attemptedAt = now
      if (state === "delivered") {
        entry.delivery.deliveredAt = now
        entry.delivery.error = null
      } else if (state === "failed") {
        entry.delivery.error = typeof error === "string" && error.length > 0 ? error.slice(0, 500) : "delivery failed"
      }
      record.updatedAt = now
      await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)
      return { requestID, kind, delivery: entry.delivery, summary: summarize() }
    })
  }

  // Generic shared-artifact surface (shared-markdown-v1 records, raw-markdown readable).
  async function addArtifactFeedback(args) {
    const result = await addFeedbackCore(args)
    return { requestID: result.requestID, deduplicated: result.deduplicated, delivery: result.delivery, feedback: result.feedback, artifact: result.summary }
  }

  async function approveArtifact(args) {
    const result = await approveCore(args)
    return { requestID: result.requestID, deduplicated: result.deduplicated, delivery: result.delivery, approval: result.approval, artifact: result.summary }
  }

  async function markArtifactDelivery(args) {
    const result = await markDeliveryCore(args)
    return { requestID: result.requestID, kind: result.kind, delivery: result.delivery, artifact: result.summary }
  }

  return {
    root,
    // Shared artifact surface (shared-markdown-v1, with generic reads over both).
    publishArtifact,
    listArtifacts,
    getArtifact,
    describeArtifact,
    patchArtifact,
    addArtifactFeedback,
    approveArtifact,
    markArtifactDelivery,
  }
}
