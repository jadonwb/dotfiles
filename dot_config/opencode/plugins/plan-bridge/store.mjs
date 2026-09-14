// Plan-bridge registry: a Node-compatible, filesystem-backed store for
// Markdown artifacts exchanged between sessions and the Neovim client.
//
// Each artifact is one authoritative record (record.json) holding the verbatim
// body, plus one generated read-only view (current.md) rendered by ./format.mjs.
// Artifacts are matched, fetched, patched, and addressed by ID only; there is no
// revision history.
//
// Design rules:
// - All paths are derived internally from the store root plus generated IDs;
//   callers never supply filesystem paths.
// - Every lookup is scoped to the location recorded on the artifact; a
//   mismatched location is reported as not found.
// - record.json is authoritative and written last. The derived view is written
//   first, so an interrupted write is repairable: the view is regenerated from
//   the record.
// - Mutations serialize on an exclusive per-artifact lock file. An existing
//   lock is reported (lock_conflict), never silently bypassed. A stale lock is
//   removed by hand; the record is intact.
// - Pure Node (node:*) so `node --test` can exercise it without Bun.

import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path"

import { renderView } from "./format.mjs"

const DIR_MODE = 0o700
const FILE_MODE = 0o600

const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{8}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/

const MAX_MARKDOWN_LENGTH = 2_000_000
const MAX_TITLE_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_SESSION_LENGTH = 128
/** Feedback question limit (UTF-8 bytes). */
const MAX_QUESTION_BYTES = 16 * 1024
/** User-selected excerpt limit (UTF-8 bytes). */
const MAX_SELECTION_BYTES = 64 * 1024

export const ARTIFACT_KINDS = Object.freeze(["plan", "evidence", "review"])
export const ARTIFACT_STATUSES = Object.freeze(["draft", "published", "approved"])

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

function newSharedArtifactID() {
  return "art_" + randomBytes(4).toString("hex")
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

/** The four displayed fields of the generated view. */
function viewHeaderOf(record) {
  return { id: record.id, kind: record.kind, status: record.status, title: record.title }
}

function validateRecord(record, artifactID) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return "record must be an object"
  if (record.id !== artifactID) return "record id does not match directory"
  if (typeof record.id !== "string" || !ARTIFACT_ID_PATTERN.test(record.id)) return "invalid artifact id"
  if (typeof record.kind !== "string" || !ARTIFACT_KINDS.includes(record.kind)) return "invalid kind"
  if (typeof record.ownerSessionID !== "string" || record.ownerSessionID.length === 0) return "missing ownerSessionID"
  if (typeof record.location !== "string" || record.location.length === 0) return "missing location"
  if (typeof record.title !== "string" || record.title.length === 0) return "missing title"
  if (typeof record.description !== "string" || record.description.length === 0) return "missing description"
  if (typeof record.status !== "string" || !ARTIFACT_STATUSES.includes(record.status)) return "invalid status"
  if (typeof record.body !== "string" || record.body.length === 0) return "missing body"
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return "missing createdAt"
  if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) return "missing updatedAt"
  if (!Array.isArray(record.feedback)) return "feedback must be an array"
  for (const entry of record.feedback) {
    if (!entry || typeof entry !== "object") return "feedback entries must be objects"
    if (typeof entry.requestID !== "string" || !REQUEST_ID_PATTERN.test(entry.requestID)) return "invalid feedback requestID"
    if (!entry.delivery || typeof entry.delivery.state !== "string") return "feedback entry missing delivery state"
  }
  if (record.approval !== null && (typeof record.approval !== "object" || !record.approval || typeof record.approval.requestID !== "string")) {
    return "invalid approval"
  }
  return null
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

  /** Rewrite the derived view from the record (repairs an interrupted write). */
  async function writeCurrentView(artifactID, record) {
    const rendered = await renderView(viewHeaderOf(record), record.body)
    await writeFileAtomic(currentPathOf(artifactID), rendered, FILE_MODE)
    return rendered
  }

  /**
   * Return the view derived from the authoritative record, reconciling a stale
   * or missing current.md so reads can never serve bytes that disagree with the
   * record (for example after an interrupted view-first/record-last update).
   */
  async function readCurrentView(artifactID, record) {
    const rendered = await renderView(viewHeaderOf(record), record.body)
    let existing = null
    try {
      existing = await readFile(currentPathOf(artifactID), "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (existing !== rendered) {
      await writeFileAtomic(currentPathOf(artifactID), rendered, FILE_MODE)
    }
    return rendered
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

  function artifactSummaryOf(record) {
    return {
      id: record.id,
      kind: record.kind,
      title: record.title,
      description: record.description,
      status: record.status,
      path: currentPathOf(record.id),
      ownerSessionID: record.ownerSessionID,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  function artifactViewOf(record, content) {
    return {
      ...artifactSummaryOf(record),
      location: record.location,
      content,
      feedback: record.feedback,
      approval: record.approval,
    }
  }

  /**
   * Publish an artifact. The body is stored verbatim; the generated view is a
   * Prettier-formatted rendering of the minimal frontmatter plus that body.
   */
  async function publishArtifact({ kind, ownerSessionID, location, title, description, body }) {
    if (typeof kind !== "string" || !ARTIFACT_KINDS.includes(kind)) {
      throw new StoreError("validation", "kind must be one of plan, evidence, review", { kind })
    }
    assertNonEmptyString(ownerSessionID, "ownerSessionID", MAX_SESSION_LENGTH)
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
    const record = {
      id: artifactID,
      kind,
      ownerSessionID,
      location: normalizedLocation,
      title: trimmedTitle,
      description: trimmedDescription,
      status,
      createdAt,
      updatedAt: createdAt,
      body,
      feedback: [],
      approval: null,
    }

    // Commit order: the derived view first, the authoritative record last.
    await mkdir(artifactDirOf(artifactID), { recursive: true, mode: DIR_MODE })
    await chmod(artifactDirOf(artifactID), DIR_MODE).catch(() => {})
    await writeCurrentView(artifactID, record)
    await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)

    return { artifactID, ...artifactSummaryOf(record) }
  }

  /** Every visible artifact for the location; record metadata only. */
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

  /** The latest view of one artifact, addressed by ID only. */
  async function getArtifact({ artifactID, location }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    await ensureDirectories()
    const record = await loadScoped(artifactID, normalizedLocation, { label: "artifact" })
    const content = await readCurrentView(artifactID, record)
    return artifactViewOf(record, content)
  }

  /**
   * Apply unambiguous body replacements and optional structured title/description
   * updates. The base is the verbatim body stored in the record, so an agent can
   * patch exactly the bytes it supplied without rereading the formatted view.
   * The stored owner must match the caller; approved plans reject patches.
   */
  async function patchArtifact({ artifactID, location, ownerSessionID, replacements = [], title, description }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertNonEmptyString(ownerSessionID, "ownerSessionID", MAX_SESSION_LENGTH)
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
      if (record.ownerSessionID !== ownerSessionID) {
        throw new StoreError(
          "forbidden",
          `Patching is restricted to the owning session (${record.ownerSessionID})`,
          { artifactID, ownerSessionID: record.ownerSessionID },
        )
      }
      if (record.status === "approved") {
        throw new StoreError("approved", "This artifact is approved; patches are rejected", { artifactID })
      }

      let body = record.body
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
      // The record requires a non-empty body; reject before writing either file
      // so a whole-body deletion cannot leave an unreadable record behind.
      if (body.length === 0) {
        throw new StoreError("validation", "a patch must not empty the artifact body", { artifactID })
      }

      record.body = body
      if (hasTitle) record.title = newTitle
      if (hasDescription) record.description = newDescription
      record.updatedAt = nowISO()

      // Commit order: the derived view first, the authoritative record last.
      await writeCurrentView(artifactID, record)
      await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)

      return { artifactID, ...artifactSummaryOf(record) }
    })
  }

  /**
   * Feedback core. Byte limits are enforced before anything is recorded and
   * request IDs deduplicate.
   */
  async function addArtifactFeedback({ artifactID, location, requestID, question, selectedText, selectedRange }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertRequestID(requestID)
    const hasQuestion = typeof question === "string" && question.trim().length > 0
    const hasSelection = typeof selectedText === "string" && selectedText.length > 0
    if (!hasQuestion && !hasSelection) {
      throw new StoreError("validation", "feedback requires a question or a selected excerpt")
    }
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
      const existing = record.feedback.find((entry) => entry.requestID === requestID)
      if (existing) {
        return { requestID, deduplicated: true, delivery: existing.delivery, feedback: existing, artifact: artifactSummaryOf(record) }
      }
      const createdAt = nowISO()
      const entry = {
        requestID,
        question: hasQuestion ? question : null,
        selectedText: hasSelection ? selectedText : null,
        selectedRange: hasSelection && selectedRange ? selectedRange : null,
        delivery: freshDelivery(),
        createdAt,
      }
      record.feedback.push(entry)
      record.updatedAt = createdAt
      await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)
      return { requestID, deduplicated: false, delivery: entry.delivery, feedback: entry, artifact: artifactSummaryOf(record) }
    })
  }

  /**
   * Approval core. Only plan artifacts can be approved. An existing approval is
   * the recorded decision and is never replaced; a repeated approval returns it.
   */
  async function approveArtifact({ artifactID, location, requestID }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertRequestID(requestID)

    await ensureDirectories()
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation)
      if (record.kind !== "plan") {
        throw new StoreError("validation", `Only plan artifacts can be approved; ${artifactID} has kind ${record.kind}`, {
          artifactID,
          kind: record.kind,
        })
      }
      if (record.approval) {
        return {
          requestID: record.approval.requestID,
          deduplicated: true,
          delivery: record.approval.delivery,
          approval: record.approval,
          artifact: artifactSummaryOf(record),
        }
      }
      const createdAt = nowISO()
      const approval = { requestID, delivery: freshDelivery(), createdAt }
      record.approval = approval
      record.status = "approved"
      record.updatedAt = createdAt
      await writeCurrentView(artifactID, record)
      await writeFileAtomic(recordPathOf(artifactID), serializeRecord(record), FILE_MODE)
      return { requestID, deduplicated: false, delivery: approval.delivery, approval, artifact: artifactSummaryOf(record) }
    })
  }

  /**
   * Delivery bookkeeping. The recorded decision is never altered by delivery
   * bookkeeping: a failed notification keeps the decision and can be retried
   * explicitly with the same requestID.
   */
  async function markArtifactDelivery({ artifactID, location, requestID, state, error }) {
    assertArtifactID(artifactID)
    const normalizedLocation = normalizeLocation(location)
    assertRequestID(requestID)
    if (state !== "pending" && state !== "delivered" && state !== "failed") {
      throw new StoreError("validation", "delivery state must be pending, delivered, or failed")
    }

    await ensureDirectories()
    return withLock(artifactID, async () => {
      const record = await loadScoped(artifactID, normalizedLocation)
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
      return { requestID, kind, delivery: entry.delivery, artifact: artifactSummaryOf(record) }
    })
  }

  return {
    root,
    publishArtifact,
    listArtifacts,
    getArtifact,
    patchArtifact,
    addArtifactFeedback,
    approveArtifact,
    markArtifactDelivery,
  }
}
