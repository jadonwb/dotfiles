// Tests for the shared artifact tools, the artifact RPC contract, and the
// plugin registration wiring (mocked admission: no real prompt/synthetic
// message is ever submitted; ctx.session is a mock).
// Run from the chezmoi working directory:
//   node --test dot_config/opencode/plugins/plan-bridge/artifact-tools.test.mjs

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createStore, StoreError } from "./store.mjs"
import {
  MAX_ANCESTRY_HOPS,
  artifactApprovalMessage,
  artifactDeliveryDescription,
  artifactDeliveryMetadata,
  artifactFeedbackMessage,
  addArtifactTools,
  fetchValidatedSession,
  resolveProvenance,
  unwrapSession,
} from "./artifact-tools.ts"
import plugin from "./index.ts"

const DIRECTORY = "/tmp/opencode/artifact-tools-location"
const PLANNER_SESSION = "ses_planner00000000000000000"
const SEARCH_SESSION = "ses_search00000000000000000"
const BUILDER_SESSION = "ses_builder00000000000000000"
const RUNNER_SESSION = "ses_runner000000000000000000"
const REVIEW_SESSION = "ses_review00000000000000000"

function sessionInfo(overrides = {}) {
  return { id: PLANNER_SESSION, agent: "planner", location: { directory: DIRECTORY }, ...overrides }
}

async function makeTempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "opencode", "artifact-tools-state-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  process.env.XDG_STATE_HOME = root
  return root
}

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), "opencode", "artifact-tools-store-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { store: createStore({ root }), root }
}

// ---------------------------------------------------------------------------
// Session normalization
// ---------------------------------------------------------------------------

test("session results are accepted raw or wrapped, and validated", async () => {
  const raw = sessionInfo()
  assert.equal(unwrapSession(raw).id, PLANNER_SESSION)
  assert.equal(unwrapSession({ data: raw }).id, PLANNER_SESSION)
  assert.equal(unwrapSession(null), null)
  assert.equal(unwrapSession({ data: null }), null)
  assert.equal(unwrapSession({ error: "nope" }), null)

  const deps = { getSession: async () => raw, directory: DIRECTORY }
  const resolved = await fetchValidatedSession(deps, PLANNER_SESSION)
  assert.deepEqual(resolved, { sessionID: PLANNER_SESSION, agent: "planner", parentID: null })

  const wrapped = { getSession: async () => ({ data: raw }), directory: DIRECTORY }
  assert.equal((await fetchValidatedSession(wrapped, PLANNER_SESSION)).sessionID, PLANNER_SESSION)

  // The returned record must carry the requested ID.
  const mismatched = { getSession: async () => sessionInfo({ id: "ses_other00000000000000000" }), directory: DIRECTORY }
  await assert.rejects(fetchValidatedSession(mismatched, PLANNER_SESSION), /no verifiable session/)

  // A different location is a visible failure (same-location increment only).
  const moved = { getSession: async () => sessionInfo({ location: { directory: "/somewhere/else" } }), directory: DIRECTORY }
  await assert.rejects(fetchValidatedSession(moved, PLANNER_SESSION), /not active in this location/)

  // Missing location object and missing directory are failures too.
  await assert.rejects(
    fetchValidatedSession({ getSession: async () => sessionInfo({ location: undefined }), directory: DIRECTORY }, PLANNER_SESSION),
    /not active in this location/,
  )

  // Lookup failures surface as owner_unresolved.
  await assert.rejects(
    fetchValidatedSession({ getSession: async () => { throw new Error("boom") }, directory: DIRECTORY }, PLANNER_SESSION),
    /owner_unresolved: session lookup failed/,
  )
})

test("provenance walks server-assigned ancestry to the nearest Planner", async () => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [PLANNER_SESSION]: sessionInfo(),
  }
  const deps = { getSession: async ({ sessionID }) => sessions[sessionID], directory: DIRECTORY }
  const resolved = await resolveProvenance(deps, { sessionID: SEARCH_SESSION, agent: "search", messageID: "m", id: "t" })
  assert.deepEqual(resolved, { ownerSessionID: PLANNER_SESSION, authorSessionID: SEARCH_SESSION, ownerAgent: "planner" })

  // A Planner caller owns its own publication without walking.
  const self = await resolveProvenance(deps, { sessionID: PLANNER_SESSION, agent: "planner", messageID: "m", id: "t" })
  assert.equal(self.ownerSessionID, PLANNER_SESSION)

  // Two-hop chains (Planner -> Builder -> Search) resolve to the root Planner.
  const deep = {
    ...sessions,
    [BUILDER_SESSION]: sessionInfo({ id: BUILDER_SESSION, agent: "builder", parentID: SEARCH_SESSION }),
  }
  const deepDeps = { getSession: async ({ sessionID }) => deep[sessionID], directory: DIRECTORY }
  const deepResolved = await resolveProvenance(deepDeps, { sessionID: BUILDER_SESSION, agent: "builder", messageID: "m", id: "t" })
  assert.equal(deepResolved.ownerSessionID, PLANNER_SESSION)
  assert.equal(deepResolved.authorSessionID, BUILDER_SESSION)
})

test("provenance falls back to the author when no Planner ancestor is reachable", async () => {
  // A cycle cannot reach a Planner: the author owns its own artifact.
  const cycleSessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: BUILDER_SESSION }),
    [BUILDER_SESSION]: sessionInfo({ id: BUILDER_SESSION, agent: "builder", parentID: SEARCH_SESSION }),
  }
  const cycle = await resolveProvenance(
    { getSession: async ({ sessionID }) => cycleSessions[sessionID], directory: DIRECTORY },
    { sessionID: SEARCH_SESSION, agent: "search", messageID: "m", id: "t" },
  )
  assert.deepEqual(cycle, { ownerSessionID: SEARCH_SESSION, authorSessionID: SEARCH_SESSION, ownerAgent: "search" })

  // A chain ending in an agentless parent resolves to the author.
  const agentless = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [PLANNER_SESSION]: sessionInfo({ agent: undefined }),
  }
  const agentlessResolved = await resolveProvenance(
    { getSession: async ({ sessionID }) => agentless[sessionID], directory: DIRECTORY },
    { sessionID: SEARCH_SESSION, agent: "search", messageID: "m", id: "t" },
  )
  assert.equal(agentlessResolved.ownerSessionID, SEARCH_SESSION)

  // A chain ending without a parent resolves to the author.
  const orphan = { [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search" }) }
  const orphanResolved = await resolveProvenance(
    { getSession: async ({ sessionID }) => orphan[sessionID], directory: DIRECTORY },
    { sessionID: SEARCH_SESSION, agent: "search", messageID: "m", id: "t" },
  )
  assert.equal(orphanResolved.ownerSessionID, SEARCH_SESSION)

  // An over-deep chain stops at the hop bound and falls back to the author.
  const chain = {}
  let cursor = "ses_hop000000000000000000"
  for (let index = 0; index <= MAX_ANCESTRY_HOPS + 1; index += 1) {
    chain[cursor] = sessionInfo({ id: cursor, agent: "search", parentID: `ses_hop${String(index + 1).padStart(20, "0")}` })
    cursor = `ses_hop${String(index + 1).padStart(20, "0")}`
  }
  const deep = await resolveProvenance(
    { getSession: async ({ sessionID }) => chain[sessionID], directory: DIRECTORY },
    { sessionID: "ses_hop000000000000000000", agent: "search", messageID: "m", id: "t" },
  )
  assert.equal(deep.ownerSessionID, "ses_hop000000000000000000")

  // The author session itself must still validate against the location: a
  // lookup failure is a visible owner_unresolved error.
  await assert.rejects(
    resolveProvenance({ getSession: async () => { throw new Error("boom") }, directory: DIRECTORY }, { sessionID: SEARCH_SESSION, agent: "search", messageID: "m", id: "t" }),
    /owner_unresolved/,
  )
})

// ---------------------------------------------------------------------------
// Compact synthetic message builders
// ---------------------------------------------------------------------------

test("feedback message: full ID@revision, user question, exactly one context representation", () => {
  const base = { kind: "plan", title: "Shared plan", artifactID: "art_x", revision: "aaaaaaaa" }
  const both = artifactFeedbackMessage({ ...base, question: "Is this right?", selectedText: "selected line", selectedRange: { start: 3, end: 4 } })
  assert.match(both, /Feedback on plan "Shared plan"/)
  assert.match(both, /Artifact: art_x@aaaaaaaa/)
  assert.match(both, /User question: Is this right\?/)
  assert.match(both, /> --- begin user selection ---\n> selected line\n> --- end user selection ---/)
  assert.ok(!both.includes("lines 3-4"), "selected excerpt replaces the range representation")

  const rangeOnly = artifactFeedbackMessage({ ...base, selectedRange: { start: 3, end: 9 } })
  assert.match(rangeOnly, /Context: the user selected lines 3-9; no excerpt is quoted\./)
  assert.ok(!rangeOnly.includes("begin user selection"))

  const general = artifactFeedbackMessage({ ...base, question: "General thoughts?" })
  assert.match(general, /User question: General thoughts\?/)
  assert.ok(!general.includes("user selection"), "general feedback carries no context block")
  assert.equal(general.split("\n").length, 4)
})

test("implementation approval names the revision and the single Builder launch; historical approval is a freeze", () => {
  const implementation = artifactApprovalMessage({ authority: "implementation", artifactID: "art_x", revision: "bbbbbbbb" })
  const implementationLines = implementation.split("\n")
  assert.ok(implementationLines.length <= 2, `at most two lines, got ${implementationLines.length}`)
  assert.match(implementation, /Approved plan art_x@bbbbbbbb/)
  assert.match(implementation, /authority: implementation/)
  assert.match(implementation, /ONE background Builder for that exact revision/)

  const historical = artifactApprovalMessage({ authority: "historical", artifactID: "art_y", revision: "cccccccc" })
  const historicalLines = historical.split("\n")
  assert.ok(historicalLines.length <= 2, `at most two lines, got ${historicalLines.length}`)
  assert.match(historical, /Approved plan art_y@cccccccc/)
  assert.match(historical, /authority: historical/)
  assert.match(historical, /does not authorize Builder/)
})

test("delivery description is a short title-bearing label; metadata carries request IDs and authority", () => {
  assert.equal(artifactDeliveryDescription({ action: "feedback", title: "My plan" }), "Artifact feedback: My plan")
  assert.equal(artifactDeliveryDescription({ action: "approval", title: "My plan" }), "Artifact approval: My plan")
  const long = artifactDeliveryDescription({ action: "feedback", title: "x".repeat(300) })
  assert.ok(long.length <= "Artifact feedback: ".length + 80, "label is capped")
  const metadata = artifactDeliveryMetadata({ artifactID: "art_x", revision: "c0c0c0c0", requestID: "req_1", kind: "plan", authority: "implementation", submission: "feedback" })
  assert.deepEqual(metadata, {
    artifactID: "art_x",
    revision: "c0c0c0c0",
    requestID: "req_1",
    kind: "plan",
    authority: "implementation",
    submission: "feedback",
    source: "personal.artifacts",
  })
})

// ---------------------------------------------------------------------------
// Tool flows against a real store (temp root), with mocked sessions
// ---------------------------------------------------------------------------

function toolContext(sessionID, agent) {
  return { sessionID, agent, messageID: "msg_test", id: "tool_test" }
}

test("artifact publish/patch/get flow: provenance resolved, results identify owner/author/revision/snapshot/authority", async (t) => {
  const { store, root } = await makeStore(t)
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [REVIEW_SESSION]: sessionInfo({ id: REVIEW_SESSION, agent: "review", parentID: PLANNER_SESSION }),
    [RUNNER_SESSION]: sessionInfo({ id: RUNNER_SESSION, agent: "runner", parentID: PLANNER_SESSION }),
    [PLANNER_SESSION]: sessionInfo(),
  }
  const deps = { store, directory: DIRECTORY, getSession: async ({ sessionID }) => sessions[sessionID] }
  const tools = []
  addArtifactTools({ add: (tool) => tools.push(tool) }, deps)
  const publish = tools.find((tool) => tool.name === "artifact_publish")
  const getTool = tools.find((tool) => tool.name === "artifact_get")
  const patch = tools.find((tool) => tool.name === "artifact_patch")

  const plannerPublish = await publish.execute(
    { kind: "plan", title: "Shared plan", description: "A shared plan artifact.", body: "## Changes\n- Item.\n" },
    toolContext(PLANNER_SESSION, "planner"),
  )
  assert.match(plannerPublish.content, /^ARTIFACT_PUBLISHED/)
  assert.match(plannerPublish.content, new RegExp(`Owner: ${PLANNER_SESSION}`))
  assert.match(plannerPublish.content, new RegExp(`Author: ${PLANNER_SESSION}`))
  assert.match(plannerPublish.content, /Revision: [a-f0-9]{8}/)
  assert.match(plannerPublish.content, /Authority: implementation/)
  assert.match(plannerPublish.content, /Snapshot: /)
  const plannerID = /Artifact: (art_\S+)/.exec(plannerPublish.content)[1]
  const plannerRevision = /Revision: (\S+)/.exec(plannerPublish.content)[1]
  for (const line of plannerPublish.content.split("\n")) {
    const path = /^(Current markdown|Snapshot): (.+)$/.exec(line)
    if (path) {
      assert.ok(path[2].startsWith(root), `result paths come from the store, never from caller input: ${path[2]}`)
    }
  }

  // Search publishes evidence owned by its Planner; the author is the caller.
  const evidencePublish = await publish.execute(
    { kind: "evidence", title: "Search note", description: "Evidence artifact.", body: "# Note\n" },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(evidencePublish.content, /^ARTIFACT_PUBLISHED/)
  assert.match(evidencePublish.content, new RegExp(`Owner: ${PLANNER_SESSION}`))
  assert.match(evidencePublish.content, new RegExp(`Author: ${SEARCH_SESSION}`))
  assert.match(evidencePublish.content, /Authority: historical/)
  const evidenceID = /Artifact: (art_\S+)/.exec(evidencePublish.content)[1]
  const evidenceRevision = /Revision: (\S+)/.exec(evidencePublish.content)[1]

  const reviewPublish = await publish.execute(
    { kind: "evidence", title: "Review-authored evidence", description: "Evidence written by a review session.", body: "# Evidence\n" },
    toolContext(REVIEW_SESSION, "review"),
  )
  assert.match(reviewPublish.content, /^ARTIFACT_PUBLISHED/)
  assert.match(reviewPublish.content, new RegExp(`Author: ${REVIEW_SESSION}`))

  // Patch the evidence as a same-owner caller, with the expected revision.
  const patched = await patch.execute(
    {
      artifactID: evidenceID,
      expectedRevision: evidenceRevision,
      replacements: [{ oldText: "# Note", newText: "# Note, revised" }],
    },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(patched.content, /^ARTIFACT_PATCHED/)
  const patchedRevision = /Revision: (\S+)/.exec(patched.content)[1]
  assert.notEqual(patchedRevision, evidenceRevision)
  assert.match(patched.content, new RegExp(`Author: ${SEARCH_SESSION}`))
  assert.match(patched.content, /Authority: historical/)

  const runnerPublish = await publish.execute(
    { kind: "evidence", title: "Runner note", description: "Evidence artifact.", body: "# Note\n" },
    toolContext(RUNNER_SESSION, "runner"),
  )
  assert.match(runnerPublish.content, /^ARTIFACT_PUBLISHED/)
  assert.match(runnerPublish.content, new RegExp(`Author: ${RUNNER_SESSION}`))

  // Every patch must match the stored owner: a caller under a different Planner
  // is rejected by the store.
  const otherPlanner = "ses_otherplanner0000000000"
  const otherSessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: otherPlanner }),
    [otherPlanner]: sessionInfo({ id: otherPlanner }),
  }
  const otherDeps = { store, directory: DIRECTORY, getSession: async ({ sessionID }) => otherSessions[sessionID] }
  const otherTools = []
  addArtifactTools({ add: (tool) => otherTools.push(tool) }, otherDeps)
  const otherPatch = otherTools.find((tool) => tool.name === "artifact_patch")
  const rejected = await otherPatch.execute(
    { artifactID: evidenceID, expectedRevision: patchedRevision, replacements: [{ oldText: "revised", newText: "x" }] },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(rejected.content, /^ARTIFACT_ERROR/)
  assert.match(rejected.content, /forbidden: Patching is restricted to the owning session/)

  const planPatched = await patch.execute(
    { artifactID: plannerID, expectedRevision: plannerRevision, replacements: [{ oldText: "## Changes", newText: "## Changes (patched)" }] },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(planPatched.content, /^ARTIFACT_PATCHED/)

  // get returns only the immutable snapshot path for current state and exact historical revisions.
  const got = await getTool.execute({ artifactID: evidenceID }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(got.content, /^ARTIFACT/)
  assert.match(got.content, /Snapshot: /)
  assert.match(got.content, /\/revisions\//)
  assert.doesNotMatch(got.content, /--- artifact markdown ---/)
  assert.doesNotMatch(got.content, /# Note, revised/)
  const historical = await getTool.execute({ artifactID: evidenceID, revision: evidenceRevision }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(historical.content, new RegExp(`Snapshot: \\S*/revisions/${evidenceRevision}\\.md`))
  assert.doesNotMatch(historical.content, /# Note\n/)
  const missingGet = await getTool.execute({ artifactID: "art_00000000" }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(missingGet.content, /^ARTIFACT_ERROR/)
  assert.match(missingGet.content, /not_found/)

  // Unresolvable ancestry fails visibly on publish.
  const unresolvable = { store, directory: DIRECTORY, getSession: async () => { throw new Error("boom") } }
  const failingTools = []
  addArtifactTools({ add: (tool) => failingTools.push(tool) }, unresolvable)
  const failed = await failingTools.find((tool) => tool.name === "artifact_publish").execute(
    { kind: "plan", title: "t", description: "d", body: "b" },
    toolContext(PLANNER_SESSION, "planner"),
  )
  assert.match(failed.content, /^ARTIFACT_ERROR/)
  assert.match(failed.content, /owner_unresolved/)
})

// ---------------------------------------------------------------------------
// Plugin registration wiring (mocked ctx: nothing is sent anywhere)
// ---------------------------------------------------------------------------

async function setupPlugin(t, { sessions = {} } = {}) {
  await makeTempStateRoot(t)
  const tools = []
  const contracts = []
  const syntheticCalls = []
  const ctx = {
    location: { directory: DIRECTORY },
    session: {
      get: async ({ sessionID }) => {
        if (!(sessionID in sessions)) throw new Error(`unknown session ${sessionID}`)
        return sessions[sessionID]
      },
      // Mocked admission: records the call, never sends anything.
      synthetic: async (input) => {
        syntheticCalls.push(input)
        return { id: "msg_mocked" }
      },
    },
    tool: {
      transform: async (fn) => {
        fn({ add: (tool) => tools.push(tool) })
      },
    },
    rpc: {
      register: async (contract, handlers) => {
        contracts.push({ contract, handlers })
      },
    },
  }
  await plugin.setup(ctx)
  return { tools, contracts, syntheticCalls, sessions }
}

test("RPC surface exposes authority and delivers compact queued synthetic messages", async (t) => {
  const sessions = { [PLANNER_SESSION]: sessionInfo() }
  const { contracts, tools, syntheticCalls } = await setupPlugin(t, { sessions })
  const rpc = contracts.find((entry) => entry.contract.id === "personal.artifacts").handlers
  const publish = tools.find((tool) => tool.name === "artifact_publish")

  await publish.execute(
    { kind: "plan", title: "Shared plan", description: "A shared plan artifact.", body: "## Changes\n- Item.\n" },
    toolContext(PLANNER_SESSION, "planner"),
  )
  const list = await rpc.list({}, { error: () => { throw new Error("no") } })
  assert.equal(list.artifacts.length, 1)
  const artifact = list.artifacts[0]
  assert.equal(artifact.authority, "implementation")

  const feedback = await rpc.feedback(
    { artifactID: artifact.id, revision: artifact.revision, requestID: "req_feedback-mocked-1", question: "Is this complete?", selectedText: "- Item." },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(feedback.requestID, "req_feedback-mocked-1")
  assert.equal(feedback.kind, "feedback")
  assert.equal(feedback.delivery.state, "delivered")
  assert.equal(feedback.artifact.id, artifact.id)
  assert.equal(feedback.artifact.authority, "implementation")
  assert.equal(syntheticCalls.length, 1)
  const call = syntheticCalls[0]
  assert.equal(call.sessionID, PLANNER_SESSION)
  assert.equal(call.delivery, "queue")
  assert.equal(call.resume, true)
  assert.equal(call.description, "Artifact feedback: Shared plan")
  assert.match(call.text, new RegExp(`Artifact: ${artifact.id}@${artifact.revision}`))
  assert.match(call.text, /User question: Is this complete\?/)
  assert.match(call.text, /> - Item\./)
  assert.equal(call.metadata.requestID, "req_feedback-mocked-1")
  assert.equal(call.metadata.artifactID, artifact.id)
  assert.equal(call.metadata.revision, artifact.revision)
  assert.equal(call.metadata.authority, "implementation")

  // A duplicate request ID never sends again.
  const duplicate = await rpc.feedback(
    { artifactID: artifact.id, revision: artifact.revision, requestID: "req_feedback-mocked-1", question: "Again?" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(duplicate.deduplicated, true)
  assert.equal(syntheticCalls.length, 1)

  // Stale displayed revisions are rejected before delivery.
  await assert.rejects(
    rpc.feedback(
      { artifactID: artifact.id, revision: "00000000", requestID: "req_feedback-mocked-2", question: "stale" },
      { error: (code, message, data) => { throw new StoreError(code, message, data) } },
    ),
    (error) => error.code === "stale_revision",
  )
  assert.equal(syntheticCalls.length, 1)

  // Approval through the RPC: queued synthetic naming the single Builder launch.
  const approved = await rpc.approve(
    { artifactID: artifact.id, revision: artifact.revision, requestID: "req_approve-mocked-1" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(approved.kind, "approval")
  assert.equal(approved.delivery.state, "delivered")
  assert.equal(approved.artifact.status, "approved")
  assert.equal(approved.artifact.authority, "implementation")
  assert.equal(syntheticCalls.length, 2)
  const approvalCall = syntheticCalls[1]
  assert.equal(approvalCall.delivery, "queue")
  assert.equal(approvalCall.resume, true)
  assert.equal(approvalCall.description, "Artifact approval: Shared plan")
  assert.ok(approvalCall.text.split("\n").length <= 2)
  assert.match(approvalCall.text, new RegExp(`plan ${artifact.id}@${artifact.revision}`))
  assert.match(approvalCall.text, /ONE background Builder for that exact revision/)
  assert.equal(approvalCall.metadata.requestID, "req_approve-mocked-1")
  assert.equal(approvalCall.metadata.authority, "implementation")

  // Approving the same revision again deduplicates without re-delivering.
  const again = await rpc.approve(
    { artifactID: artifact.id, revision: artifact.revision, requestID: "req_approve-mocked-2" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(again.deduplicated, true)
  assert.equal(again.requestID, "req_approve-mocked-1")
  assert.equal(syntheticCalls.length, 2)

  // Retry with the original request ID reports the recorded delivery.
  const failed = await rpc.retry_delivery(
    { artifactID: artifact.id, requestID: "req_feedback-mocked-1" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(failed.requestID, "req_feedback-mocked-1")
  assert.equal(failed.deduplicated, true, "already-delivered submissions are not re-sent")
  const unknownRetry = rpc.retry_delivery(
    { artifactID: artifact.id, requestID: "req_unknown-mocked-1" },
    { error: (code, message, data) => { throw new StoreError(code, message, data) } },
  )
  await assert.rejects(unknownRetry, (error) => error.code === "not_found")
})

test("approval through the RPC regenerates the frontmatter and rejects evidence kinds", async (t) => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [PLANNER_SESSION]: sessionInfo(),
  }
  const { contracts, tools } = await setupPlugin(t, { sessions })
  const rpc = contracts.find((entry) => entry.contract.id === "personal.artifacts").handlers
  const publish = tools.find((tool) => tool.name === "artifact_publish")

  const evidence = await publish.execute(
    { kind: "evidence", title: "Search note", description: "Evidence artifact.", body: "# Note\n" },
    toolContext(SEARCH_SESSION, "search"),
  )
  const evidenceID = /Artifact: (art_\S+)/.exec(evidence.content)[1]
  const list = await rpc.list({}, { error: () => { throw new Error("no") } })
  const artifact = list.artifacts.find((entry) => entry.id === evidenceID)
  assert.equal(artifact.authority, "historical")
  await assert.rejects(
    rpc.approve(
      { artifactID: artifact.id, revision: artifact.revision, requestID: "req_approve-evidence-1" },
      { error: (code, message, data) => { throw new StoreError(code, message, data) } },
    ),
    (error) => error.code === "validation",
  )
  assert.equal(artifact.status, "published")

  // Plan approval through the RPC keeps the content revision while the file
  // frontmatter shows approved.
  const planPublish = await publish.execute(
    { kind: "plan", title: "Shared plan", description: "A shared plan artifact.", body: "## Changes\n- Item.\n" },
    toolContext(PLANNER_SESSION, "planner"),
  )
  const planID = /Artifact: (art_\S+)/.exec(planPublish.content)[1]
  const before = await rpc.get({ artifactID: planID }, { error: () => { throw new Error("no") } })
  assert.equal(before.artifact.authority, "implementation")
  await rpc.approve({ artifactID: planID, revision: before.artifact.revision, requestID: "req_approve-plan-1" }, { error: () => { throw new Error("no") } })
  const after = await rpc.get({ artifactID: planID }, { error: () => { throw new Error("no") } })
  assert.equal(after.artifact.status, "approved")
  assert.equal(after.artifact.authority, "implementation")
  assert.equal(after.artifact.revision, before.artifact.revision, "content revision unchanged by approval")
  assert.equal(after.artifact.content.split("\n").some((line) => line === 'status: "approved"'), true)

  // Patches to the approved plan are rejected through the tool as well.
  const patch = tools.find((tool) => tool.name === "artifact_patch")
  const frozen = await patch.execute(
    { artifactID: planID, expectedRevision: after.artifact.revision, replacements: [{ oldText: "Item", newText: "Entry" }] },
    toolContext(PLANNER_SESSION, "planner"),
  )
  assert.match(frozen.content, /^ARTIFACT_ERROR/)
  assert.match(frozen.content, /approved/)

  // List summaries stay available without historical snapshot contents.
  const listed = await rpc.list({}, { error: () => { throw new Error("no") } })
  assert.equal(listed.artifacts.length, 2)
  assert.ok(listed.artifacts.every((entry) => entry.content === undefined), "list reads do not fetch content")
})
