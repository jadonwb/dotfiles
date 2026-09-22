// Tests for the shared artifact registry (store.mjs).
// Run from the chezmoi working directory:
//   mise exec -- node --experimental-strip-types --test dot_config/external_opencode/plugins/plan-bridge/store.test.mjs
// Fixtures live under /tmp/opencode; no network, no model, no session admission.

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { createStore, defaultStateRoot, StoreError } from "./store.mjs"
import { bodyOf, renderView } from "./format.mjs"

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
const WRITER = "ses_writer000000000000000"
const OTHER_WRITER = "ses_otherwriter00000000000"
const AUTHOR = "Planner"

function recordPathOf(root, artifactID) {
  return join(root, "artifacts", artifactID, "record.json")
}

async function readRecord(root, artifactID) {
  return JSON.parse(await readFile(recordPathOf(root, artifactID), "utf8"))
}

async function createPlan(store, over = {}) {
  return store.createArtifact({
    kind: "plan",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: AUTHOR,
    location: LOCATION_A,
    title: "Structured plan",
    description: "A structured plan artifact.",
    workingDirectory: LOCATION_A,
    ...over,
  })
}

async function createEvidence(store, over = {}) {
  return store.createArtifact({
    kind: "evidence",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: "Search",
    location: LOCATION_A,
    title: "Structured evidence",
    description: "A structured evidence artifact.",
    ...over,
  })
}

async function createReview(store, over = {}) {
  return store.createArtifact({
    kind: "review",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: "Review",
    location: LOCATION_A,
    title: "Structured review",
    description: "A structured review artifact.",
    ...over,
  })
}

/** Convenience: create, fill, finalize, and approve a plan in one helper. */
async function createApprovedPlan(store) {
  const plan = await createPlan(store)
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Refine the handoffs." })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Run the tests." })
  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Replace the plan item model with flat prose fields.",
  })
  await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  await store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_approved-for-report" })
  return plan
}

test("default root is under the opencode state directory", () => {
  const root = defaultStateRoot()
  assert.ok(root.endsWith(join("opencode", "plan-bridge")))
})

test("createArtifact initializes flat records: plan prose/evidence, evidence overview/findings, review outcome/summary/findings, report link", async (t) => {
  const { store, root } = await makeStore(t)

  const plan = await createPlan(store)
  assert.match(plan.artifactID, /^art_[a-f0-9]{8}$/)
  assert.equal(plan.status, "draft")
  assert.equal(plan.finalized, false)
  assert.equal(plan.kind, "plan")
  assert.equal(plan.ownerSessionID, OWNER)
  assert.equal(plan.writerSessionID, WRITER, "the creating session is the sole mutation authority")
  assert.equal(plan.primaryAuthor, AUTHOR, "primaryAuthor is immutable frontend metadata")
  assert.equal(plan.path, join(root, "artifacts", plan.artifactID, "current.md"))

  const record = await readRecord(root, plan.artifactID)
  assert.equal(record.body, undefined, "the flat model has no whole-document body field")
  assert.equal(record.sections, undefined, "the flat plan model has no ordered sections field")
  assert.equal(record.workingDirectory, LOCATION_A)
  assert.equal(record.goalScope, "")
  assert.equal(record.intendedChanges, "")
  assert.equal(record.context, "")
  assert.equal(record.checks, "")
  assert.deepEqual(record.evidence, [], "evidence membership starts empty")
  assert.equal(record.finalized, false)

  const evidence = await createEvidence(store)
  assert.equal(evidence.status, "draft", "evidence starts draft until finalized")
  assert.equal(evidence.finalized, false)
  const evidenceRecord = await readRecord(root, evidence.artifactID)
  assert.equal(evidenceRecord.question, null)
  assert.equal(evidenceRecord.summary, "")
  assert.equal(evidenceRecord.limitations, "")
  assert.deepEqual(evidenceRecord.findings, [])

  const review = await createReview(store)
  assert.equal(review.status, "draft", "reviews start draft until finalized")
  assert.equal(review.finalized, false)
  const reviewRecord = await readRecord(root, review.artifactID)
  assert.equal(reviewRecord.outcome, null)
  assert.equal(reviewRecord.summary, "")
  assert.deepEqual(reviewRecord.findings, [])

  // Reports link to an approved plan and derive title/description from it.
  const planToReport = await createApprovedPlan(store)
  const report = await store.createArtifact({
    kind: "report",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: "Builder",
    location: LOCATION_A,
    planArtifactID: planToReport.artifactID,
  })
  assert.equal(report.kind, "report")
  assert.equal(report.title, `Report: ${planToReport.title}`, "report title derives from the plan")
  assert.equal(report.description, "A structured plan artifact.", "report description derives from the plan")
  const reportRecord = await readRecord(root, report.artifactID)
  assert.equal(reportRecord.planArtifactID, planToReport.artifactID)
  assert.equal(reportRecord.summary, "")
  assert.equal(reportRecord.changed, "")
  assert.equal(reportRecord.checks, "")
  assert.equal(reportRecord.unfinished, "")

  // A report requires an approved plan: draft plans are not_approved, non-plans invalid_kind.
  const draftPlan = await createPlan(store, { title: "Draft plan" })
  await assert.rejects(
    store.createArtifact({
      kind: "report",
      ownerSessionID: OWNER,
      writerSessionID: WRITER,
      primaryAuthor: "Builder",
      location: LOCATION_A,
      planArtifactID: draftPlan.artifactID,
    }),
    (error) => error instanceof StoreError && error.code === "not_approved",
  )
  await assert.rejects(
    store.createArtifact({
      kind: "report",
      ownerSessionID: OWNER,
      writerSessionID: WRITER,
      primaryAuthor: "Builder",
      location: LOCATION_A,
      planArtifactID: evidence.artifactID,
    }),
    (error) => error instanceof StoreError && error.code === "invalid_kind",
  )
})

test("plan whole-field sets replace goalScope/checks, clear readiness, and validate the field name", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)

  const first = await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "One goal." })
  assert.equal(first.finalized, false)
  assert.equal(first.status, "draft")
  assert.equal((await readRecord(root, plan.artifactID)).goalScope, "One goal.")

  const replaced = await store.planFieldSet({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "goalScope",
    content: "The whole field is replaced, not appended.",
  })
  assert.equal(replaced.finalized, false)
  assert.equal((await readRecord(root, plan.artifactID)).goalScope, "The whole field is replaced, not appended.")

  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Run the suite." })
  assert.equal((await readRecord(root, plan.artifactID)).checks, "Run the suite.")

  await assert.rejects(
    store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "intendedChanges", content: "x" }),
    (error) => error instanceof StoreError && error.code === "validation" && /goalScope, checks/.test(error.message),
  )
  await assert.rejects(
    store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "" }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
  await assert.rejects(
    store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: OTHER_WRITER, field: "goalScope", content: "x" }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )
  assert.equal((await readRecord(root, plan.artifactID)).goalScope, "The whole field is replaced, not appended.", "rejected calls do not mutate")
})

test("plan field patch requires the exact oldText; conflicts refuse the write and leave the record untouched", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)

  // Empty oldText initializes a previously-empty field.
  const initialized = await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Initial changes.",
  })
  assert.equal(initialized.finalized, false)
  assert.equal((await readRecord(root, plan.artifactID)).intendedChanges, "Initial changes.")

  // Exact replacement succeeds; conflict refuses with no write.
  const patched = await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "Initial changes.",
    newText: "Revised changes.",
  })
  assert.equal(patched.finalized, false)
  assert.equal((await readRecord(root, plan.artifactID)).intendedChanges, "Revised changes.")

  await assert.rejects(
    store.planFieldPatch({
      artifactID: plan.artifactID,
      location: LOCATION_A,
      writerSessionID: WRITER,
      field: "intendedChanges",
      oldText: "Stale base.",
      newText: "Whatever.",
    }),
    (error) => error instanceof StoreError && error.code === "patch_conflict" && /exactly/.test(error.message),
  )
  await assert.rejects(
    store.planFieldPatch({
      artifactID: plan.artifactID,
      location: LOCATION_A,
      writerSessionID: WRITER,
      field: "intendedChanges",
      oldText: "",
      newText: "Cannot start from empty when the field already has content.",
    }),
    (error) => error instanceof StoreError && error.code === "patch_conflict",
  )
  // The failed patches never wrote.
  assert.equal((await readRecord(root, plan.artifactID)).intendedChanges, "Revised changes.")

  assert.equal(await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "context",
    oldText: "",
    newText: "Context note.",
  }).then((result) => result.finalized), false)

  await assert.rejects(
    store.planFieldPatch({
      artifactID: plan.artifactID,
      location: LOCATION_A,
      writerSessionID: WRITER,
      field: "goalScope",
      oldText: "",
      newText: "x",
    }),
    (error) => error instanceof StoreError && error.code === "validation" && /intendedChanges, context/.test(error.message),
  )
  await assert.rejects(
    store.planFieldPatch({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: OTHER_WRITER, field: "context", oldText: "", newText: "x" }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )
})

test("plan evidence membership snapshots descriptions, requires published evidence, and deduplicates atomically", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)

  // The add takes one ordered non-empty evidenceIDs array.
  await assert.rejects(
    store.planEvidenceAddMany({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, evidenceIDs: [] }),
    (error) => error instanceof StoreError && error.code === "validation",
  )

  // Only finalized, published evidence can be attached.
  const draftEvidence = await createEvidence(store)
  await assert.rejects(
    store.planEvidenceAddMany({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, evidenceIDs: [draftEvidence.artifactID] }),
    (error) => error instanceof StoreError && error.code === "not_ready",
  )
  const reviewInStore = await createReview(store)
  await assert.rejects(
    store.planEvidenceAddMany({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, evidenceIDs: [reviewInStore.artifactID] }),
    (error) => error instanceof StoreError && error.code === "invalid_kind",
  )

  // Publish two evidence artifacts, then attach both in one atomic ordered
  // call: each immutable description snapshots beside its artifact ID.
  await store.evidenceOverviewPut({
    artifactID: draftEvidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    summary: "Evidence summary.",
  })
  await store.evidenceFinalize({ artifactID: draftEvidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  const secondEvidence = await createEvidence(store, { description: "Second evidence artifact." })
  await store.evidenceOverviewPut({
    artifactID: secondEvidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    summary: "Second.",
  })
  await store.evidenceFinalize({ artifactID: secondEvidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  const added = await store.planEvidenceAddMany({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    evidenceIDs: [secondEvidence.artifactID, draftEvidence.artifactID],
  })
  let record = await readRecord(root, plan.artifactID)
  assert.deepEqual(record.evidence, [
    { id: secondEvidence.artifactID, description: "Second evidence artifact." },
    { id: draftEvidence.artifactID, description: "A structured evidence artifact." },
  ])
  assert.equal(added.finalized, false, "membership edits clear readiness")

  // Duplicates within the input and against existing membership are no-ops:
  // existing order is preserved and no entry is re-added.
  await store.planEvidenceAddMany({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    evidenceIDs: [draftEvidence.artifactID, draftEvidence.artifactID, secondEvidence.artifactID],
  })
  record = await readRecord(root, plan.artifactID)
  assert.deepEqual(record.evidence, [
    { id: secondEvidence.artifactID, description: "Second evidence artifact." },
    { id: draftEvidence.artifactID, description: "A structured evidence artifact." },
  ])

  // A new unique ID appends after the existing membership, in input order.
  const thirdEvidence = await createEvidence(store, { description: "Third evidence artifact." })
  await store.evidenceOverviewPut({
    artifactID: thirdEvidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    summary: "Third.",
  })
  await store.evidenceFinalize({ artifactID: thirdEvidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  await store.planEvidenceAddMany({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    evidenceIDs: [thirdEvidence.artifactID],
  })
  assert.deepEqual((await readRecord(root, plan.artifactID)).evidence, [
    { id: secondEvidence.artifactID, description: "Second evidence artifact." },
    { id: draftEvidence.artifactID, description: "A structured evidence artifact." },
    { id: thirdEvidence.artifactID, description: "Third evidence artifact." },
  ])

  // One invalid member anywhere in the array leaves the plan unchanged
  // (validate-all-first, one atomic commit).
  const beforeInvalid = (await readRecord(root, plan.artifactID)).evidence
  await assert.rejects(
    store.planEvidenceAddMany({
      artifactID: plan.artifactID,
      location: LOCATION_A,
      writerSessionID: WRITER,
      evidenceIDs: [draftEvidence.artifactID, reviewInStore.artifactID],
    }),
    (error) => error instanceof StoreError && error.code === "invalid_kind",
  )
  await assert.rejects(
    store.planEvidenceAddMany({
      artifactID: plan.artifactID,
      location: LOCATION_A,
    writerSessionID: WRITER,
      evidenceIDs: [draftEvidence.artifactID, "not-an-artifact-id"],
    }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
  assert.deepEqual((await readRecord(root, plan.artifactID)).evidence, beforeInvalid, "any invalid member leaves the plan unchanged")

  // The snapshot survives later evidence cleanup/readability and is preserved.
  const structure = await store.getArtifactStructure({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.deepEqual(structure.evidence, [secondEvidence.artifactID, draftEvidence.artifactID, thirdEvidence.artifactID], "structure lists the same evidence artifact IDs only")

  // Remove by one artifact ID; a missing membership is not_found.
  await store.planEvidenceRemove({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, evidenceID: draftEvidence.artifactID })
  assert.deepEqual((await readRecord(root, plan.artifactID)).evidence, [
    { id: secondEvidence.artifactID, description: "Second evidence artifact." },
    { id: thirdEvidence.artifactID, description: "Third evidence artifact." },
  ])
  await assert.rejects(
    store.planEvidenceRemove({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, evidenceID: draftEvidence.artifactID }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
  await assert.rejects(
    store.planEvidenceAddMany({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: OTHER_WRITER, evidenceIDs: [draftEvidence.artifactID] }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )
})

test("plan finalize requires goalScope and intendedChanges; checks, Context and evidence are optional", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)

  await assert.rejects(
    store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "validation" && /goalScope/.test(error.message),
  )
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "One goal." })
  await assert.rejects(
    store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "validation" && /intendedChanges/.test(error.message),
  )
  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Change the model.",
  })
  const finalized = await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  assert.equal(finalized.finalized, true)
  assert.equal(finalized.status, "draft", "finalize does not approve")

  const again = await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  assert.equal(again.finalized, true, "finalize is idempotent")

  await assert.rejects(
    store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: OTHER_WRITER }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )

  // Any content mutation clears readiness.
  const edited = await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Run more tests." })
  assert.equal(edited.finalized, false, "a content mutation clears finalization")
  assert.equal((await readRecord(root, plan.artifactID)).finalized, false)
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "" })
  await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  assert.equal((await readRecord(root, plan.artifactID)).checks, "")
  const view = await store.getArtifact({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.doesNotMatch(view.content, /## Checks/)
})

test("plan rendering: flat headings, primaryAuthor frontmatter, evidence snapshot bullets, idempotent and byte-equal on disk", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store, { title: "Flat plan", workingDirectory: LOCATION_B })

  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Scope one." })
  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Change one.",
  })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Run the tests." })

  const evidence = await createEvidence(store, { description: "Evidence description label" })
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, summary: "S." })
  await store.evidenceFinalize({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  await store.planEvidenceAddMany({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, evidenceIDs: [evidence.artifactID] })

  const view = await store.getArtifact({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.equal(view.content, await readFile(view.path, "utf8"), "RPC content is byte-identical to disk")
  assert.match(
    view.content,
    /^---\nid: "art_[a-f0-9]{8}"\nkind: "plan"\nstatus: "draft"\ntitle: "Flat plan"\nprimaryAuthor: "Planner"\ndescription: "A structured plan artifact."\n---\n/,
    "frontmatter carries only frontend metadata including primaryAuthor",
  )
  assert.ok(view.content.includes("# Goal / Scope"), "flat Goal / Scope heading")
  assert.ok(view.content.includes("Scope one."))
  assert.ok(view.content.includes(`Working directory: ${LOCATION_B}`), "working directory retained")
  assert.ok(view.content.includes("## Intended Changes and Behaviors"), "Intended Changes heading")
  assert.ok(view.content.includes("Change one."))
  assert.ok(view.content.includes("### Evidence"), "nested Evidence heading")
  assert.ok(view.content.includes(`- Evidence description label (${evidence.artifactID})`), "evidence description snapshot renders beside the artifact ID")
  assert.ok(view.content.includes("## Checks"), "Checks heading")
  assert.ok(view.content.includes("Run the tests."))

  const record = await readRecord(root, plan.artifactID)
  const expected = await renderView(
    {
      id: record.id,
      kind: record.kind,
      status: record.status,
      title: record.title,
      primaryAuthor: record.primaryAuthor,
      description: record.description,
    },
    bodyOf(record),
  )
  assert.equal(expected, view.content, "rendering is idempotent")
})

test("evidence overview/findings: overview set, finding append/replace/remove by stable ID, publish and edit lifecycle", async (t) => {
  const { store, root } = await makeStore(t)
  const evidence = await createEvidence(store)

  await assert.rejects(
    store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "validation" && /at least one/.test(error.message),
  )
  // Finalize with no useful content is rejected.
  await assert.rejects(
    store.evidenceFinalize({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "validation" && /Summary, Limitations, or at least one finding/.test(error.message),
  )

  const overview = await store.evidenceOverviewPut({
    artifactID: evidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    question: "Which files?",
    summary: "Three files under the plugin directory.",
    limitations: "No runtime smoke test.",
  })
  assert.equal(overview.status, "draft")
  assert.equal(overview.finalized, false)
  let record = await readRecord(root, evidence.artifactID)
  assert.equal(record.question, "Which files?")
  assert.equal(record.summary, "Three files under the plugin directory.")
  assert.equal(record.limitations, "No runtime smoke test.")

  // A later overview call replaces only the provided fields; question clears via null.
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, summary: "Revised summary." })
  record = await readRecord(root, evidence.artifactID)
  assert.equal(record.summary, "Revised summary.")
  assert.equal(record.question, "Which files?", "omitted fields are untouched")
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, question: null })
  assert.equal((await readRecord(root, evidence.artifactID)).question, null, "question can be cleared")

  const first = await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    title: "Exact paths",
    content: "store.mjs and format.mjs.",
  })
  assert.match(first.findingID, /^fin_[a-f0-9]{8}$/)
  assert.equal(first.status, "draft")
  assert.equal(first.finalized, false)

  const replaced = await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    findingID: first.findingID,
    title: "Exact paths (revised)",
    content: "Three files, all under the plugin directory.",
  })
  assert.equal(replaced.findingID, first.findingID, "a supplied finding ID replaces in place")

  const second = await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    title: "Versions",
    content: "OpenCode v2.0.3.",
  })
  assert.notEqual(second.findingID, first.findingID)

  await assert.rejects(
    store.evidenceFindingPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, findingID: "fin_00000000", title: "x", content: "y" }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
  await assert.rejects(
    store.evidenceFindingPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: OTHER_WRITER, title: "x", content: "y" }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )

  const published = await store.evidenceFinalize({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  assert.equal(published.status, "published", "finalization transitions the visible draft to published")
  assert.equal(published.finalized, true)

  // Rendering: "# Evidence" with question, Summary, Limitations, Findings.
  const view = await store.getArtifact({ artifactID: evidence.artifactID, location: LOCATION_A })
  assert.equal(view.content, await readFile(view.path, "utf8"))
  assert.ok(view.content.includes("# Evidence"))
  assert.ok(view.content.includes("## Summary"))
  assert.ok(view.content.includes("Revised summary."))
  assert.ok(view.content.includes("## Limitations"))
  assert.ok(view.content.includes("No runtime smoke test."))
  assert.ok(view.content.includes("## Findings"))
  assert.ok(view.content.includes("### Exact paths (revised)"))
  assert.ok(view.content.includes("Three files, all under the plugin directory."))
  assert.doesNotMatch(view.content, /fin_[a-f0-9]{8}/, "finding IDs never enter rendered Markdown")

  // A content mutation clears readiness and returns the draft until re-finalized.
  const edited = await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    title: "Extra",
    content: "More detail.",
  })
  assert.equal(edited.status, "draft", "any edit returns evidence to the visible draft")
  assert.equal(edited.finalized, false)
  await store.evidenceFinalize({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })

  // Editing a read evidence returns it to draft for re-finalization.
  await store.markArtifactRead({ artifactID: evidence.artifactID, location: LOCATION_A, requestID: "req_read-evidence-0009" })
  assert.equal((await readRecord(root, evidence.artifactID)).status, "read")
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, summary: "Revised conclusion." })
  const afterEdit = await readRecord(root, evidence.artifactID)
  assert.equal(afterEdit.status, "draft", "editing a read evidence returns it to the unresolved draft")
  assert.equal(afterEdit.readAt, null)
  assert.equal(afterEdit.finalized, false)

  await store.evidenceFindingRemove({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, findingID: first.findingID })
  assert.equal((await readRecord(root, evidence.artifactID)).findings.length, 2)
  await assert.rejects(
    store.evidenceFindingRemove({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, findingID: "fin_00000000" }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("review outcome/summary/findings: singleton outcome and summary, repeatable findings, finalization requires both prose fields", async (t) => {
  const { store, root } = await makeStore(t)
  const review = await createReview(store)

  await assert.rejects(
    store.reviewFinalize({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "validation" && /outcome/.test(error.message),
  )

  const finding = await store.reviewFindingPut({
    artifactID: review.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    title: "Scope leak",
    severity: "high",
    affected: "store.mjs",
    evidence: "The remove path is reachable.",
    risk: "Unrelated edits could be removed.",
    correction: "Constrain removal to the named fields.",
  })
  assert.match(finding.findingID, /^fin_[a-f0-9]{8}$/)

  const replaced = await store.reviewFindingPut({
    artifactID: review.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    findingID: finding.findingID,
    title: "Scope leak (revised)",
    severity: "medium",
    affected: "store.mjs",
    correction: "Same correction.",
  })
  assert.equal(replaced.findingID, finding.findingID, "a supplied finding ID replaces in place")

  const second = await store.reviewFindingPut({
    artifactID: review.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    title: "Missing check",
    severity: "low",
    correction: "Add a regression test.",
  })
  assert.notEqual(second.findingID, finding.findingID)

  await assert.rejects(
    store.reviewFindingPut({
      artifactID: review.artifactID,
      location: LOCATION_A,
      writerSessionID: WRITER,
      findingID: "fin_00000000",
      title: "x",
      severity: "low",
      correction: "y",
    }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
  await assert.rejects(
    store.reviewFindingPut({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: OTHER_WRITER, title: "x", severity: "low", correction: "y" }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )

  // Outcome validation is an enum; the summary is whole-field prose.
  await assert.rejects(
    store.reviewOutcomePut({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, outcome: "Maybe" }),
    (error) => error instanceof StoreError && error.code === "validation" && /Pass, Changes required, or Blocked/.test(error.message),
  )
  const outcome = await store.reviewOutcomePut({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, outcome: "Changes required" })
  assert.equal(outcome.status, "draft")
  assert.equal((await readRecord(root, review.artifactID)).outcome, "Changes required")

  await assert.rejects(
    store.reviewFinalize({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "validation" && /Summary/.test(error.message),
  )
  await store.reviewSummaryPut({
    artifactID: review.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    content: "Pass with one medium finding; no blockers in the inspected scope.",
  })

  const published = await store.reviewFinalize({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  assert.equal(published.status, "published")
  assert.equal(published.finalized, true)

  // Rendering: "# Review", Outcome, Summary, named findings.
  const view = await store.getArtifact({ artifactID: review.artifactID, location: LOCATION_A })
  assert.equal(view.content, await readFile(view.path, "utf8"))
  assert.ok(view.content.includes("# Review"))
  assert.ok(view.content.includes("## Outcome"))
  assert.ok(view.content.includes("Changes required"))
  assert.ok(view.content.includes("## Summary"))
  assert.ok(view.content.includes("Pass with one medium finding"))
  assert.ok(view.content.includes("## Scope leak (revised)"))
  assert.ok(view.content.includes("- Severity: medium"))
  assert.ok(view.content.includes("- Correction: Same correction."))

  // A content mutation returns the review to draft.
  await store.reviewFindingRemove({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, findingID: second.findingID })
  const afterRemove = await readRecord(root, review.artifactID)
  assert.equal(afterRemove.status, "draft")
  assert.equal(afterRemove.finalized, false)
  assert.equal(afterRemove.findings.length, 1)
  await assert.rejects(
    store.reviewFindingRemove({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, findingID: "fin_00000000" }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("report lifecycle: content sections, finalize requires Summary, published mark-read, linkage preserved", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createApprovedPlan(store)
  const report = await store.createArtifact({
    kind: "report",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: "Builder",
    location: LOCATION_A,
    planArtifactID: plan.artifactID,
  })

  await assert.rejects(
    store.reportFinalize({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "validation" && /Summary/.test(error.message),
  )

  const put = await store.reportContentPut({
    artifactID: report.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    section: "changed",
    content: "store.mjs: replaced the plan item model.",
  })
  assert.equal(put.status, "draft")
  assert.equal(put.finalized, false)

  await store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "summary", content: "Implemented the approved plan." })
  await store.reportContentPut({
    artifactID: report.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    section: "checks",
    content: "store.test.mjs: all tests pass.",
  })
  await store.reportContentPut({
    artifactID: report.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    section: "unfinished",
    content: "Runtime cutover deferred to the user.",
  })
  let record = await readRecord(root, report.artifactID)
  assert.equal(record.changed, "store.mjs: replaced the plan item model.")
  assert.equal(record.unfinished, "Runtime cutover deferred to the user.")

  // Whole-section replace and clear.
  await store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "changed", content: "Revised changed text." })
  assert.equal((await readRecord(root, report.artifactID)).changed, "Revised changed text.")
  await store.reportContentRemove({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "unfinished" })
  record = await readRecord(root, report.artifactID)
  assert.equal(record.unfinished, "")
  await store.reportContentPut({
    artifactID: report.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    section: "unfinished",
    content: "Runtime cutover deferred to the user.",
  })
  record = await readRecord(root, report.artifactID)
  assert.equal(record.planArtifactID, plan.artifactID, "linkage to the approved plan is preserved")

  await assert.rejects(
    store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "goalScope", content: "x" }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
  await assert.rejects(
    store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: OTHER_WRITER, section: "summary", content: "x" }),
    (error) => error instanceof StoreError && error.code === "forbidden",
  )

  const published = await store.reportFinalize({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  assert.equal(published.status, "published")
  assert.equal(published.finalized, true)

  // Rendering: "# Report" with Summary/Changed/Checks/Unfinished.
  const view = await store.getArtifact({ artifactID: report.artifactID, location: LOCATION_A })
  assert.equal(view.content, await readFile(view.path, "utf8"))
  assert.ok(view.content.includes("# Report"))
  assert.ok(view.content.includes(`Plan: ${plan.artifactID}`), "report body names its linked plan")
  assert.ok(view.content.includes("## Summary"))
  assert.ok(view.content.includes("Implemented the approved plan."))
  assert.ok(view.content.includes("## Changed"))
  assert.ok(view.content.includes("Revised changed text."))
  assert.ok(view.content.includes("## Checks"))
  assert.ok(view.content.includes("## Unfinished"))

  // Mark-read works for reports (non-plan dismissal) and edits return to draft.
  await store.markArtifactRead({ artifactID: report.artifactID, location: LOCATION_A, requestID: "req_read-report-0001" })
  assert.equal((await readRecord(root, report.artifactID)).status, "read")
  await store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "checks", content: "Revised checks." })
  record = await readRecord(root, report.artifactID)
  assert.equal(record.status, "draft", "editing a read report returns it to the draft")
  assert.equal(record.finalized, false)
})

test("approval gates on readiness and freezes the complete flat plan record", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)
  const evidence = await createEvidence(store)

  // A non-finalized draft is not approvable.
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Goal." })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Check." })
  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Change.",
  })
  await assert.rejects(
    store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_approve-0001" }),
    (error) => error instanceof StoreError && error.code === "not_ready",
  )

  await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  const approved = await store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_approve-0001" })
  assert.equal(approved.deduplicated, false)
  assert.equal(approved.artifact.status, "approved")
  assert.match(
    await readFile(approved.artifact.path, "utf8"),
    /^---\nid: "art_[a-f0-9]{8}"\nkind: "plan"\nstatus: "approved"\n/,
  )

  // Approval freezes every mutation path across the flat record.
  await assert.rejects(
    store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Late edit." }),
    (error) => error instanceof StoreError && error.code === "approved",
  )
  await assert.rejects(
    store.planFieldPatch({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "context", oldText: "", newText: "Late." }),
    (error) => error instanceof StoreError && error.code === "approved",
  )
  await assert.rejects(
    store.planEvidenceAddMany({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, evidenceIDs: [evidence.artifactID] }),
    (error) => error instanceof StoreError && error.code === "approved",
  )
  await assert.rejects(
    store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER }),
    (error) => error instanceof StoreError && error.code === "approved",
  )

  // The freeze covers the flat fields: the record is unchanged.
  const record = await readRecord(root, plan.artifactID)
  assert.equal(record.status, "approved")
  assert.equal(record.goalScope, "Goal.")

  // Approval is plan-only and deduplicates.
  await assert.rejects(
    store.approveArtifact({ artifactID: evidence.artifactID, location: LOCATION_A, requestID: "req_approve-evidence-0001" }),
    (error) => error instanceof StoreError && error.code === "invalid_kind",
  )
  const again = await store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_approve-0002" })
  assert.equal(again.deduplicated, true)
  assert.equal(again.requestID, "req_approve-0001")
})

test("mark-read applies to evidence/review/report; plans reject it, approval rejects non-plans", async (t) => {
  const { store, root } = await makeStore(t)
  const evidence = await createEvidence(store)
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, summary: "Summary." })
  await store.evidenceFinalize({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })

  const review = await createReview(store)
  await store.reviewOutcomePut({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, outcome: "Pass" })
  await store.reviewSummaryPut({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, content: "Clean." })
  await store.reviewFinalize({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER })

  const plan = await createApprovedPlan(store)
  const report = await store.createArtifact({
    kind: "report",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: "Builder",
    location: LOCATION_A,
    planArtifactID: plan.artifactID,
  })
  await store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "summary", content: "Done." })
  await store.reportFinalize({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER })

  for (const [kind, artifactID] of [
    ["evidence", evidence.artifactID],
    ["review", review.artifactID],
    ["report", report.artifactID],
  ]) {
    const read = await store.markArtifactRead({ artifactID, location: LOCATION_A, requestID: `req_read-${kind}-0001` })
    assert.equal(read.deduplicated, false)
    assert.equal(read.artifact.status, "read")
    assert.equal(read.delivery, undefined, "mark-read records no delivery")
    const record = await readRecord(root, artifactID)
    assert.equal(record.status, "read")
    assert.equal(record.readAt.requestID, `req_read-${kind}-0001`)
    assert.equal(record.approval, null, "mark-read never records an approval")

    await assert.rejects(
      store.approveArtifact({ artifactID, location: LOCATION_A, requestID: `req_approve-${kind}-0001` }),
      (error) => error instanceof StoreError && error.code === "invalid_kind",
    )

    const again = await store.markArtifactRead({ artifactID, location: LOCATION_A, requestID: `req_read-${kind}-0002` })
    assert.equal(again.deduplicated, true)
    assert.equal(again.requestID, `req_read-${kind}-0001`)
  }

  await assert.rejects(
    store.markArtifactRead({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_read-plan-0001" }),
    (error) => error instanceof StoreError && error.code === "invalid_kind",
  )
})

test("unsupported record shapes are rejected", async (t) => {
  const { store, root } = await makeStore(t)
  await mkdir(join(root, "artifacts"), { recursive: true })
  const unsupportedShapes = [
    {
      id: "art_00000001",
      kind: "plan",
      ownerSessionID: OWNER,
      writerSessionID: WRITER,
      primaryAuthor: "Planner",
      location: LOCATION_A,
      title: "Unsupported plan",
      description: "Unsupported",
      status: "draft",
      finalized: false,
      sections: [{ name: "Changes", items: [{ id: "itm_00000001", content: "x" }] }],
      feedback: [],
      approval: null,
      readAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "art_00000002",
      kind: "evidence",
      ownerSessionID: OWNER,
      writerSessionID: WRITER,
      primaryAuthor: "Search",
      location: LOCATION_A,
      title: "Unsupported evidence",
      description: "Unsupported",
      status: "draft",
      finalized: false,
      topics: [{ id: "top_00000001", heading: "H", answer: "A" }],
      feedback: [],
      approval: null,
      readAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "art_00000003",
      kind: "review",
      ownerSessionID: OWNER,
      writerSessionID: WRITER,
      primaryAuthor: "Review",
      location: LOCATION_A,
      title: "Unsupported review",
      description: "Unsupported",
      status: "draft",
      finalized: false,
      verdict: { content: "Pass." },
      findings: [],
      feedback: [],
      approval: null,
      readAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "art_00000004",
      kind: "plan",
      ownerSessionID: OWNER,
      writerSessionID: WRITER,
      primaryAuthor: "Planner",
      location: LOCATION_A,
      title: "Unsupported body plan",
      description: "Unsupported",
      status: "draft",
      finalized: false,
      body: "## Changes\n- item\n",
      feedback: [],
      approval: null,
      readAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]
  for (const record of unsupportedShapes) {
    await mkdir(join(root, "artifacts", record.id), { recursive: true })
    await writeFile(join(root, "artifacts", record.id, "record.json"), JSON.stringify(record), "utf8")
    await assert.rejects(
      store.getArtifact({ artifactID: record.id, location: LOCATION_A }),
      (error) => error instanceof StoreError && error.code === "io" && /legacy|sections|topics|verdict/i.test(error.message),
      `expected rejection for ${record.id}`,
    )
  }
  await assert.rejects(
    store.listArtifacts({ location: LOCATION_A }),
    (error) => error instanceof StoreError && error.code === "io",
  )
})

test("summary readers expose only overview fields — never detailed findings — while full loaders stay kind-locked", async (t) => {
  const { store, root } = await makeStore(t)
  const evidence = await createEvidence(store)
  await store.evidenceOverviewPut({
    artifactID: evidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    question: "Which files?",
    summary: "Key summary.",
    limitations: "Limits.",
  })
  const finding = await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    title: "Detail",
    content: "Secret detail.",
  })
  await store.evidenceFinalize({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })

  const evidenceSummary = await store.getEvidenceSummary({ artifactID: evidence.artifactID, location: LOCATION_A })
  assert.equal(evidenceSummary.question, "Which files?")
  assert.equal(evidenceSummary.summary, "Key summary.")
  assert.equal(evidenceSummary.limitations, "Limits.")
  assert.equal(evidenceSummary.findings, undefined, "summary readers never include findings")
  assert.equal(evidenceSummary.content, undefined, "summary readers never render the body")

  const full = await store.getEvidence({ artifactID: evidence.artifactID, location: LOCATION_A })
  assert.equal(full.kind, "evidence")
  assert.ok(full.content.includes("Secret detail."), "full loaders expose findings detail")

  const review = await createReview(store)
  await store.reviewOutcomePut({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, outcome: "Blocked" })
  await store.reviewSummaryPut({ artifactID: review.artifactID, location: LOCATION_A, writerSessionID: WRITER, content: "Missing source." })
  await store.reviewFindingPut({
    artifactID: review.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    title: "Blocker",
    severity: "high",
    correction: "Fetch the fact.",
  })
  const reviewSummary = await store.getReviewSummary({ artifactID: review.artifactID, location: LOCATION_A })
  assert.equal(reviewSummary.outcome, "Blocked")
  assert.equal(reviewSummary.summary, "Missing source.")
  assert.equal(reviewSummary.findings, undefined, "review summary readers never include findings")
  const reviewFull = await store.getReview({ artifactID: review.artifactID, location: LOCATION_A })
  assert.ok(reviewFull.content.includes("Blocker"))

  const plan = await createApprovedPlan(store)
  const report = await store.createArtifact({
    kind: "report",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: "Builder",
    location: LOCATION_A,
    planArtifactID: plan.artifactID,
  })
  await store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "summary", content: "Implementation summary." })
  await store.reportContentPut({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER, section: "checks", content: "Checks detail." })
  await store.reportFinalize({ artifactID: report.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  const reportSummary = await store.getReportSummary({ artifactID: report.artifactID, location: LOCATION_A })
  assert.equal(reportSummary.planArtifactID, plan.artifactID)
  assert.equal(reportSummary.summary, "Implementation summary.")
  assert.equal(reportSummary.changed, undefined, "report summary readers hide Changed/Checks/Unfinished")
  const reportFull = await store.getReport({ artifactID: report.artifactID, location: LOCATION_A })
  assert.ok(reportFull.content.includes("Checks detail."))
  assert.equal(reportFull.status, "published", "report loading never marks read")

  // Summary readers and full loaders are kind-locked.
  for (const getter of ["getEvidenceSummary", "getReviewSummary", "getReportSummary", "getEvidence", "getReview", "getReport"]) {
    await assert.rejects(
      store[getter]({ artifactID: plan.artifactID, location: LOCATION_A }),
      (error) => error instanceof StoreError && error.code === "invalid_kind",
      `${getter} must reject a plan ID`,
    )
  }
  // The finalized evidence summary still reads without mutation.
  const againSummary = await store.getEvidenceSummary({ artifactID: evidence.artifactID, location: LOCATION_A })
  assert.equal(againSummary.status, "published")
  assert.equal((await readRecord(root, evidence.artifactID)).status, "published", "summary reads never mutate")
})

test("getArtifactMetadata returns the summary with readiness and without content; approved-plan loading stays atomic", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store, { title: "Status plan" })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Goal." })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Check." })
  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Change.",
  })

  const metadata = await store.getArtifactMetadata({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.equal(metadata.id, plan.artifactID)
  assert.equal(metadata.kind, "plan")
  assert.equal(metadata.status, "draft")
  assert.equal(metadata.finalized, false)
  assert.equal(metadata.primaryAuthor, AUTHOR)
  assert.equal(metadata.writerSessionID, WRITER, "internal summaries still carry the writer for delivery bookkeeping")
  assert.equal(metadata.content, undefined, "metadata lookup never renders content")
  assert.equal(metadata.feedback, undefined)

  // Draft plans are rejected by the approved-plan loader (not_approved);
  // finalized but unapproved plans too (approval is the gate).
  await assert.rejects(
    store.getApprovedPlan({ artifactID: plan.artifactID, location: LOCATION_A }),
    (error) => error instanceof StoreError && error.code === "not_approved",
  )
  await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  await assert.rejects(
    store.getApprovedPlan({ artifactID: plan.artifactID, location: LOCATION_A }),
    (error) => error instanceof StoreError && error.code === "not_approved",
  )

  await store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_approved-plan-0001" })
  const loaded = await store.getApprovedPlan({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.equal(loaded.kind, "plan")
  assert.equal(loaded.status, "approved")
  assert.equal(loaded.finalized, true)
  assert.equal(typeof loaded.content, "string")
  assert.ok(loaded.content.includes("## Intended Changes and Behaviors"))
  const structure = await store.getArtifactStructure({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.deepEqual(structure.evidence, [], "flat plan structure exposes only the evidence list")

  const evidence = await createEvidence(store)
  await assert.rejects(
    store.getApprovedPlan({ artifactID: evidence.artifactID, location: LOCATION_A }),
    (error) => error instanceof StoreError && error.code === "invalid_kind",
  )
  await assert.rejects(
    store.getApprovedPlan({ artifactID: plan.artifactID, location: LOCATION_B }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
  assert.equal((await readRecord(root, plan.artifactID)).status, "approved", "loading does not change the record")
})

test("evidence load returns content only for evidence and is state-neutral", async (t) => {
  const { store, root } = await makeStore(t)
  const evidence = await createEvidence(store)
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, summary: "# Summary content\n" })
  await store.evidenceFinalize({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER })

  const loaded = await store.getEvidence({ artifactID: evidence.artifactID, location: LOCATION_A })
  assert.equal(loaded.kind, "evidence")
  assert.equal(loaded.status, "published")
  assert.ok(loaded.content.includes("# Summary content"))

  await store.markArtifactRead({ artifactID: evidence.artifactID, location: LOCATION_A, requestID: "req_evidence-read-0001" })
  const readLoaded = await store.getEvidence({ artifactID: evidence.artifactID, location: LOCATION_A })
  assert.equal(readLoaded.status, "read")
  const recordAfter = await readRecord(root, evidence.artifactID)
  assert.equal(recordAfter.status, "read", "evidence loading never mutates the record")
  assert.equal(recordAfter.readAt.requestID, "req_evidence-read-0001")

  const plan = await createPlan(store)
  const review = await createReview(store)
  for (const artifactID of [plan.artifactID, review.artifactID]) {
    await assert.rejects(
      store.getEvidence({ artifactID, location: LOCATION_A }),
      (error) => error instanceof StoreError && error.code === "invalid_kind",
      `expected invalid_kind for ${artifactID}`,
    )
  }
  await assert.rejects(
    store.getEvidence({ artifactID: plan.artifactID, location: LOCATION_B }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("get repairs a current.md that diverged from the authoritative record", async (t) => {
  const { store, root } = await makeStore(t)
  const evidence = await createEvidence(store)
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: LOCATION_A, writerSessionID: WRITER, summary: "# One\n" })
  const currentPath = join(root, "artifacts", evidence.artifactID, "current.md")

  await writeFile(currentPath, '---\nid: "art_00000000"\nkind: "evidence"\nstatus: "approved"\ntitle: "Diverged"\n---\n\n# Two\n')
  const record = await readRecord(root, evidence.artifactID)
  const expected = await renderView(
    {
      id: record.id,
      kind: record.kind,
      status: record.status,
      title: record.title,
      primaryAuthor: record.primaryAuthor,
      description: record.description,
    },
    bodyOf(record),
  )

  const view = await store.getArtifact({ artifactID: evidence.artifactID, location: LOCATION_A })
  assert.equal(view.content, expected, "the served view is record-derived")
  assert.equal(view.status, "draft")
  assert.equal(await readFile(currentPath, "utf8"), expected, "the divergent file is repaired on read")
})

test("list on an empty or deleted registry returns an empty array, not ENOENT", async (t) => {
  const { store, root } = await makeStore(t)
  const empty = await store.listArtifacts({ location: LOCATION_A })
  assert.deepEqual(empty, [], "a fresh registry has no artifacts")

  await rm(join(root, "artifacts"), { recursive: true, force: true })
  const after = await store.listArtifacts({ location: LOCATION_A })
  assert.deepEqual(after, [], "list recreates the artifacts directory and returns empty")
})

test("list and get expose the latest state only", async (t) => {
  const { store } = await makeStore(t)
  const plan = await createPlan(store)
  const summaries = await store.listArtifacts({ location: LOCATION_A })
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].id, plan.artifactID)
  assert.equal(summaries[0].revision, undefined)
  assert.equal(summaries[0].authorSessionID, undefined)
  assert.equal(summaries[0].finalized, false)
  assert.equal(summaries[0].writerSessionID, WRITER)
  assert.equal(summaries[0].primaryAuthor, AUTHOR)

  const view = await store.getArtifact({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.equal(view.path, plan.path)
  assert.equal(view.content, await readFile(plan.path, "utf8"))
  assert.deepEqual(view.feedback, [])
  assert.equal(view.approval, null)

  await assert.rejects(
    store.getArtifact({ artifactID: plan.artifactID, location: LOCATION_B }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("createArtifact validation: kind enum, ownership, primaryAuthor, limits and control characters", async (t) => {
  const { store, root } = await makeStore(t)
  const base = {
    kind: "plan",
    ownerSessionID: OWNER,
    writerSessionID: WRITER,
    primaryAuthor: AUTHOR,
    location: LOCATION_A,
    title: "t",
    description: "d",
    workingDirectory: LOCATION_A,
  }
  await assert.rejects(store.createArtifact({ ...base, kind: "memo" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.createArtifact({ ...base, ownerSessionID: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.createArtifact({ ...base, writerSessionID: "" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.createArtifact({ ...base, primaryAuthor: "  " }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.createArtifact({ ...base, title: "   " }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.createArtifact({ ...base, description: "   " }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.createArtifact({ ...base, kind: "plan", workingDirectory: "relative" }), (error) => error instanceof StoreError && error.code === "validation")
  await assert.rejects(store.createArtifact({ ...base, kind: "plan", title: "bad\u0000title" }), (error) => error instanceof StoreError && error.code === "validation")
  // workingDirectory is a plan-only field; providing it to another kind is
  // accepted but never stored.
  const evidence = await store.createArtifact({ ...base, kind: "evidence" })
  assert.equal(evidence.kind, "evidence")
  const evidenceRecord = await readRecord(root, evidence.artifactID)
  assert.equal(evidenceRecord.workingDirectory, undefined)
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

test("feedback records the recipient and deduplicates by request ID; byte limits are enforced", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)
  const requestID = "req_test-feedback-0001"

  const first = await store.addArtifactFeedback({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    requestID,
    question: "Is the plan ready?",
    recipient: "owner",
  })
  assert.equal(first.deduplicated, false)
  assert.equal(first.delivery.state, "pending")
  assert.equal(first.feedback.recipient, "owner")

  const duplicate = await store.addArtifactFeedback({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    requestID,
    question: "A different question must not overwrite the recorded one.",
    recipient: "writer",
  })
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.feedback.question, "Is the plan ready?")
  assert.equal(duplicate.feedback.recipient, "owner", "the recorded recipient wins on dedup")

  const writerFeedback = await store.addArtifactFeedback({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    requestID: "req_test-feedback-0002",
    question: "Direct to the writer session.",
    recipient: "writer",
  })
  assert.equal(writerFeedback.feedback.recipient, "writer")
  assert.equal((await readRecord(root, plan.artifactID)).feedback[1].recipient, "writer")

  const oversizedQuestion = "é".repeat(8193)
  await assert.rejects(
    store.addArtifactFeedback({
      artifactID: plan.artifactID,
      location: LOCATION_A,
      requestID: "req_limit-q-1",
      question: oversizedQuestion,
    }),
    (error) => error instanceof StoreError && error.code === "validation" && error.data.limit === 16 * 1024,
  )
  await assert.rejects(
    store.addArtifactFeedback({
      artifactID: plan.artifactID,
      location: LOCATION_A,
      requestID: "req_limit-s-1",
      question: "still fine",
      selectedText: "x".repeat(64 * 1024 + 1),
    }),
    (error) => error instanceof StoreError && error.code === "validation" && error.data.limit === 64 * 1024,
  )
  assert.equal((await readRecord(root, plan.artifactID)).feedback.length, 2)
})

test("delivery bookkeeping preserves the decision and is location-scoped", async (t) => {
  const { store } = await makeStore(t)
  const plan = await createPlan(store)
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Goal." })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Check." })
  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Change.",
  })
  await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  await store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_approval-del-1" })

  const failed = await store.markArtifactDelivery({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    requestID: "req_approval-del-1",
    kind: "approval",
    state: "failed",
    error: "owner session unavailable",
  })
  assert.equal(failed.delivery.state, "failed")
  assert.equal(failed.delivery.error, "owner session unavailable")

  const view = await store.getArtifact({ artifactID: plan.artifactID, location: LOCATION_A })
  assert.equal(view.status, "approved")
  assert.equal(view.approval.requestID, "req_approval-del-1")

  const delivered = await store.markArtifactDelivery({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    requestID: "req_approval-del-1",
    kind: "approval",
    state: "delivered",
  })
  assert.equal(delivered.delivery.state, "delivered")
  assert.ok(delivered.delivery.deliveredAt)

  await assert.rejects(
    store.markArtifactDelivery({ artifactID: plan.artifactID, location: LOCATION_B, requestID: "req_approval-del-1", kind: "approval", state: "delivered" }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
})

test("delivery bookkeeping is unambiguous by submission type even on requestID reuse", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)
  const sharedID = "req_shared-delivery-0001"

  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Goal." })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Check." })
  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Change.",
  })
  await store.addArtifactFeedback({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    requestID: sharedID,
    question: "Shared question?",
  })
  await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  await store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: sharedID })

  await store.markArtifactDelivery({ artifactID: plan.artifactID, location: LOCATION_A, requestID: sharedID, kind: "approval", state: "delivered" })
  let record = await readRecord(root, plan.artifactID)
  assert.equal(record.approval.delivery.state, "delivered")
  assert.equal(record.feedback[0].delivery.state, "pending", "feedback delivery is untouched when the approval is marked")

  await store.markArtifactDelivery({ artifactID: plan.artifactID, location: LOCATION_A, requestID: sharedID, kind: "feedback", state: "failed", error: "nope" })
  record = await readRecord(root, plan.artifactID)
  assert.equal(record.feedback[0].delivery.state, "failed")
  assert.equal(record.approval.delivery.state, "delivered", "approval delivery is untouched when feedback is marked")

  await store.addArtifactFeedback({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    requestID: "req_only-feedback-0001",
    question: "Only feedback.",
  })
  await assert.rejects(
    store.markArtifactDelivery({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_only-feedback-0001", kind: "approval", state: "delivered" }),
    (error) => error instanceof StoreError && error.code === "not_found" && /approval/.test(error.message),
  )
  await assert.rejects(
    store.markArtifactDelivery({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_unknown-delivery-0001", kind: "approval", state: "delivered" }),
    (error) => error instanceof StoreError && error.code === "not_found",
  )
  await assert.rejects(
    store.markArtifactDelivery({ artifactID: plan.artifactID, location: LOCATION_A, requestID: sharedID, kind: "read", state: "delivered" }),
    (error) => error instanceof StoreError && error.code === "validation",
  )
})

test("an existing artifact lock is reported, not bypassed; release restores mutations", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)
  const lockPath = join(root, "artifacts", plan.artifactID, "lock")
  await writeFile(lockPath, "held\n", { mode: 0o600 })

  await assert.rejects(
    store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Blocked." }),
    (error) => error instanceof StoreError && error.code === "lock_conflict",
  )

  // Stale-lock recovery: removing the file by hand recovers without discarding
  // the record.
  await rm(lockPath, { force: true })
  const put = await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Allowed." })
  assert.equal(put.status, "draft")
  const record = await readRecord(root, plan.artifactID)
  assert.equal(record.goalScope, "Allowed.")
})

test("resumable create/set/finalize chains preserve partial work across interruptions", async (t) => {
  const { store, root } = await makeStore(t)
  const plan = await createPlan(store)
  // Simulate an interrupted chain: flat fields are written, approval is attempted
  // before finalization (not_ready), then the same artifact is finalized and
  // approved without re-creating anything.
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "goalScope", content: "Partial goal." })
  await store.planFieldSet({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER, field: "checks", content: "Partial check." })
  await assert.rejects(
    store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_resume-approve-0001" }),
    (error) => error instanceof StoreError && error.code === "not_ready",
  )
  const recordBefore = await readRecord(root, plan.artifactID)
  assert.equal(recordBefore.goalScope, "Partial goal.", "partial writes persist")

  await store.planFieldPatch({
    artifactID: plan.artifactID,
    location: LOCATION_A,
    writerSessionID: WRITER,
    field: "intendedChanges",
    oldText: "",
    newText: "Resumed changes.",
  })
  await store.planFinalize({ artifactID: plan.artifactID, location: LOCATION_A, writerSessionID: WRITER })
  const approved = await store.approveArtifact({ artifactID: plan.artifactID, location: LOCATION_A, requestID: "req_resume-approve-0001" })
  assert.equal(approved.artifact.status, "approved")
  const finalRecord = await readRecord(root, plan.artifactID)
  assert.equal(finalRecord.intendedChanges, "Resumed changes.", "no work was lost or duplicated")
})
