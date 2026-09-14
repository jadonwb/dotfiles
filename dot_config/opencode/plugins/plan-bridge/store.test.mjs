// Tests for the shared artifact registry (store.mjs).
// Run from the chezmoi working directory:
//   node --test dot_config/opencode/plugins/plan-bridge/store.test.mjs
// Fixtures live under /tmp/opencode; no network, no model, no session admission.

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { createStore, defaultStateRoot, StoreError } from "./store.mjs"
import { canonicalRevision, documentRevision, parseDocument } from "./format.mjs"

const FIXTURE_BASE = join("/tmp", "opencode")

async function makeStore(t) {
  await mkdir(FIXTURE_BASE, { recursive: true })
  const root = await mkdtemp(join(FIXTURE_BASE, "plan-bridge-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { store: createStore({ root }), root }
}

const LOCATION_A = "/tmp/opencode/plan-bridge-fixture-location-a"
const LOCATION_B = "/tmp/opencode/plan-bridge-fixture-location-b"
const OWNER = "ses_owner0000000000000000"
const OTHER_OWNER = "ses_other0000000000000000"

const SHARED_BODY = [
  "## Changes",
  "",
  "- First item.",
  "- Second item.",
  "",
].join("\n")

const BODY_WITHOUT_FINAL_NEWLINE = "## Observation\n- Kept exactly as supplied."

function expectSharedDocument(text, { id, kind, title, description, owner, author, status }) {
  const parsed = parseDocument(text)
  assert.equal(parsed.header.id, id)
  assert.equal(parsed.header.kind, kind)
  assert.equal(parsed.header.title, title)
  assert.equal(parsed.header.description, description)
  assert.equal(parsed.header.owner_session_id, owner)
  assert.equal(parsed.header.author_session_id, author)
  assert.equal(parsed.header.status, status)
  assert.ok(parsed.header.created_at.length > 0)
  assert.ok(parsed.header.updated_at.length > 0)
  return parsed
}

test("default root is under the opencode state directory", () => {
  const root = defaultStateRoot()
  assert.ok(root.endsWith(join("opencode", "plan-bridge")))
})

// ---------------------------------------------------------------------------
// Shared artifacts (shared-markdown)
// ---------------------------------------------------------------------------

test("publish stores frontmatter documents; plans start draft, evidence/review published", async (t) => {
  const { store } = await makeStore(t)

  const plan = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })
  assert.match(plan.artifactID, /^art_[a-f0-9]{8}$/)
  assert.equal(plan.status, "draft")
  assert.equal(plan.kind, "plan")
  assert.equal(plan.ownerSessionID, OWNER)
  assert.equal(plan.authorSessionID, OWNER)

  // The file is exactly the frontmatter document; the body is verbatim, no H1
  // is inserted, and the final-newline distinction is preserved.
  const onDisk = await readFile(plan.path, "utf8")
  const parsed = expectSharedDocument(onDisk, {
    id: plan.artifactID,
    kind: "plan",
    title: "Shared plan",
    description: "A shared plan artifact.",
    owner: OWNER,
    author: OWNER,
    status: "draft",
  })
  assert.equal(parsed.body, SHARED_BODY)
  assert.ok(onDisk.endsWith("- Second item.\n"))
  // The revision covers the identity header plus the exact body bytes.
  assert.equal(plan.revision, canonicalRevision(parsed.header, parsed.body))
  // The immutable snapshot is a complete document with creation-time status.
  const snapshotText = await readFile(plan.snapshot, "utf8")
  assert.equal(snapshotText, onDisk)
  assert.equal(documentRevision(snapshotText), plan.revision)

  const evidence = await store.publishArtifact({
    kind: "evidence",
    ownerSessionID: OWNER,
    authorSessionID: OTHER_OWNER,
    location: LOCATION_A,
    title: "Search note",
    description: "Evidence artifact.",
    body: BODY_WITHOUT_FINAL_NEWLINE,
  })
  assert.equal(evidence.status, "published")
  const evidenceText = await readFile(evidence.path, "utf8")
  assert.ok(evidenceText.endsWith("Kept exactly as supplied."), "a body without final newline stays without one")
  const review = await store.publishArtifact({
    kind: "review",
    ownerSessionID: OWNER,
    authorSessionID: OTHER_OWNER,
    location: LOCATION_A,
    title: "Review report",
    description: "Review artifact.",
    body: SHARED_BODY,
  })
  assert.equal(review.status, "published")
})

test("summaries, views and describe expose record metadata", async (t) => {
  const { store } = await makeStore(t)
  const plan = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })

  const summaries = await store.listArtifacts({ location: LOCATION_A })
  assert.equal(summaries.length, 1)

  const view = await store.getArtifact({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.equal(view.revision, plan.revision)

  const described = await store.describeArtifact({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.equal(described.content, undefined, "no content without a snapshot read")
})

test("shared patch applies body replacements and tracks the acting author", async (t) => {
  const { store } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })

  const patched = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    authorSessionID: OTHER_OWNER,
    expectedRevision: published.revision,
    replacements: [{ oldText: "- First item.", newText: "- First item, revised." }],
  })
  const expectedBody = SHARED_BODY.replace("- First item.", "- First item, revised.")
  const parsed = parseDocument(await readFile(patched.path, "utf8"))
  assert.equal(parsed.body, expectedBody)
  assert.equal(parsed.header.author_session_id, OTHER_OWNER, "the new revision records the acting author")
  assert.equal(patched.authorSessionID, OTHER_OWNER)
  assert.equal(patched.title, "Shared plan")
  assert.match(patched.snapshot, /revisions\/[a-f0-9]{8}\.md$/)

  // The snapshot for the new revision is immutable and complete.
  const snapshot = parseDocument(await readFile(patched.snapshot, "utf8"))
  assert.equal(snapshot.body, expectedBody)
  assert.equal(snapshot.header.status, "draft")
  assert.equal(snapshot.header.author_session_id, OTHER_OWNER)
  assert.equal(documentRevision(await readFile(patched.snapshot, "utf8")), patched.revision)

  // Title-only update through an explicit structured field changes the
  // identity revision without touching the body.
  const retitled = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    expectedRevision: patched.revision,
    title: "Shared plan (v2)",
    description: "Updated description.",
  })
  const retitledParsed = parseDocument(await readFile(retitled.path, "utf8"))
  assert.equal(retitledParsed.header.title, "Shared plan (v2)")
  assert.equal(retitledParsed.header.description, "Updated description.")
  assert.equal(retitledParsed.body, expectedBody)
  assert.notEqual(retitled.revision, patched.revision)

  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.revisions.length, 3)
  assert.deepEqual(
    view.revisions.map((entry) => entry.authorSessionID),
    [OWNER, OTHER_OWNER, OWNER],
  )
})

test("shared patch rejects invalid input without mutating", async (t) => {
  const { store } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })
  const base = {
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    expectedRevision: published.revision,
  }

  await assert.rejects(
    store.patchArtifact({ ...base, replacements: [{ oldText: "missing text", newText: "x" }] }),
    (error) => error instanceof StoreError && error.code === "patch_conflict",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, replacements: [{ oldText: "Second item.", newText: "Second item." }] }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, replacements: [{ oldText: "Second item.", newText: "two" }, { oldText: "Second item.", newText: "three" }] }),
    (error) => error instanceof StoreError && error.code === "patch_conflict",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, expectedRevision: "00000000", replacements: [{ oldText: "Second item.", newText: "two" }] }),
    (error) => error instanceof StoreError && error.code === "stale_revision",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, ownerSessionID: OTHER_OWNER, replacements: [{ oldText: "Second item.", newText: "two" }] }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, location: LOCATION_B, replacements: [{ oldText: "Second item.", newText: "two" }] }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, replacements: [] }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, replacements: [{ oldText: "Second item.", newText: "two" }], authorSessionID: "" }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.revision, published.revision)
  assert.equal(view.revisions.length, 1)
})

test("approval regenerates the frontmatter with status approved but keeps the content revision", async (t) => {
  const { store } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })
  const snapshotBefore = await readFile(published.snapshot, "utf8")

  const approved = await store.approveArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    revision: published.revision,
    requestID: "req_shared-approve-0001",
  })
  assert.equal(approved.deduplicated, false)
  assert.equal(approved.artifact.status, "approved")
  assert.equal(approved.artifact.revision, published.revision, "approval does not change the content revision")

  // The current file shows the lifecycle status; the snapshot keeps its
  // creation-time status.
  const currentText = await readFile(published.path, "utf8")
  const current = parseDocument(currentText)
  assert.equal(current.header.status, "approved")
  assert.equal(documentRevision(currentText), published.revision)
  const snapshotAfter = await readFile(published.snapshot, "utf8")
  assert.equal(snapshotAfter, snapshotBefore)
  assert.equal(parseDocument(snapshotAfter).header.status, "draft")

  // Approved plans are frozen against artifact patches.
  await assert.rejects(
    store.patchArtifact({
      artifactID: published.artifactID,
      location: LOCATION_A,
      ownerSessionID: OWNER,
      authorSessionID: OWNER,
      expectedRevision: published.revision,
      replacements: [{ oldText: "Second", newText: "Third" }],
    }),
    (error) => error instanceof StoreError && error.code === "approved",
  )

  // Repeated approval of the same revision deduplicates.
  const again = await store.approveArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    revision: published.revision,
    requestID: "req_shared-approve-0002",
  })
  assert.equal(again.deduplicated, true)
  assert.equal(again.requestID, "req_shared-approve-0001")

  // Stale approvals are rejected.
  await assert.rejects(
    store.approveArtifact({
      artifactID: published.artifactID,
      location: LOCATION_A,
      revision: "33333333",
      requestID: "req_shared-approve-0003",
    }),
    (error) => error instanceof StoreError && error.code === "stale_revision",
  )
})

test("only plan artifacts can be approved", async (t) => {
  const { store } = await makeStore(t)
  for (const kind of ["evidence", "review"]) {
    const published = await store.publishArtifact({
      kind,
      ownerSessionID: OWNER,
      authorSessionID: OWNER,
      location: LOCATION_A,
      title: `A ${kind}`,
      description: `A ${kind} artifact.`,
      body: SHARED_BODY,
    })
    await assert.rejects(
      store.approveArtifact({
        artifactID: published.artifactID,
        location: LOCATION_A,
        revision: published.revision,
        requestID: `req_approve-${kind}-0001`,
      }),
      (error) => error instanceof StoreError && error.code === "validation",
    )
    const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
    assert.equal(view.status, "published")
    assert.equal(view.approval, null)
  }
})

test("historical revisions come from immutable snapshots; missing snapshots fail visibly", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })
  await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    authorSessionID: OTHER_OWNER,
    expectedRevision: published.revision,
    replacements: [{ oldText: "- First item.", newText: "- First item, revised." }],
  })

  const first = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A, revision: published.revision })
  assert.equal(first.requestedRevision, published.revision)
  assert.equal(parseDocument(first.content).header.status, "draft", "historical content keeps its creation-time status")
  assert.equal(parseDocument(first.content).header.author_session_id, OWNER)
  assert.equal(first.snapshot, published.snapshot)

  const unknownRevision = "44444444"
  await assert.rejects(
    store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A, revision: unknownRevision }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )

  // Data loss is visible: removing the current revision's snapshot breaks
  // every read that needs its content, while record-only reads still work.
  const revisionsDir = join(root, "artifacts", published.artifactID, "revisions")
  const listed = await store.listArtifacts({ location: LOCATION_A })
  assert.equal(listed.length, 1, "summaries do not load snapshot contents")
  const currentRevision = listed[0].revision
  assert.notEqual(currentRevision, published.revision)
  await rm(join(revisionsDir, currentRevision + ".md"))
  await assert.rejects(
    store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A }),
    (error) => error instanceof StoreError && error.code === "io",
  )
  await assert.rejects(
    store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A, revision: currentRevision }),
    (error) => error instanceof StoreError && error.code === "io",
  )
  await assert.rejects(
    store.patchArtifact({
      artifactID: published.artifactID,
      location: LOCATION_A,
      ownerSessionID: OWNER,
      authorSessionID: OWNER,
      expectedRevision: currentRevision,
      replacements: [{ oldText: "Second", newText: "Third" }],
    }),
    (error) => error instanceof StoreError && error.code === "io",
  )
  const stillListed = await store.listArtifacts({ location: LOCATION_A })
  assert.equal(stillListed.length, 1, "summaries do not load snapshot contents")
})

test("shared-markdown interrupted writes: current.md is rebuilt from record and snapshot", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })

  // Simulate a crash between current.md and record.json writes.
  await writeFile(join(root, "artifacts", published.artifactID, "current.md"), "half-written garbage\n")

  const patched = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    expectedRevision: published.revision,
    replacements: [{ oldText: "First", newText: "Third" }],
  })
  const currentText = await readFile(patched.path, "utf8")
  const parsed = parseDocument(currentText)
  assert.equal(parsed.body, SHARED_BODY.replace("First", "Third"))
  assert.equal(parsed.header.status, "draft")
  assert.equal(documentRevision(currentText), patched.revision)
})

test("shared publish validation: kind enum, limits and whitespace-only or control-character fields", async (t) => {
  const { store } = await makeStore(t)
  const base = { ownerSessionID: OWNER, authorSessionID: OWNER, location: LOCATION_A, title: "t", description: "d", body: "b" }
  await assert.rejects(store.publishArtifact({ ...base, kind: "memo" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: 3 }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", ownerSessionID: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", authorSessionID: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", title: "   " }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", description: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", body: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", body: "x".repeat(2_000_001) }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", location: "relative" }), (error) => error instanceof StoreError && error.code === "validation")
  // Control characters in visible fields are rejected (single-line headers).
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", title: "bad\u0000title" }), (error) => error instanceof StoreError && error.code === "validation")
  // A newline inside a scalar is legal: the format layer escapes it onto one
  // line, so the stored document must still parse and round-trip.
  const multiline = await store.publishArtifact({ ...base, kind: "plan", description: "first line\nsecond line" })
  const multilineParsed = parseDocument(await readFile(multiline.path, "utf8"))
  assert.equal(multilineParsed.header.description, "first line\nsecond line")
})

test("describeArtifact returns record-only metadata without touching snapshots", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "review",
    ownerSessionID: OWNER,
    authorSessionID: OTHER_OWNER,
    location: LOCATION_A,
    title: "Review",
    description: "Review artifact.",
    body: SHARED_BODY,
  })
  const described = await store.describeArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(described.kind, "review")
  assert.equal(described.status, "published")
  assert.equal(described.ownerSessionID, OWNER)
  assert.equal(described.authorSessionID, OTHER_OWNER)
  assert.equal(described.location, LOCATION_A)
  assert.equal(described.content, undefined, "no content without a snapshot read")

  // Record-only reads survive snapshot loss.
  await rm(join(root, "artifacts", published.artifactID, "revisions", published.revision + ".md"), { force: true })
  const stillDescribed = await store.describeArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(stillDescribed.revision, published.revision)
})

// ---------------------------------------------------------------------------
// Malformed IDs are validation errors
// ---------------------------------------------------------------------------

test("malformed IDs are validation errors (path traversal cannot escape the store)", async (t) => {
  const { store } = await makeStore(t)
  for (const bad of ["../../etc", "", "art_0000000", "art_0000000g", "art_" + "a".repeat(26), "ART_00000001", "art_00000001extra"]) {
    await assert.rejects(
      store.getArtifact({ artifactID: bad, location: LOCATION_A }),
      (error) => error instanceof StoreError && error.code === "validation",
      `expected validation error for ${JSON.stringify(bad)}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Feedback, delivery bookkeeping and locks (shared-markdown)
// ---------------------------------------------------------------------------

test("feedback deduplicates by request ID and rejects stale displayed revisions", async (t) => {
  const { store } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })
  const requestID = "req_test-feedback-0001"

  const first = await store.addArtifactFeedback({
    artifactID: published.artifactID,
    location: LOCATION_A,
    revision: published.revision,
    requestID,
    question: "Is the second item still needed?",
  })
  assert.equal(first.deduplicated, false)
  assert.equal(first.delivery.state, "pending")

  const duplicate = await store.addArtifactFeedback({
    artifactID: published.artifactID,
    location: LOCATION_A,
    revision: published.revision,
    requestID,
    question: "A different question must not overwrite the recorded one.",
  })
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.feedback.question, "Is the second item still needed?")
  assert.deepEqual(duplicate.delivery, first.delivery)

  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.feedback.length, 1)

  await assert.rejects(
    store.addArtifactFeedback({
      artifactID: published.artifactID,
      location: LOCATION_A,
      revision: "11111111",
      requestID: "req_test-feedback-0002",
      question: "Stale",
    }),
    (error) => error instanceof StoreError && error.code === "stale_revision",
  )
})

test("delivery failure preserves the decision; the same requestID retries and reports honestly", async (t) => {
  const { store } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })

  await store.approveArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    revision: published.revision,
    requestID: "req_approval-del-1",
  })

  const failed = await store.markArtifactDelivery({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID: "req_approval-del-1",
    state: "failed",
    error: "owner session unavailable",
  })
  assert.equal(failed.delivery.state, "failed")
  assert.equal(failed.delivery.error, "owner session unavailable")

  // The recorded decision survives the failed notification.
  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.status, "approved")
  assert.equal(view.approval.revision, published.revision)

  // Explicit retry with the same request ID records delivery honestly.
  const delivered = await store.markArtifactDelivery({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID: "req_approval-del-1",
    state: "delivered",
  })
  assert.equal(delivered.delivery.state, "delivered")
  assert.ok(delivered.delivery.deliveredAt)

  // Deliveries are location-scoped like every other lookup.
  await assert.rejects(
    store.markArtifactDelivery({
      artifactID: published.artifactID,
      location: LOCATION_B,
      requestID: "req_approval-del-1",
      state: "delivered",
    }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("feedback input byte limits: oversized question or excerpt leaves no submission behind", async (t) => {
  const { store } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })
  const artifactID = published.artifactID

  // Multibyte UTF-8: 8193 two-byte characters are 16386 bytes > 16384.
  const oversizedQuestion = "é".repeat(8193)
  await assert.rejects(
    store.addArtifactFeedback({
      artifactID,
      location: LOCATION_A,
      revision: published.revision,
      requestID: "req_limit-q-1",
      question: oversizedQuestion,
    }),
    (error) => error instanceof StoreError && error.code === "validation" && error.data.limit === 16 * 1024,
  )

  await assert.rejects(
    store.addArtifactFeedback({
      artifactID,
      location: LOCATION_A,
      revision: published.revision,
      requestID: "req_limit-s-1",
      question: "still fine",
      selectedText: "x".repeat(64 * 1024 + 1),
    }),
    (error) => error instanceof StoreError && error.code === "validation" && error.data.limit === 64 * 1024,
  )

  // Rejected input left no submission behind, and nothing was delivered.
  const view = await store.getArtifact({ artifactID, location: LOCATION_A })
  assert.deepEqual(view.feedback, [])

  // Exactly-at-limit inputs in multibyte UTF-8 are accepted.
  const questionAtLimit = "é".repeat(8192) // 16384 bytes
  const selectionAtLimit = "é".repeat(32768) // 65536 bytes
  const accepted = await store.addArtifactFeedback({
    artifactID,
    location: LOCATION_A,
    revision: published.revision,
    requestID: "req_limit-ok-1",
    question: questionAtLimit,
    selectedText: selectionAtLimit,
  })
  assert.equal(accepted.deduplicated, false)
  const after = await store.getArtifact({ artifactID, location: LOCATION_A })
  assert.equal(after.feedback.length, 1)
  assert.equal(after.feedback[0].requestID, "req_limit-ok-1")
})

test("an existing artifact lock is reported, not bypassed; release restores mutations", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
  })
  const lockPath = join(root, "artifacts", published.artifactID, "lock")
  await writeFile(lockPath, "held\n", { mode: 0o600 })

  await assert.rejects(
    store.patchArtifact({
      artifactID: published.artifactID,
      location: LOCATION_A,
      ownerSessionID: OWNER,
      authorSessionID: OWNER,
      expectedRevision: published.revision,
      replacements: [{ oldText: "First", newText: "Revised" }],
    }),
    (error) => error instanceof StoreError && error.code === "lock_conflict",
  )

  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.revision, published.revision)

  // Stale-lock recovery: removing the file by hand recovers without
  // discarding the record; the next mutation reconciles derived files.
  await rm(lockPath, { force: true })
  const patched = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    authorSessionID: OWNER,
    expectedRevision: published.revision,
    replacements: [{ oldText: "First", newText: "Revised" }],
  })
  assert.notEqual(patched.revision, published.revision)
})
