// Shared artifact Markdown format ("shared-markdown"): a dependency-free
// Markdown document format with a fixed YAML-style frontmatter block whose
// scalars are JSON-quoted strings, plus the canonical revision (hash)
// algorithm shared by every implementation (store, tools, and later the
// Neovim/Lua client via format-fixtures.json).
//
// Document layout (exactly, LF line endings, UTF-8):
//
//   ---
//   id: "art_..."                    \uFFFF  nine header lines, fixed order
//   kind: "plan"                             keys, each value a JSON string
//   title: "..."                             scalar on a single line
//   description: "..."
//   owner_session_id: "ses_..."
//   author_session_id: "ses_..."
//   created_at: "2026-09-13T12:00:00.000Z"
//   updated_at: "2026-09-13T12:00:00.000Z"
//   status: "draft"
//   ---
//   <body Markdown, exactly as supplied; no H1 is inserted>
//
// Rules:
// - The opening and closing fences are exactly "---" lines. The closing fence
//   must be terminated by LF; everything after it is the body (possibly "").
//   Body bytes are preserved exactly: CR bytes inside the body (e.g. CRLF)
//   are not line terminators for the format and are hashed as-is.
// - Header lines are "<key>: " followed by the value serialized with
//   JSON.stringify (single line, minimal escaping). Parsing requires the
//   exact canonical spelling: JSON.parse of the scalar must re-serialize to
//   the same bytes. Duplicate, missing, unknown, out-of-order fields,
//   malformed or non-canonical scalars, and any other header syntax are
//   rejected. Values must be non-empty strings; kind and status must use the
//   enumerated values below. Non-string JSON scalars (number, boolean, null,
//   array, object) parse but are rejected by type.
// - Canonical spelling is JSON.stringify's: the short escapes \b \t \n \f \r
//   plus \" and \\; every other C0 control as a LOWERCASE \u00xx escape;
//   everything else literal — including DEL (U+007F), NEL (U+0085), LINE
//   SEPARATOR (U+2028), PARAGRAPH SEPARATOR (U+2029), '/' and all non-ASCII.
//   Equivalent-but-different spellings ("\u0009", "\u000A", "\u007f",
//   surrogate-pair escapes for non-BMP characters) are non-canonical. The
//   one surrogate case the parser supports: \udXXX escapes of LONE surrogate
//   code units are canonical (JSON.parse keeps them and JSON.stringify
//   re-escapes them); surrogate-pair escapes must be written as the raw
//   character instead.
// - The content revision of a document is SHA-256 over a canonical input that
//   EXCLUDES the two bookkeeping fields (updated_at, status) so that approval
//   can flip the displayed status without changing the content revision:
//
//       id: <json>\n
//       kind: <json>\n
//       title: <json>\n
//       description: <json>\n
//       owner_session_id: <json>\n
//       author_session_id: <json>\n
//       created_at: <json>\n
//       ---\n
//       <exact body bytes, final-newline distinction preserved>
//
//   The revision is the first 8 lowercase hex characters of the SHA-256
//   digest. The revision is never an input to its own hash; the artifact ID
//   is random, so embedding it is safe.
//
// Pure Node (node:*) so `node --test` can exercise it without Bun.

import { createHash } from "node:crypto"

export const FORMAT_NAME = "shared-markdown"

export const OPEN_FENCE = "---"
export const CLOSE_FENCE = "---"

/** All frontmatter keys, in the exact serialization/parse order. */
export const FRONTMATTER_KEYS = Object.freeze([
  "id",
  "kind",
  "title",
  "description",
  "owner_session_id",
  "author_session_id",
  "created_at",
  "updated_at",
  "status",
])

/**
 * Keys covered by the content revision (the identity/descriptive header).
 * `updated_at` and `status` are validated fields but never hash inputs.
 */
export const REVISION_KEYS = Object.freeze([
  "id",
  "kind",
  "title",
  "description",
  "owner_session_id",
  "author_session_id",
  "created_at",
])

export const ARTIFACT_KINDS = Object.freeze(["plan", "evidence", "review"])
export const ARTIFACT_STATUSES = Object.freeze(["draft", "published", "approved"])

/** Error for any format violation; `problem` is a short machine-readable tag. */
export class FormatError extends Error {
  constructor(message, problem, data) {
    super(message)
    this.name = "FormatError"
    this.code = "format"
    this.problem = problem
    this.data = data
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

/** Serialize one header scalar: canonical single-line JSON string. */
export function serializeHeaderValue(value) {
  if (typeof value !== "string") {
    throw new FormatError(`header value must be a string, got ${typeof value}`, "scalar_type")
  }
  // JSON.stringify of a string is single-line, minimally escaped, canonical.
  return JSON.stringify(value)
}

/** Serialize the nine header lines (no fences). Strict about keys/order. */
export function serializeHeader(header) {
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw new FormatError("header must be an object", "header_type")
  }
  for (const key of Object.keys(header)) {
    if (!FRONTMATTER_KEYS.includes(key)) {
      throw new FormatError(`unknown header field ${JSON.stringify(key)}`, "unknown_field", { key })
    }
  }
  const lines = FRONTMATTER_KEYS.map((key) => {
    if (!isNonEmptyString(header[key])) {
      throw new FormatError(`header field ${key} must be a non-empty string`, "missing_field", { key })
    }
    return `${key}: ${serializeHeaderValue(header[key])}`
  })
  return lines.join("\n")
}

/** Serialize a full document: fences + header + LF + exact body bytes. */
export function serializeDocument(header, body) {
  if (typeof body !== "string") {
    throw new FormatError("body must be a string", "body_type")
  }
  return `${OPEN_FENCE}\n${serializeHeader(header)}\n${CLOSE_FENCE}\n${body}`
}

/**
 * Parse a document into { header, body }. Rejects anything that is not the
 * exact format: wrong fences, wrong key count/order, duplicate, missing or
 * unknown fields, malformed or non-canonical scalars, unknown kind/status.
 */
export function parseDocument(text) {
  if (typeof text !== "string") {
    throw new FormatError("document must be a string", "document_type")
  }
  const lines = text.split("\n")
  if (lines[0] !== OPEN_FENCE) {
    throw new FormatError("document must open with a --- fence line", "fence", {})
  }
  // The first --- line after the opening fence closes the frontmatter; body
  // fences are never mistaken for it. The closing fence must be terminated
  // by LF so that an empty body is representable.
  let closeIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === CLOSE_FENCE) {
      closeIndex = index
      break
    }
  }
  if (closeIndex === -1) {
    throw new FormatError("document is missing its closing --- fence line", "fence", {})
  }
  if (closeIndex === lines.length - 1) {
    throw new FormatError("closing --- fence must be terminated by a line feed", "fence", {})
  }
  const header = {}
  const seenKeys = []
  for (let index = 1; index < closeIndex; index += 1) {
    const line = lines[index]
    const separator = line.indexOf(": ")
    if (separator === -1) {
      throw new FormatError(`unsupported header syntax at frontmatter line ${index}`, "unsupported_syntax", { line: index })
    }
    const key = line.slice(0, separator)
    const rawValue = line.slice(separator + 2)
    if (!FRONTMATTER_KEYS.includes(key)) {
      throw new FormatError(`unknown header field ${JSON.stringify(key)} at frontmatter line ${index}`, "unknown_field", { key, line: index })
    }
    if (key in header) {
      throw new FormatError(`duplicate header field ${JSON.stringify(key)} at frontmatter line ${index}`, "duplicate_or_order", { key, line: index })
    }
    let value
    try {
      value = JSON.parse(rawValue)
    } catch {
      throw new FormatError(`header field ${key} has a malformed JSON string scalar`, "malformed_scalar", { key, line: index })
    }
    if (typeof value !== "string") {
      throw new FormatError(`header field ${key} must be a JSON string scalar`, "scalar_type", { key, line: index })
    }
    if (JSON.stringify(value) !== rawValue) {
      throw new FormatError(`header field ${key} is not in canonical JSON form`, "noncanonical_scalar", { key, line: index })
    }
    if (!isNonEmptyString(value)) {
      throw new FormatError(`header field ${key} must be a non-empty string`, "empty_value", { key, line: index })
    }
    header[key] = value
    seenKeys.push(key)
  }
  for (const key of FRONTMATTER_KEYS) {
    if (!(key in header)) {
      throw new FormatError(`missing header field ${JSON.stringify(key)}`, "missing_field", { key })
    }
  }
  for (let index = 0; index < FRONTMATTER_KEYS.length; index += 1) {
    if (seenKeys[index] !== FRONTMATTER_KEYS[index]) {
      throw new FormatError(`header field ${JSON.stringify(seenKeys[index])} is out of the fixed field order`, "duplicate_or_order", { key: seenKeys[index], line: index + 1 })
    }
  }
  if (!ARTIFACT_KINDS.includes(header.kind)) {
    throw new FormatError(`unknown kind ${JSON.stringify(header.kind)}`, "unknown_kind", { kind: header.kind })
  }
  if (!ARTIFACT_STATUSES.includes(header.status)) {
    throw new FormatError(`unknown status ${JSON.stringify(header.status)}`, "unknown_status", { status: header.status })
  }
  return { header, body: lines.slice(closeIndex + 1).join("\n") }
}

/**
 * The exact bytes whose SHA-256 is the content revision: the seven
 * identity/descriptive header lines in fixed order (JSON string values, LF
 * delimiters), the closing delimiter line, then the exact body bytes.
 */
export function canonicalInput(identity, body) {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new FormatError("identity must be an object", "identity_type")
  }
  const lines = REVISION_KEYS.map((key) => {
    if (!isNonEmptyString(identity[key])) {
      throw new FormatError(`identity field ${key} must be a non-empty string`, "missing_field", { key })
    }
    return `${key}: ${serializeHeaderValue(identity[key])}`
  })
  if (typeof body !== "string") {
    throw new FormatError("body must be a string", "body_type")
  }
  return `${lines.join("\n")}\n${CLOSE_FENCE}\n${body}`
}

/** Content revision of an identity header + body: the first 8 hex digits of the SHA-256 digest. */
export function canonicalRevision(identity, body) {
  return createHash("sha256").update(canonicalInput(identity, body), "utf8").digest("hex").slice(0, 8)
}

/**
 * Content revision of a displayed document. Rejects the same document
 * violations as parseDocument; the two bookkeeping fields (updated_at,
 * status) are validated but excluded from the hash input.
 */
export function documentRevision(text) {
  const doc = parseDocument(text)
  return canonicalRevision(doc.header, doc.body)
}
