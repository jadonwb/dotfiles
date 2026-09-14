// Tests for the shared artifact tools, the artifact RPC contract, and the
// plugin registration wiring (mocked admission: no real prompt/synthetic
// message is ever submitted; ctx.session is a mock).
// Run from the chezmoi working directory:
//   mise exec -- node --experimental-strip-types --test dot_config/opencode/plugins/plan-bridge/artifact-tools.test.mjs

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createStore, StoreError } from "./store.mjs"
import { addArtifactTools, resolveProvenance } from "./artifact-tools.ts"
import plugin from "./index.ts"

const DIRECTORY = "/tmp/opencode/artifact-tools-location"
const PLANNER_SESSION = "ses_planner00000000000000000"
const SEARCH_SESSION = "ses_search00000000000000000"
const BUILDER_SESSION = "ses_builder00000000000000000"

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

function toolContext(sessionID, agent) {
  return { sessionID, agent, messageID: "msg_test", id: "tool_test" }
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

test("owner resolution walks server-assigned ancestry to the nearest Planner", async () => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [PLANNER_SESSION]: sessionInfo(),
  }
  const deps = { getSession: async ({ sessionID }) => sessions[sessionID], directory: DIRECTORY }
  const resolved = await resolveProvenance(deps, toolContext(SEARCH_SESSION, "search"))
  assert.deepEqual(resolved, { ownerSessionID: PLANNER_SESSION })

  const self = await resolveProvenance(deps, toolContext(PLANNER_SESSION, "planner"))
  assert.equal(self.ownerSessionID, PLANNER_SESSION)

  // Two-hop chains resolve to the root Planner; a cycle falls back to the caller.
  const deep = { ...sessions, [BUILDER_SESSION]: sessionInfo({ id: BUILDER_SESSION, agent: "builder", parentID: SEARCH_SESSION }) }
  const deepResolved = await resolveProvenance({ getSession: async ({ sessionID }) => deep[sessionID], directory: DIRECTORY }, toolContext(BUILDER_SESSION, "builder"))
  assert.equal(deepResolved.ownerSessionID, PLANNER_SESSION)

  const cycle = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: BUILDER_SESSION }),
    [BUILDER_SESSION]: sessionInfo({ id: BUILDER_SESSION, agent: "builder", parentID: SEARCH_SESSION }),
  }
  const cycleResolved = await resolveProvenance({ getSession: async ({ sessionID }) => cycle[sessionID], directory: DIRECTORY }, toolContext(SEARCH_SESSION, "search"))
  assert.equal(cycleResolved.ownerSessionID, SEARCH_SESSION)

  // The caller session must validate against the location.
  await assert.rejects(
    resolveProvenance({ getSession: async () => { throw new Error("boom") }, directory: DIRECTORY }, toolContext(SEARCH_SESSION, "search")),
    /owner_unresolved/,
  )
})

// ---------------------------------------------------------------------------
// Tool flows against a real store (temp root), with mocked sessions
// ---------------------------------------------------------------------------

test("artifact publish/patch/get flow: results carry kind/title/id/path", async (t) => {
  const { store, root } = await makeStore(t)
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
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
  assert.match(plannerPublish.content, /Kind: plan/)
  assert.match(plannerPublish.content, /Title: Shared plan/)
  assert.match(plannerPublish.content, /Artifact: art_[a-f0-9]{8}/)
  assert.match(plannerPublish.content, /Path: /)
  assert.doesNotMatch(plannerPublish.content, /Revision:|Snapshot:|Author:|Owner:/)
  const plannerID = /Artifact: (art_\S+)/.exec(plannerPublish.content)[1]
  const plannerPath = /Path: (.+)$/m.exec(plannerPublish.content)[1]
  assert.ok(plannerPath.startsWith(root), `result path comes from the store: ${plannerPath}`)

  const evidencePublish = await publish.execute(
    { kind: "evidence", title: "Search note", description: "Evidence artifact.", body: "# Note\n" },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(evidencePublish.content, /Title: Search note/)
  const evidenceID = /Artifact: (art_\S+)/.exec(evidencePublish.content)[1]

  // Patch with exact old/new text; no expected revision is required.
  const patched = await patch.execute(
    { artifactID: evidenceID, replacements: [{ oldText: "# Note", newText: "# Note, revised" }] },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(patched.content, /^ARTIFACT_PATCHED/)
  assert.match(patched.content, /Title: Search note/)
  assert.match(patched.content, /Path: /)
  assert.doesNotMatch(patched.content, /Revision:|Snapshot:/)

  // Every patch must match the stored owner.
  const otherPlanner = "ses_otherplanner0000000000"
  const otherSessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: otherPlanner }),
    [otherPlanner]: sessionInfo({ id: otherPlanner }),
  }
  const otherTools = []
  addArtifactTools({ add: (tool) => otherTools.push(tool) }, { store, directory: DIRECTORY, getSession: async ({ sessionID }) => otherSessions[sessionID] })
  const rejected = await otherTools
    .find((tool) => tool.name === "artifact_patch")
    .execute({ artifactID: evidenceID, replacements: [{ oldText: "revised", newText: "x" }] }, toolContext(SEARCH_SESSION, "search"))
  assert.match(rejected.content, /^ARTIFACT_ERROR/)
  assert.match(rejected.content, /forbidden: Patching is restricted to the owning session/)

  // get returns only the latest view path.
  const got = await getTool.execute({ artifactID: plannerID }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(got.content, /^ARTIFACT\nPath: /)
  assert.doesNotMatch(got.content, /Revision|Snapshot/)
  const missingGet = await getTool.execute({ artifactID: "art_00000000" }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(missingGet.content, /^ARTIFACT_ERROR/)
  assert.match(missingGet.content, /not_found/)

  // Unresolvable ancestry fails visibly on publish.
  const failingTools = []
  addArtifactTools({ add: (tool) => failingTools.push(tool) }, { store, directory: DIRECTORY, getSession: async () => { throw new Error("boom") } })
  const failed = await failingTools
    .find((tool) => tool.name === "artifact_publish")
    .execute({ kind: "plan", title: "t", description: "d", body: "b" }, toolContext(PLANNER_SESSION, "planner"))
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

test("RPC surface delivers compact queued synthetic messages by artifact ID", async (t) => {
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
  assert.equal(artifact.revision, undefined)
  assert.equal(artifact.authorSessionID, undefined)

  const feedback = await rpc.feedback(
    { artifactID: artifact.id, requestID: "req_feedback-mocked-1", question: "Is this complete?", selectedText: "- Item." },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(feedback.requestID, "req_feedback-mocked-1")
  assert.equal(feedback.kind, "feedback")
  assert.equal(feedback.delivery.state, "delivered")
  assert.equal(syntheticCalls.length, 1)
  const call = syntheticCalls[0]
  assert.equal(call.sessionID, PLANNER_SESSION)
  assert.equal(call.delivery, "queue")
  assert.equal(call.resume, true)
  assert.equal(call.description, "Feedback: Shared plan")
  assert.equal(call.text.includes(`Artifact: ${artifact.id}`), true)
  assert.equal(call.text.includes("@"), false)
  assert.match(call.text, /User question: Is this complete\?/)
  assert.match(call.text, /> - Item\./)
  assert.equal(call.metadata.requestID, "req_feedback-mocked-1")
  assert.equal(call.metadata.artifactID, artifact.id)
  assert.equal(call.metadata.revision, undefined)

  // A duplicate request ID never sends again.
  const duplicate = await rpc.feedback(
    { artifactID: artifact.id, requestID: "req_feedback-mocked-1", question: "Again?" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(duplicate.deduplicated, true)
  assert.equal(syntheticCalls.length, 1)

  // Approval through the RPC: queued synthetic carrying the artifact ID.
  const approved = await rpc.approve({ artifactID: artifact.id, requestID: "req_approve-mocked-1" }, { error: () => { throw new Error("no") } })
  assert.equal(approved.kind, "approval")
  assert.equal(approved.delivery.state, "delivered")
  assert.equal(approved.artifact.status, "approved")
  assert.equal(syntheticCalls.length, 2)
  const approvalCall = syntheticCalls[1]
  assert.equal(approvalCall.description, "Approval: Shared plan")
  assert.equal(approvalCall.text, `approval delivered: ${artifact.id}`)
  assert.equal(approvalCall.metadata.requestID, "req_approve-mocked-1")

  // Approving again deduplicates without re-delivering.
  const again = await rpc.approve({ artifactID: artifact.id, requestID: "req_approve-mocked-2" }, { error: () => { throw new Error("no") } })
  assert.equal(again.deduplicated, true)
  assert.equal(again.requestID, "req_approve-mocked-1")
  assert.equal(syntheticCalls.length, 2)

  // Retry with the original request ID reports the recorded delivery.
  const failed = await rpc.retry_delivery({ artifactID: artifact.id, requestID: "req_feedback-mocked-1" }, { error: () => { throw new Error("no") } })
  assert.equal(failed.requestID, "req_feedback-mocked-1")
  assert.equal(failed.deduplicated, true, "already-delivered submissions are not re-sent")
  await assert.rejects(
    rpc.retry_delivery({ artifactID: artifact.id, requestID: "req_unknown-mocked-1" }, { error: (code, message, data) => { throw new StoreError(code, message, data) } }),
    (error) => error.code === "not_found",
  )
})

test("approval through the RPC rejects evidence kinds and freezes patched plans", async (t) => {
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
  await assert.rejects(
    rpc.approve({ artifactID: evidenceID, requestID: "req_approve-evidence-1" }, { error: (code, message, data) => { throw new StoreError(code, message, data) } }),
    (error) => error.code === "validation",
  )

  const planPublish = await publish.execute(
    { kind: "plan", title: "Shared plan", description: "A shared plan artifact.", body: "## Changes\n- Item.\n" },
    toolContext(PLANNER_SESSION, "planner"),
  )
  const planID = /Artifact: (art_\S+)/.exec(planPublish.content)[1]
  await rpc.approve({ artifactID: planID, requestID: "req_approve-plan-1" }, { error: () => { throw new Error("no") } })

  const patch = tools.find((tool) => tool.name === "artifact_patch")
  const frozen = await patch.execute({ artifactID: planID, replacements: [{ oldText: "Item", newText: "Entry" }] }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(frozen.content, /^ARTIFACT_ERROR/)
  assert.match(frozen.content, /approved/)

  const listed = await rpc.list({}, { error: () => { throw new Error("no") } })
  assert.equal(listed.artifacts.length, 2)
  assert.ok(listed.artifacts.every((entry) => entry.content === undefined), "list reads do not fetch content")
})
