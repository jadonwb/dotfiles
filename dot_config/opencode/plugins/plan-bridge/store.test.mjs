// Tests for the shared artifact registry (store.mjs).
// Run from the chezmoi working directory:
//   mise exec -- node --experimental-strip-types --test dot_config/opencode/plugins/plan-bridge/store.test.mjs
// Fixtures live under /tmp/opencode; no network, no model, no session admission.

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { createStore, defaultStateRoot, StoreError } from "./store.mjs"
import { renderView } from "./format.mjs"

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

const SHARED_BODY = ["## Changes", "", "- First item.", "- Second item.", ""].join("\n")
const VERBATIM_BODY = "## Changes\n+ first\n"

function recordPathOf(root, artifactID) {
  return join(root, "artifacts", artifactID, "record.json")
}

async function readRecord(root, artifactID) {
  return JSON.parse(await readFile(recordPathOf(root, artifactID), "utf8"))
}

function publish(store, over = {}) {
  return store.publishArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    location: LOCATION_A,
    title: "Shared plan",
    description: "A shared plan artifact.",
    body: SHARED_BODY,
    ...over,
  })
}

test("default root is under the opencode state directory", () => {
  const root = defaultStateRoot()
  assert.ok(root.endsWith(join("opencode", "plan-bridge")))
})

test("publish stores the verbatim body and a formatted view; plans start draft, evidence/review published", async (t) => {
  const { store, root } = await makeStore(t)

  const plan = await publish(store)
  assert.match(plan.artifactID, /^art_[a-f0-9]{8}$/)
  assert.equal(plan.status, "draft")
  assert.equal(plan.kind, "plan")
  assert.equal(plan.ownerSessionID, OWNER)
  assert.equal(plan.path, join(root, "artifacts", plan.artifactID, "current.md"))

  const record = await readRecord(root, plan.artifactID)
  assert.equal(record.body, SHARED_BODY, "the record keeps the verbatim body")

  // The generated view carries the minimal frontmatter and is Prettier output.
  const view = await readFile(plan.path, "utf8")
  assert.match(view, /^---\nid: "art_[a-f0-9]{8}"\nkind: "plan"\nstatus: "draft"\ntitle: "Shared plan"\n---\n/)
  assert.ok(view.includes("\n## Changes\n"), "the body is rendered below the frontmatter")
  assert.equal(await renderView({ id: plan.id, kind: plan.kind, status: plan.status, title: plan.title }, record.body), view, "rendering is idempotent")

  const evidence = await publish(store, { kind: "evidence", title: "Search note", body: "# Note\n" })
  assert.equal(evidence.status, "published")
  const review = await publish(store, { kind: "review", title: "Review report", body: "# Report\n" })
  assert.equal(review.status, "published")
})

test("patching uses the verbatim body, not the formatted view", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await publish(store, { body: VERBATIM_BODY })

  // The view rewrites "+ first" to "- first"; the record does not.
  const view = await readFile(published.path, "utf8")
  assert.ok(view.includes("- first"))
  assert.ok(!view.includes("+ first"))
  assert.equal((await readRecord(root, published.artifactID)).body, VERBATIM_BODY)

  // Two patches using exact verbatim text, without rereading the view.
  const first = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    replacements: [{ oldText: "+ first", newText: "+ second" }],
  })
  assert.equal((await readRecord(root, published.artifactID)).body, "## Changes\n+ second\n")
  await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    replacements: [{ oldText: "+ second", newText: "+ third" }],
  })
  const finalRecord = await readRecord(root, published.artifactID)
  assert.equal(finalRecord.body, "## Changes\n+ third\n")
  const finalView = await readFile(first.path, "utf8")
  assert.ok(finalView.includes("- third"))
  assert.ok(finalView.includes('status: "draft"'))
})

test("patch rejects invalid input without mutating", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await publish(store)
  const base = {
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
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
    store.patchArtifact({
      ...base,
      replacements: [
        { oldText: "Second item.", newText: "two" },
        { oldText: "Second item.", newText: "three" },
      ],
    }),
    (error) => error instanceof StoreError && error.code === "patch_conflict",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, ownerSessionID: OTHER_OWNER, replacements: [{ oldText: "Second item.", newText: "two" }] }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )
  await assert.rejects(
    store.patchArtifact({ ...base, location: LOCATION_B, replacements: [{ oldText: "Second item.", newText: "two" }] }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
  await assert.rejects(store.patchArtifact({ ...base, replacements: [] }), (error) => error instanceof StoreError && error.code === "validation")
  assert.equal((await readRecord(root, published.artifactID)).body, SHARED_BODY)
})

test("a patch that would empty the body is rejected without corrupting the artifact", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await publish(store, { kind: "evidence", title: "Note", body: "# Note\n" })

  await assert.rejects(
    store.patchArtifact({
      artifactID: published.artifactID,
      location: LOCATION_A,
      ownerSessionID: OWNER,
      replacements: [{ oldText: "# Note\n", newText: "" }],
    }),
    (error) => error instanceof StoreError && error.code === "validation",
  )

  // The record is untouched and every later read remains usable.
  assert.equal((await readRecord(root, published.artifactID)).body, "# Note\n")
  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.ok(view.content.includes("# Note"))
  const listed = await store.listArtifacts({ location: LOCATION_A })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, published.artifactID)
})

test("get repairs a current.md that diverged from the authoritative record", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await publish(store, { kind: "evidence", title: "Note", body: "# One\n" })
  const currentPath = join(root, "artifacts", published.artifactID, "current.md")

  // Simulate a failure between the view write and the record write.
  await writeFile(currentPath, '---\nid: "art_00000000"\nkind: "evidence"\nstatus: "approved"\ntitle: "Diverged"\n---\n\n# Two\n')
  const expected = await renderView({ id: published.id, kind: published.kind, status: published.status, title: published.title }, "# One\n")

  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.content, expected, "the served view is record-derived")
  assert.equal(view.status, "published")
  assert.equal(await readFile(currentPath, "utf8"), expected, "the divergent file is repaired on read")

  // Patching then matches the record body, not the old divergent view.
  const patched = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    replacements: [{ oldText: "# One", newText: "# Three" }],
  })
  assert.equal((await readRecord(root, published.artifactID)).body, "# Three\n")
  assert.ok((await readFile(patched.path, "utf8")).includes("# Three"))
})

test("title and description updates rewrite the view header without changing the body", async (t) => {
  const { store } = await makeStore(t)
  const published = await publish(store)
  const patched = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    title: "Shared plan (v2)",
    description: "Updated description.",
  })
  assert.equal(patched.title, "Shared plan (v2)")
  assert.equal(patched.description, "Updated description.")
  const view = await readFile(patched.path, "utf8")
  assert.match(view, /title: "Shared plan \(v2\)"/)
  assert.ok(view.includes("- Second item."))
})

test("approval sets the status, freezes patches, and deduplicates", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await publish(store)

  const approved = await store.approveArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID: "req_shared-approve-0001",
  })
  assert.equal(approved.deduplicated, false)
  assert.equal(approved.artifact.status, "approved")
  assert.match(await readFile(published.path, "utf8"), /^---\nid: "art_[a-f0-9]{8}"\nkind: "plan"\nstatus: "approved"\n/)

  await assert.rejects(
    store.patchArtifact({
      artifactID: published.artifactID,
      location: LOCATION_A,
      ownerSessionID: OWNER,
      replacements: [{ oldText: "Second", newText: "Third" }],
    }),
    (error) => error instanceof StoreError && error.code === "approved",
  )

  const again = await store.approveArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID: "req_shared-approve-0002",
  })
  assert.equal(again.deduplicated, true)
  assert.equal(again.requestID, "req_shared-approve-0001")
  assert.equal((await readRecord(root, published.artifactID)).approval.requestID, "req_shared-approve-0001")
})

test("only plan artifacts can be approved", async (t) => {
  const { store } = await makeStore(t)
  for (const kind of ["evidence", "review"]) {
    const published = await publish(store, { kind, title: `A ${kind}` })
    await assert.rejects(
      store.approveArtifact({ artifactID: published.artifactID, location: LOCATION_A, requestID: `req_approve-${kind}-0001` }),
      (error) => error instanceof StoreError && error.code === "validation",
    )
    const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
    assert.equal(view.status, "published")
    assert.equal(view.approval, null)
  }
})

test("list and get expose the latest state only", async (t) => {
  const { store } = await makeStore(t)
  const published = await publish(store)
  const summaries = await store.listArtifacts({ location: LOCATION_A })
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].id, published.artifactID)
  assert.equal(summaries[0].revision, undefined)
  assert.equal(summaries[0].authorSessionID, undefined)

  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.path, published.path)
  assert.equal(view.content, await readFile(published.path, "utf8"))
  assert.deepEqual(view.feedback, [])
  assert.equal(view.approval, null)

  await assert.rejects(
    store.getArtifact({ artifactID: published.artifactID, location: LOCATION_B }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("publish validation: kind enum, limits and control characters", async (t) => {
  const { store } = await makeStore(t)
  const base = { ownerSessionID: OWNER, location: LOCATION_A, title: "t", description: "d", body: "b" }
  await assert.rejects(store.publishArtifact({ ...base, kind: "memo" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", ownerSessionID: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", title: "   " }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", body: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(
    store.publishArtifact({ ...base, kind: "plan", body: "x".repeat(2_000_001) }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", location: "relative" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.publishArtifact({ ...base, kind: "plan", title: "bad\u0000title" }), (error) => error instanceof StoreError && error.code === "validation")
})

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

test("feedback deduplicates by request ID and enforces byte limits", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await publish(store)
  const requestID = "req_test-feedback-0001"

  const first = await store.addArtifactFeedback({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID,
    question: "Is the second item still needed?",
  })
  assert.equal(first.deduplicated, false)
  assert.equal(first.delivery.state, "pending")

  const duplicate = await store.addArtifactFeedback({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID,
    question: "A different question must not overwrite the recorded one.",
  })
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.feedback.question, "Is the second item still needed?")

  const oversizedQuestion = "é".repeat(8193)
  await assert.rejects(
    store.addArtifactFeedback({
      artifactID: published.artifactID,
      location: LOCATION_A,
      requestID: "req_limit-q-1",
      question: oversizedQuestion,
    }),
    (error) => error instanceof StoreError && error.code === "validation" && error.data.limit === 16 * 1024,
  )
  await assert.rejects(
    store.addArtifactFeedback({
      artifactID: published.artifactID,
      location: LOCATION_A,
      requestID: "req_limit-s-1",
      question: "still fine",
      selectedText: "x".repeat(64 * 1024 + 1),
    }),
    (error) => error instanceof StoreError && error.code === "validation" && error.data.limit === 64 * 1024,
  )
  assert.equal((await readRecord(root, published.artifactID)).feedback.length, 1)
})

test("delivery bookkeeping preserves the decision and is location-scoped", async (t) => {
  const { store } = await makeStore(t)
  const published = await publish(store)
  await store.approveArtifact({ artifactID: published.artifactID, location: LOCATION_A, requestID: "req_approval-del-1" })

  const failed = await store.markArtifactDelivery({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID: "req_approval-del-1",
    state: "failed",
    error: "owner session unavailable",
  })
  assert.equal(failed.delivery.state, "failed")
  assert.equal(failed.delivery.error, "owner session unavailable")

  const view = await store.getArtifact({ artifactID: published.artifactID, location: LOCATION_A })
  assert.equal(view.status, "approved")
  assert.equal(view.approval.requestID, "req_approval-del-1")

  const delivered = await store.markArtifactDelivery({
    artifactID: published.artifactID,
    location: LOCATION_A,
    requestID: "req_approval-del-1",
    state: "delivered",
  })
  assert.equal(delivered.delivery.state, "delivered")
  assert.ok(delivered.delivery.deliveredAt)

  await assert.rejects(
    store.markArtifactDelivery({ artifactID: published.artifactID, location: LOCATION_B, requestID: "req_approval-del-1", state: "delivered" }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("an existing artifact lock is reported, not bypassed; release restores mutations", async (t) => {
  const { store, root } = await makeStore(t)
  const published = await publish(store)
  const lockPath = join(root, "artifacts", published.artifactID, "lock")
  await writeFile(lockPath, "held\n", { mode: 0o600 })

  await assert.rejects(
    store.patchArtifact({
      artifactID: published.artifactID,
      location: LOCATION_A,
      ownerSessionID: OWNER,
      replacements: [{ oldText: "First", newText: "Revised" }],
    }),
    (error) => error instanceof StoreError && error.code === "lock_conflict",
  )

  // Stale-lock recovery: removing the file by hand recovers without discarding
  // the record.
  await rm(lockPath, { force: true })
  const patched = await store.patchArtifact({
    artifactID: published.artifactID,
    location: LOCATION_A,
    ownerSessionID: OWNER,
    replacements: [{ oldText: "First", newText: "Revised" }],
  })
  assert.ok((await readFile(patched.path, "utf8")).includes("- Revised item."))
})
