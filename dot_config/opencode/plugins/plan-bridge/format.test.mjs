// Tests for the shared artifact Markdown format (format.mjs), pinned against
// the committed cross-implementation fixtures (format-fixtures.json).
// Run from the chezmoi working directory:
//   node --test dot_config/opencode/plugins/plan-bridge/format.test.mjs
// No network, no model, no session admission.

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  REVISION_KEYS,
  FormatError,
  canonicalInput,
  canonicalRevision,
  documentRevision,
  parseDocument,
  serializeDocument,
  serializeHeader,
  serializeHeaderValue,
} from "./format.mjs"

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "format-fixtures.json")
const fixtures = JSON.parse(await readFile(fixturesPath, "utf8"))

test("serialization fixtures round-trip byte-exactly", () => {
  for (const item of fixtures.serializationCases) {
    assert.equal(serializeDocument(item.header, item.body), item.document, item.name)
    const parsed = parseDocument(item.document)
    assert.deepEqual(parsed.header, item.header, item.name)
    assert.equal(parsed.body, item.body, item.name)
    // Canonical serialization is stable: parse -> serialize reproduces bytes.
    assert.equal(serializeDocument(parsed.header, parsed.body), item.document, item.name)
  }
})

test("canonical revision fixtures", () => {
  const byName = (name) => fixtures.revisionCases.find((entry) => entry.name === name)
  for (const item of fixtures.revisionCases) {
    assert.equal(canonicalInput(item.identity, item.body), item.canonicalInput, item.name)
    assert.equal(canonicalRevision(item.identity, item.body), item.revision, item.name)
    assert.match(item.revision, /^sha256:[a-f0-9]{64}$/)
    if (item.sameRevisionAs) {
      assert.equal(item.revision, byName(item.sameRevisionAs).revision, item.name)
    }
    if (item.differsFrom) {
      assert.notEqual(item.revision, byName(item.differsFrom).revision, item.name)
    }
  }
})

test("displayed-document revision fixtures (status/updated_at excluded)", () => {
  const byName = (name) => fixtures.documentRevisionCases.find((entry) => entry.name === name)
  for (const item of fixtures.documentRevisionCases) {
    assert.equal(documentRevision(item.document), item.revision, item.name)
    if (item.sameRevisionAs) {
      assert.equal(item.revision, byName(item.sameRevisionAs).revision, item.name)
    }
  }
  // A revision case and its document case describe the same bytes.
  assert.equal(fixtures.revisionCases[0].revision, fixtures.documentRevisionCases[0].revision)
})

test("invalid documents are rejected with the pinned problem tag", () => {
  for (const item of fixtures.invalidDocuments) {
    assert.throws(
      () => parseDocument(item.document),
      (error) => error instanceof FormatError && error.problem === item.problem,
      `${item.name} should fail with ${item.problem}`,
    )
    assert.throws(() => documentRevision(item.document), FormatError, item.name)
  }
})

test("header serialization escapes scalars onto a single line", () => {
  const header = { ...fixtures.serializationCases[0].header }
  const document = serializeDocument(header, "body\n")
  assert.ok(!document.slice(0, document.indexOf("\n---\n", 4)).includes("\n\n"), "no blank line inside frontmatter")
  // A newline inside a value must be escaped, never literal.
  const tricky = {
    ...header,
    title: 'line1\nline2\ttab "quoted" \\ backslash',
  }
  const serialized = serializeDocument(tricky, "b")
  const parsed = parseDocument(serialized)
  assert.equal(parsed.header.title, tricky.title)
  assert.ok(!serialized.includes("line1\nline2"), "value newline must be escaped")
})

test("serializeHeaderValue rejects non-strings", () => {
  assert.throws(() => serializeHeaderValue(3), FormatError)
  assert.throws(() => serializeHeaderValue(null), FormatError)
})

test("serializeHeader rejects unknown and missing fields", () => {
  const base = fixtures.serializationCases[0].header
  assert.throws(() => serializeHeader({ ...base, extra: "x" }), (error) => error.problem === "unknown_field")
  const { description, ...missing } = base
  assert.throws(() => serializeHeader(missing), (error) => error.problem === "missing_field")
  assert.throws(() => serializeHeader({ ...base, title: "" }), (error) => error.problem === "missing_field")
})

test("canonicalRevision requires all seven identity fields", () => {
  const identity = { ...fixtures.revisionCases[0].identity }
  for (const key of REVISION_KEYS) {
    const broken = { ...identity }
    delete broken[key]
    assert.throws(() => canonicalRevision(broken, "body"), FormatError, key)
  }
  for (const key of REVISION_KEYS) {
    assert.throws(() => canonicalRevision({ ...identity, [key]: "" }, "body"), FormatError, key)
  }
  assert.doesNotThrow(() => canonicalRevision(identity, ""))
})

test("body final-newline distinction changes the revision", () => {
  const identity = fixtures.revisionCases[0].identity
  const withNewline = canonicalRevision(identity, "body\n")
  const withoutNewline = canonicalRevision(identity, "body")
  assert.notEqual(withNewline, withoutNewline)
})
