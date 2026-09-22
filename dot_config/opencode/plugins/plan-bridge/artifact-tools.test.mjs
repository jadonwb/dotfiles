// Tests for the capability-specific artifact tools, the artifact RPC contract,
// and the plugin registration wiring (mocked admission: no real prompt/synthetic
// message is ever submitted; ctx.session is a mock).
// Run from the chezmoi working directory:
//   mise exec -- node --experimental-strip-types --test dot_config/external_opencode/plugins/plan-bridge/artifact-tools.test.mjs

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createStore, StoreError } from "./store.mjs"
import { addArtifactTools, primaryAuthorOf, resolveProvenance } from "./artifact-tools.ts"
import plugin from "./index.ts"

const DIRECTORY = "/tmp/opencode/artifact-tools-location"
const PLANNER_SESSION = "ses_planner00000000000000000"
const SEARCH_SESSION = "ses_search00000000000000000"
const BUILDER_SESSION = "ses_builder00000000000000000"
const REVIEW_SESSION = "ses_review00000000000000000"
const OTHER_SESSION = "ses_villain0000000000000000"

// The complete effective tool name set (namespace_name); each is also its
// permission string. Names outside this set must never be registered.
const EXPECTED_TOOL_NAMES = [
  "evidence_create",
  "evidence_finalize",
  "evidence_finding_put",
  "evidence_finding_remove",
  "evidence_load",
  "evidence_overview_put",
  "evidence_summary",
  "plan_create",
  "plan_evidence_add",
  "plan_evidence_remove",
  "plan_field_patch",
  "plan_field_set",
  "plan_finalize",
  "plan_load_approved",
  "plan_status",
  "report_content_put",
  "report_content_remove",
  "report_create",
  "report_finalize",
  "report_load",
  "report_summary",
  "review_create",
  "review_finalize",
  "review_finding_put",
  "review_finding_remove",
  "review_load",
  "review_outcome_put",
  "review_summary",
  "review_summary_put",
]
// Names that must never appear in the registered tool set (asserted below).
const UNREGISTERED_NAMES = [
  "plan_publish",
  "plan_patch",
  "plan_item_put",
  "plan_item_remove",
  "evidence_publish",
  "evidence_patch",
  "evidence_topic_put",
  "evidence_topic_remove",
  "evidence_read",
  "review_publish",
  "review_patch",
  "review_verdict_put",
  "review_read",
]

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

function findTool(tools, effectiveName) {
  const tool = tools.find((candidate) => candidate.options.permission === effectiveName)
  if (!tool) throw new Error(`tool ${effectiveName} not registered`)
  return tool
}

function installEditor({ namespaces = [], tools = [] } = {}) {
  return {
    namespace: (namespace) => namespaces.push(namespace),
    add: (tool) => tools.push(tool),
  }
}

/** ToolExecute helper: returns the bare content string. */
async function execTool(tools, effectiveName, input, context) {
  const result = await findTool(tools, effectiveName).execute(input, context)
  return result.content
}

// ---------------------------------------------------------------------------
// Owner resolution and frontend author metadata
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

test("primaryAuthor is a frontend label derived from the agent, never a session ID", () => {
  assert.equal(primaryAuthorOf("planner"), "Planner")
  assert.equal(primaryAuthorOf("search"), "Search")
  assert.equal(primaryAuthorOf("builder"), "Builder")
  assert.equal(primaryAuthorOf("review"), "Review")
  assert.equal(primaryAuthorOf(""), "Author")
  assert.equal(primaryAuthorOf(undefined), "Author")
})

// ---------------------------------------------------------------------------
// Registration shape
// ---------------------------------------------------------------------------

test("registration declares plan/evidence/review/report namespaces and the exact effective tool names", async (t) => {
  const { store } = await makeStore(t)
  const namespaces = []
  const tools = []
  addArtifactTools(installEditor({ namespaces, tools }), {
    store,
    directory: DIRECTORY,
    getSession: async ({ sessionID }) => sessionInfo({ id: sessionID }),
  })

  assert.deepEqual(
    namespaces.map((namespace) => namespace.name).sort(),
    ["evidence", "plan", "report", "review"],
    "the Code Mode namespaces are declared",
  )
  const permissions = tools.map((tool) => tool.options.permission).sort()
  assert.deepEqual(permissions, [...EXPECTED_TOOL_NAMES].sort(), "only the registered tool names exist")

  for (const tool of tools) {
    assert.equal(tool.options.codemode, true, `${tool.options.namespace}_${tool.name} is Code Mode callable`)
    assert.equal(tool.options.permission, `${tool.options.namespace}_${tool.name}`, "permission is the documented effective name")
    assert.ok(namespaces.some((namespace) => namespace.name === tool.options.namespace), "namespace is declared")
  }
  for (const removed of UNREGISTERED_NAMES) {
    assert.equal(tools.some((tool) => tool.options.permission === removed), false, `${removed} is never registered`)
  }
})

// ---------------------------------------------------------------------------
// Plan tools: end-to-end chain with directly reusable bare IDs
// ---------------------------------------------------------------------------

test("plan tools: create→field_set→field_patch→evidence_add→finalize returns directly reusable machine values", async (t) => {
  const { store } = await makeStore(t)
  const sessions = {
    [PLANNER_SESSION]: sessionInfo(),
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
  }
  const deps = { store, directory: DIRECTORY, getSession: async ({ sessionID }) => sessions[sessionID] }
  const namespaces = []
  const tools = []
  addArtifactTools(installEditor({ namespaces, tools }), deps)

  // create returns the bare artifact ID — usable directly, no prose parsing.
  const planID = await execTool(
    tools,
    "plan_create",
    { title: "Shared plan", description: "A shared plan artifact.", workingDirectory: DIRECTORY },
    toolContext(PLANNER_SESSION, "planner"),
  )
  assert.match(planID, /^art_[a-f0-9]{8}$/, "create returns the bare artifact ID")

  // field_set / field_patch also return the bare artifact ID for reuse.
  const setResult = await execTool(tools, "plan_field_set", { artifactID: planID, field: "goalScope", content: "Scope one." }, toolContext(PLANNER_SESSION, "planner"))
  assert.equal(setResult, planID, "field_set returns the bare artifact ID")
  const patchResult = await execTool(
    tools,
    "plan_field_patch",
    { artifactID: planID, field: "intendedChanges", oldText: "", newText: "Change one." },
    toolContext(PLANNER_SESSION, "planner"),
  )
  assert.equal(patchResult, planID, "field_patch returns the bare artifact ID")

  // Patch conflict surfaces as a declared error, not a silent merge.
  const conflicted = await execTool(
    tools,
    "plan_field_patch",
    { artifactID: planID, field: "intendedChanges", oldText: "Stale base.", newText: "X." },
    toolContext(PLANNER_SESSION, "planner"),
  )
  assert.match(conflicted, /^ARTIFACT_ERROR\npatch_conflict:/)

  // Checks are optional: an otherwise complete plan can be finalized without them.
  const ready = await execTool(tools, "plan_finalize", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  assert.equal(ready, `${planID} finalized`)

  await execTool(tools, "plan_field_set", { artifactID: planID, field: "checks", content: "Run the tests." }, toolContext(PLANNER_SESSION, "planner"))
  assert.equal(await execTool(tools, "plan_field_set", { artifactID: planID, field: "checks", content: "" }, toolContext(PLANNER_SESSION, "planner")), planID)

  // Publish evidence, attach it by artifact ID, and verify the snapshot list.
  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Support", description: "Supporting evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  )
  await execTool(tools, "evidence_overview_put", { artifactID: evidenceID, summary: "Summary." }, toolContext(SEARCH_SESSION, "search"))
  await execTool(tools, "evidence_finalize", { artifactID: evidenceID }, toolContext(SEARCH_SESSION, "search"))
  const addResult = await execTool(tools, "plan_evidence_add", { artifactID: planID, evidenceIDs: [evidenceID] }, toolContext(PLANNER_SESSION, "planner"))
  assert.equal(addResult, planID, "plan_evidence_add returns the bare plan artifact ID")

  // status is a readable compact read.
  const status = await execTool(tools, "plan_status", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(status, /^ARTIFACT_STATUS\n/)
  assert.match(status, /Status: draft/)
  assert.match(status, /Kind: plan/)
  assert.match(status, /Title: Shared plan/)
  assert.match(status, /Author: Planner/)
  assert.match(status, /Finalized: false/)
  assert.doesNotMatch(status, /Owner: ses_/, "model-facing output never leaks session identities")
  assert.doesNotMatch(status, /Change one/, "plan_status never inlines the body")

  // Approval before finalize is blocked at the store (readiness gate).
  await assert.rejects(
    store.approveArtifact({ artifactID: planID, location: DIRECTORY, requestID: "req_approve-plan-0001" }),
    (error) => error instanceof StoreError && error.code === "not_ready",
  )

  // finalize returns the bare artifact ID/status contract.
  const finalized = await execTool(tools, "plan_finalize", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  assert.equal(finalized, `${planID} finalized`, "plan finalize returns the bare contract")

  await store.approveArtifact({ artifactID: planID, location: DIRECTORY, requestID: "req_approve-plan-0001" })
  const loaded = await execTool(tools, "plan_load_approved", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(loaded, /^ARTIFACT_CONTENT\n/)
  assert.match(loaded, /Status: approved/)
  assert.match(loaded, /Kind: plan/)
  assert.match(loaded, /Author: Planner/)
  assert.match(loaded, new RegExp(`Evidence: ${evidenceID}`), "evidence membership IDs are listed compactly")
  assert.match(loaded, /# Goal \/ Scope/, "the generated document is inline")
  assert.match(loaded, /- Supporting evidence artifact\. \(art_[a-f0-9]{8}\)/, "evidence snapshot renders beside the artifact ID")
  assert.doesNotMatch(loaded, /Owner: ses_/, "full loaders never render session identities")

  // A nonexistent ID is a clean not_found from a loader.
  const missing = await execTool(tools, "evidence_load", { artifactID: "art_00000000" }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(missing, /^ARTIFACT_ERROR/)
  assert.match(missing, /not_found/)
})

// ---------------------------------------------------------------------------
// Evidence tools
// ---------------------------------------------------------------------------

test("evidence tools: writer-only mutation, resume access, overview/findings, summary-vs-load boundaries", async (t) => {
  const { store } = await makeStore(t)
  const sessions = {
    [PLANNER_SESSION]: sessionInfo(),
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [OTHER_SESSION]: sessionInfo({ id: OTHER_SESSION, agent: "search", parentID: PLANNER_SESSION }),
  }
  const deps = { store, directory: DIRECTORY, getSession: async ({ sessionID }) => sessions[sessionID] }
  const namespaces = []
  const tools = []
  addArtifactTools(installEditor({ namespaces, tools }), deps)

  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(evidenceID, /^art_[a-f0-9]{8}$/)

  const overview = await execTool(
    tools,
    "evidence_overview_put",
    { artifactID: evidenceID, question: "Which files?", summary: "Key summary.", limitations: "Limits." },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.equal(overview, evidenceID, "overview_put returns the bare artifact ID")

  // Appending a finding returns the bare generated finding ID — reusable directly.
  const findingID = await execTool(
    tools,
    "evidence_finding_put",
    { artifactID: evidenceID, title: "Exact paths", content: "store.mjs." },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(findingID, /^fin_[a-f0-9]{8}$/, "appending returns the bare finding ID")

  const replaced = await execTool(
    tools,
    "evidence_finding_put",
    { artifactID: evidenceID, findingID, title: "Exact paths", content: "Three files." },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.equal(replaced, findingID, "a supplied finding ID returns the same bare ID")

  // Mutation is writer-only: a sibling Search session and the owner Planner
  // are both rejected even though the owner matches the artifact owner.
  for (const sessionID of [OTHER_SESSION, PLANNER_SESSION]) {
    const rejected = await execTool(
      tools,
      "evidence_overview_put",
      { artifactID: evidenceID, summary: "x" },
      toolContext(sessionID, sessionID === PLANNER_SESSION ? "planner" : "search"),
    )
    assert.match(rejected, /^ARTIFACT_ERROR/)
    assert.match(rejected, /forbidden: Content mutations are restricted to the writer session/)
  }

  // Resuming the same writer session retains write access.
  const resumed = await execTool(
    tools,
    "evidence_overview_put",
    { artifactID: evidenceID, limitations: "Revised limits." },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.equal(resumed, evidenceID)

  // Kind isolation: evidence tools reject plan IDs.
  const planInStore = await store.createArtifact({
    kind: "plan",
    ownerSessionID: PLANNER_SESSION,
    writerSessionID: SEARCH_SESSION,
    primaryAuthor: "Planner",
    location: DIRECTORY,
    title: "Plan",
    description: "d",
    workingDirectory: DIRECTORY,
  })
  const wrongKind = await execTool(
    tools,
    "evidence_overview_put",
    { artifactID: planInStore.artifactID, summary: "x" },
    toolContext(SEARCH_SESSION, "search"),
  )
  assert.match(wrongKind, /^ARTIFACT_ERROR/)
  assert.match(wrongKind, /invalid_kind/, "evidence_overview_put is evidence-only")

  const finalized = await execTool(tools, "evidence_finalize", { artifactID: evidenceID }, toolContext(SEARCH_SESSION, "search"))
  assert.equal(finalized, `${evidenceID} published`, "evidence finalize returns the bare contract")

  // Full loader (Builder/Review): content plus the author's finding IDs.
  const loaded = await execTool(tools, "evidence_load", { artifactID: evidenceID }, toolContext(SEARCH_SESSION, "search"))
  assert.match(loaded, /^ARTIFACT_CONTENT\n/)
  assert.match(loaded, new RegExp(`Findings: ${findingID}`), "finding IDs are listed for the author's follow-up edits")
  assert.match(loaded, /# Evidence/)
  assert.match(loaded, /\*\*Question\.\*\* Which files\?/)
  const evidenceView = await store.getArtifact({ artifactID: evidenceID, location: DIRECTORY })
  assert.equal(evidenceView.status, "published", "evidence_load must not mark read")

  // Planner summary reader: overview fields only, never findings.
  const summary = await execTool(tools, "evidence_summary", { artifactID: evidenceID }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(summary, /^ARTIFACT_SUMMARY\n/)
  assert.match(summary, /Status: published/)
  assert.match(summary, /Question: Which files\?/)
  assert.match(summary, /Summary: Key summary\./)
  assert.match(summary, /Limitations: Revised limits\./)
  assert.doesNotMatch(summary, /Findings:/, "evidence_summary never returns detailed findings")
  assert.doesNotMatch(summary, /store\.mjs|Three files/, "evidence_summary never inlines finding content")

  // Removing by the bare finding ID works.
  const removed = await execTool(tools, "evidence_finding_remove", { artifactID: evidenceID, findingID }, toolContext(SEARCH_SESSION, "search"))
  assert.equal(removed, findingID, "finding_remove returns the bare finding ID")
  assert.match(await execTool(tools, "evidence_summary", { artifactID: evidenceID }, toolContext(PLANNER_SESSION, "planner")), /Status: draft/, "a finding mutation returns evidence to draft")
})

// ---------------------------------------------------------------------------
// Review tools
// ---------------------------------------------------------------------------

test("review tools: outcome, summary, findings, finalize, load, summary; kinds stay isolated", async (t) => {
  const { store } = await makeStore(t)
  const sessions = { [PLANNER_SESSION]: sessionInfo(), [REVIEW_SESSION]: sessionInfo({ id: REVIEW_SESSION, agent: "review", parentID: PLANNER_SESSION }) }
  const deps = { store, directory: DIRECTORY, getSession: async ({ sessionID }) => sessions[sessionID] }
  const namespaces = []
  const tools = []
  addArtifactTools(installEditor({ namespaces, tools }), deps)

  const reviewID = await execTool(
    tools,
    "review_create",
    { title: "Review report", description: "Review artifact." },
    toolContext(REVIEW_SESSION, "review"),
  )
  assert.match(reviewID, /^art_[a-f0-9]{8}$/)

  const outcome = await execTool(tools, "review_outcome_put", { artifactID: reviewID, outcome: "Changes required" }, toolContext(REVIEW_SESSION, "review"))
  assert.equal(outcome, reviewID, "outcome_put returns the bare artifact ID")
  const summary = await execTool(
    tools,
    "review_summary_put",
    { artifactID: reviewID, content: "One medium finding; no blockers." },
    toolContext(REVIEW_SESSION, "review"),
  )
  assert.equal(summary, reviewID, "summary_put returns the bare artifact ID")

  const findingID = await execTool(
    tools,
    "review_finding_put",
    { artifactID: reviewID, title: "Scope leak", severity: "high", affected: "store.mjs", correction: "Constrain removal." },
    toolContext(REVIEW_SESSION, "review"),
  )
  assert.match(findingID, /^fin_[a-f0-9]{8}$/)

  const replaced = await execTool(
    tools,
    "review_finding_put",
    { artifactID: reviewID, findingID, title: "Scope leak (revised)", severity: "medium", correction: "Same correction." },
    toolContext(REVIEW_SESSION, "review"),
  )
  assert.equal(replaced, findingID, "a supplied finding ID returns the same bare ID")

  const finalized = await execTool(tools, "review_finalize", { artifactID: reviewID }, toolContext(REVIEW_SESSION, "review"))
  assert.equal(finalized, `${reviewID} published`, "review finalize returns the bare contract")

  // Builder load (correction work): full content, outcome, finding IDs.
  const loaded = await execTool(tools, "review_load", { artifactID: reviewID }, toolContext(BUILDER_SESSION, "builder"))
  assert.match(loaded, /^ARTIFACT_CONTENT\n/)
  assert.match(loaded, /Outcome: Changes required/)
  assert.match(loaded, new RegExp(`Findings: ${findingID}`))
  assert.match(loaded, /# Review/)
  assert.match(loaded, /## Outcome/)
  assert.match(loaded, /## Summary/)
  assert.match(loaded, /- Severity: medium/)
  assert.match(loaded, /- Correction: Same correction\./)

  // Planner summary reader: outcome/summary only, never findings.
  const reviewSummary = await execTool(tools, "review_summary", { artifactID: reviewID }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(reviewSummary, /^ARTIFACT_SUMMARY\n/)
  assert.match(reviewSummary, /Outcome: Changes required/)
  assert.match(reviewSummary, /Summary: One medium finding; no blockers\./)
  assert.doesNotMatch(reviewSummary, /Findings:/, "review_summary never returns detailed findings")
  assert.doesNotMatch(reviewSummary, /Scope leak/, "review_summary never inlines finding content")

  const wrongKind = await execTool(tools, "review_summary", { artifactID: "art_00000000" }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(wrongKind, /^ARTIFACT_ERROR/)
  assert.match(wrongKind, /not_found/)
})

// ---------------------------------------------------------------------------
// Report tools
// ---------------------------------------------------------------------------

async function toolsWithApprovedPlan(t, contextOverrides = {}) {
  const { store } = await makeStore(t)
  const sessions = {
    [PLANNER_SESSION]: sessionInfo(),
    [BUILDER_SESSION]: sessionInfo({ id: BUILDER_SESSION, agent: "builder", parentID: PLANNER_SESSION }),
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [REVIEW_SESSION]: sessionInfo({ id: REVIEW_SESSION, agent: "review", parentID: PLANNER_SESSION }),
    ...contextOverrides,
  }
  const deps = { store, directory: DIRECTORY, getSession: async ({ sessionID }) => sessions[sessionID] }
  const namespaces = []
  const tools = []
  addArtifactTools(installEditor({ namespaces, tools }), deps)

  const planID = await execTool(
    tools,
    "plan_create",
    { title: "Linked plan", description: "A linked plan artifact.", workingDirectory: DIRECTORY },
    toolContext(PLANNER_SESSION, "planner"),
  )
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "goalScope", content: "Goal." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_patch", { artifactID: planID, field: "intendedChanges", oldText: "", newText: "Change." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "checks", content: "Check." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_finalize", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  await store.approveArtifact({ artifactID: planID, location: DIRECTORY, requestID: "req_approve-report-plan" })
  return { store, tools, planID, sessions, deps }
}

test("report tools: create links the approved plan, content sections, finalize, load, summary", async (t) => {
  const { store, tools, planID } = await toolsWithApprovedPlan(t)

  // A draft plan cannot back a report (linked to approved plans only).
  const draftPlan = await execTool(
    tools,
    "plan_create",
    { title: "Draft plan", description: "Not approved yet.", workingDirectory: DIRECTORY },
    toolContext(PLANNER_SESSION, "planner"),
  )
  const createError = await execTool(tools, "report_create", { planArtifactID: draftPlan }, toolContext(BUILDER_SESSION, "builder"))
  assert.match(createError, /^ARTIFACT_ERROR/)
  assert.match(createError, /not_approved/)

  const reportID = await execTool(tools, "report_create", { planArtifactID: planID }, toolContext(BUILDER_SESSION, "builder"))
  assert.match(reportID, /^art_[a-f0-9]{8}$/, "report_create returns the bare artifact ID")

  await execTool(tools, "report_content_put", { artifactID: reportID, section: "changed", content: "store.mjs: flat plan model." }, toolContext(BUILDER_SESSION, "builder"))
  await execTool(tools, "report_content_put", { artifactID: reportID, section: "checks", content: "store.test.mjs: pass." }, toolContext(BUILDER_SESSION, "builder"))
  const unfinished = await execTool(tools, "report_content_put", { artifactID: reportID, section: "unfinished", content: "Cutover deferred." }, toolContext(BUILDER_SESSION, "builder"))
  assert.equal(unfinished, reportID)

  const removed = await execTool(tools, "report_content_remove", { artifactID: reportID, section: "unfinished" }, toolContext(BUILDER_SESSION, "builder"))
  assert.equal(removed, reportID, "report_content_remove returns the bare artifact ID")

  const badSection = await execTool(tools, "report_content_put", { artifactID: reportID, section: "goalScope", content: "x" }, toolContext(BUILDER_SESSION, "builder"))
  assert.match(badSection, /^ARTIFACT_ERROR/)
  assert.match(badSection, /validation/)

  // Non-writer Planner cannot mutate the Builder's report.
  const forbidden = await execTool(tools, "report_content_put", { artifactID: reportID, section: "summary", content: "x" }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(forbidden, /^ARTIFACT_ERROR/)
  assert.match(forbidden, /forbidden/)

  // Finalization requires the Summary; the report has only Changed/Checks so far.
  const failed = await execTool(tools, "report_finalize", { artifactID: reportID }, toolContext(BUILDER_SESSION, "builder"))
  assert.match(failed, /^ARTIFACT_ERROR/)
  assert.match(failed, /validation/)

  const summaryResult = await execTool(tools, "report_content_put", { artifactID: reportID, section: "summary", content: "Implemented." }, toolContext(BUILDER_SESSION, "builder"))
  assert.equal(summaryResult, reportID, "report_content_put returns the bare artifact ID")
  await execTool(tools, "report_content_put", { artifactID: reportID, section: "unfinished", content: "Cutover deferred." }, toolContext(BUILDER_SESSION, "builder"))
  const finalized = await execTool(tools, "report_finalize", { artifactID: reportID }, toolContext(BUILDER_SESSION, "builder"))
  assert.equal(finalized, `${reportID} published`, "report finalize returns the bare contract")

  // Review load: full content including Changed/Checks/Unfinished and the linked plan.
  const loaded = await execTool(tools, "report_load", { artifactID: reportID }, toolContext(REVIEW_SESSION, "review"))
  assert.match(loaded, /^ARTIFACT_CONTENT\n/)
  assert.match(loaded, new RegExp(`Plan: ${planID}`), "report_load lists the linked plan artifact ID")
  assert.match(loaded, /# Report/)
  assert.match(loaded, /## Summary/)
  assert.match(loaded, /## Changed/)
  assert.match(loaded, /store\.mjs: flat plan model\./)
  assert.match(loaded, /## Checks/)
  assert.match(loaded, /## Unfinished/)
  assert.match(loaded, /Cutover deferred\./)

  // Planner summary: metadata, linked plan, Summary only — no Changed/Checks/Unfinished.
  const summary = await execTool(tools, "report_summary", { artifactID: reportID }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(summary, /^ARTIFACT_SUMMARY\n/)
  assert.match(summary, /Status: published/)
  assert.match(summary, new RegExp(`Plan: ${planID}`))
  assert.match(summary, /Summary: Implemented\./)
  assert.doesNotMatch(summary, /store\.mjs|store\.test\.mjs|Cutover/, "report_summary hides Changed/Checks/Unfinished detail")

  // Reports are non-plan: mark-read RPC dismissal works via store directly.
  const read = await store.markArtifactRead({ artifactID: reportID, location: DIRECTORY, requestID: "req_read-report-0001" })
  assert.equal(read.artifact.status, "read")
})

// ---------------------------------------------------------------------------
// Loaders resolve no session
// ---------------------------------------------------------------------------

test("read tools resolve no session: loaders work when getSession is unavailable", async (t) => {
  const { store } = await makeStore(t)
  const evidence = await store.createArtifact({
    kind: "evidence",
    ownerSessionID: PLANNER_SESSION,
    writerSessionID: SEARCH_SESSION,
    primaryAuthor: "Search",
    location: DIRECTORY,
    title: "Note",
    description: "d",
  })
  await store.evidenceOverviewPut({ artifactID: evidence.artifactID, location: DIRECTORY, writerSessionID: SEARCH_SESSION, summary: "A" })

  const deps = { store, directory: DIRECTORY, getSession: async () => { throw new Error("boom") } }
  const namespaces = []
  const tools = []
  addArtifactTools(installEditor({ namespaces, tools }), deps)
  const loaded = await execTool(tools, "evidence_load", { artifactID: evidence.artifactID }, toolContext(SEARCH_SESSION, "search"))
  assert.match(loaded, /^ARTIFACT_CONTENT/)
})

// ---------------------------------------------------------------------------
// Plugin registration wiring (mocked ctx: nothing is sent anywhere)
// ---------------------------------------------------------------------------

async function setupPlugin(t, { sessions = {}, syntheticThrowFor = [] } = {}) {
  await makeTempStateRoot(t)
  const tools = []
  const contracts = []
  const namespaces = []
  const syntheticCalls = []
  const ctx = {
    location: { directory: DIRECTORY },
    session: {
      get: async ({ sessionID }) => {
        if (!(sessionID in sessions)) throw new Error(`unknown session ${sessionID}`)
        return sessions[sessionID]
      },
      synthetic: async (input) => {
        if (syntheticThrowFor.includes(input.sessionID)) {
          throw new Error(`unavailable session ${input.sessionID}`)
        }
        syntheticCalls.push(input)
        return { id: "msg_mocked" }
      },
    },
    tool: {
      transform: async (fn) => {
        fn({ namespace: (namespace) => namespaces.push(namespace), add: (tool) => tools.push(tool) })
      },
    },
    rpc: {
      register: async (contract, handlers) => {
        contracts.push({ contract, handlers })
      },
    },
  }
  await plugin.setup(ctx)
  return { tools, contracts, namespaces, syntheticCalls, sessions }
}

test("RPC surface exposes frontend metadata only, strips the writer session, and delivers compact queued owner feedback/approvals", async (t) => {
  const sessions = { [PLANNER_SESSION]: sessionInfo() }
  const { contracts, tools, namespaces, syntheticCalls } = await setupPlugin(t, { sessions })
  const rpc = contracts.find((entry) => entry.contract.id === "personal.artifacts").handlers
  assert.deepEqual(namespaces.map((namespace) => namespace.name).sort(), ["evidence", "plan", "report", "review"])

  const planID = await execTool(
    tools,
    "plan_create",
    { title: "Shared plan", description: "A shared plan artifact.", workingDirectory: DIRECTORY },
    toolContext(PLANNER_SESSION, "planner"),
  )
  const list = await rpc.list({}, { error: () => { throw new Error("no") } })
  assert.equal(list.artifacts.length, 1)
  const artifact = list.artifacts[0]
  assert.equal(artifact.finalized, false, "list carries readiness")
  assert.equal(artifact.primaryAuthor, "Planner", "list carries the frontend primary author")
  assert.equal(artifact.writerSessionID, undefined, "the writer session identity never leaves the wire contract")
  assert.equal(artifact.ownerSessionID, PLANNER_SESSION, "owner-scoping metadata stays for attached-session filtering")
  assert.equal(artifact.revision, undefined)
  assert.equal(artifact.authorSessionID, undefined)

  await execTool(tools, "plan_field_set", { artifactID: planID, field: "goalScope", content: "- Goal." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "checks", content: "Run tests." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_patch", { artifactID: planID, field: "intendedChanges", oldText: "", newText: "- Change." }, toolContext(PLANNER_SESSION, "planner"))

  // Explicit owner recipient: synthetic queued message to the owner session.
  const feedback = await rpc.feedback(
    { artifactID: planID, requestID: "req_feedback-mocked-1", question: "Is this complete?", selectedText: "- Goal.", recipient: "owner" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(feedback.requestID, "req_feedback-mocked-1")
  assert.equal(feedback.kind, "feedback")
  assert.equal(feedback.delivery.state, "delivered")
  assert.equal(syntheticCalls.length, 1)
  const call = syntheticCalls[0]
  assert.equal(call.sessionID, PLANNER_SESSION, "owner feedback targets the owning Planner session")
  assert.equal(call.delivery, "queue")
  assert.equal(call.resume, true)
  assert.equal(call.description, "Feedback: Shared plan")
  assert.equal(call.metadata.recipient, "owner")
  assert.equal(call.metadata.artifactID, planID)
  assert.match(call.text, /User question: Is this complete\?/)

  const duplicate = await rpc.feedback(
    { artifactID: planID, requestID: "req_feedback-mocked-1", question: "Again?" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(duplicate.deduplicated, true)
  assert.equal(syntheticCalls.length, 1)

  // Non-finalized plans cannot be approved: not_ready, no delivery.
  await assert.rejects(
    rpc.approve_plan({ artifactID: planID, requestID: "req_approve-mocked-1" }, { error: (code, message, data) => { throw new StoreError(code, message, data) } }),
    (error) => error.code === "not_ready",
  )
  assert.equal(syntheticCalls.length, 1)

  await execTool(tools, "plan_finalize", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  const approved = await rpc.approve_plan({ artifactID: planID, requestID: "req_approve-mocked-1" }, { error: () => { throw new Error("no") } })
  assert.equal(approved.kind, "approval")
  assert.equal(approved.delivery.state, "delivered")
  assert.equal(approved.artifact.status, "approved")
  assert.equal(approved.artifact.finalized, true)
  assert.equal(approved.artifact.writerSessionID, undefined, "approve output strips the writer identity too")
  assert.equal(syntheticCalls.length, 2)
  const approvalCall = syntheticCalls[1]
  assert.equal(approvalCall.description, "Approval: Shared plan")
  assert.equal(approvalCall.text, `approval delivered: ${planID} (kind=plan status=approved finalized=true)`, "the approval payload carries the frozen fields Planner needs for direct dispatch")
  assert.equal(approvalCall.metadata.recipient, "owner")

  const again = await rpc.approve_plan({ artifactID: planID, requestID: "req_approve-mocked-2" }, { error: () => { throw new Error("no") } })
  assert.equal(again.deduplicated, true)
  assert.equal(again.requestID, "req_approve-mocked-1")
  assert.equal(syntheticCalls.length, 2)

  const retried = await rpc.retry_plan_delivery({ artifactID: planID, requestID: "req_approve-mocked-1" }, { error: () => { throw new Error("no") } })
  assert.equal(retried.requestID, "req_approve-mocked-1")
  assert.equal(retried.deduplicated, true, "already-delivered submissions are not re-sent")
  assert.equal(retried.kind, "approval")

  // Feedback is NOT retryable under the plan-only contract.
  await assert.rejects(
    rpc.retry_plan_delivery({ artifactID: planID, requestID: "req_feedback-mocked-1" }, { error: (code, message, data) => { throw new StoreError(code, message, data) } }),
    (error) => error.code === "not_found",
  )
  await assert.rejects(
    rpc.retry_plan_delivery({ artifactID: planID, requestID: "req_unknown-mocked-1" }, { error: (code, message, data) => { throw new StoreError(code, message, data) } }),
    (error) => error.code === "not_found",
  )
})

test("retried plan-approval delivery re-emits the same authoritative approval payload", async (t) => {
  await makeTempStateRoot(t)
  const tools = []
  const contracts = []
  const syntheticCalls = []
  const sessions = { [PLANNER_SESSION]: sessionInfo() }
  let admit = false
  const ctx = {
    location: { directory: DIRECTORY },
    session: {
      get: async ({ sessionID }) => sessions[sessionID],
      synthetic: async (input) => {
        if (!admit) {
          admit = true
          throw new Error("unavailable session")
        }
        syntheticCalls.push(input)
        return { id: "msg_mocked" }
      },
    },
    tool: {
      transform: async (fn) => {
        fn({ namespace: () => {}, add: (tool) => tools.push(tool) })
      },
    },
    rpc: {
      register: async (contract, handlers) => {
        contracts.push({ contract, handlers })
      },
    },
  }
  await plugin.setup(ctx)
  const rpc = contracts.find((entry) => entry.contract.id === "personal.artifacts").handlers

  const planID = await execTool(
    tools,
    "plan_create",
    { title: "Shared plan", description: "A shared plan artifact.", workingDirectory: DIRECTORY },
    toolContext(PLANNER_SESSION, "planner"),
  )
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "goalScope", content: "- Goal." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "checks", content: "Run tests." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_patch", { artifactID: planID, field: "intendedChanges", oldText: "", newText: "- Change." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_finalize", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))

  // The first admission fails, so the approval is recorded but undelivered.
  const approved = await rpc.approve_plan({ artifactID: planID, requestID: "req_approve-retry-1" }, { error: () => { throw new Error("no") } })
  assert.equal(approved.delivery.state, "failed")
  assert.equal(syntheticCalls.length, 0, "nothing was admitted on the failed attempt")

  // Retry re-emits the same current authoritative payload from the frozen record.
  const retried = await rpc.retry_plan_delivery({ artifactID: planID, requestID: "req_approve-retry-1" }, { error: () => { throw new Error("no") } })
  assert.equal(retried.delivery.state, "delivered")
  assert.equal(retried.deduplicated, false)
  assert.equal(syntheticCalls.length, 1)
  assert.equal(
    syntheticCalls[0].text,
    `approval delivered: ${planID} (kind=plan status=approved finalized=true)`,
    "retry re-emits the same deterministic authoritative payload",
  )
})

test("writer feedback routes to the stored writer session; reports list/mark-read; approval stays plan-only", async (t) => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [PLANNER_SESSION]: sessionInfo(),
  }
  const { contracts, tools, syntheticCalls } = await setupPlugin(t, { sessions })
  const rpc = contracts.find((entry) => entry.contract.id === "personal.artifacts").handlers

  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  )
  await execTool(tools, "evidence_overview_put", { artifactID: evidenceID, summary: "# Note\n" }, toolContext(SEARCH_SESSION, "search"))
  await execTool(tools, "evidence_finalize", { artifactID: evidenceID }, toolContext(SEARCH_SESSION, "search"))

  // recipient "writer" targets the stored writer identity (the Search session),
  // not the owner Planner.
  const feedback = await rpc.feedback(
    { artifactID: evidenceID, requestID: "req_writer-fb-1", question: "Direct?", recipient: "writer" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(feedback.delivery.state, "delivered")
  assert.equal(syntheticCalls.length, 1)
  assert.equal(syntheticCalls[0].sessionID, SEARCH_SESSION, "writer feedback targets the stored writer session")
  assert.equal(syntheticCalls[0].metadata.recipient, "writer")
  assert.equal(syntheticCalls[0].metadata.requestID, "req_writer-fb-1")

  // mark_read: status read, kind read, and NO synthetic message is emitted.
  const read = await rpc.mark_read({ artifactID: evidenceID, requestID: "req_read-evidence-1" }, { error: () => { throw new Error("no") } })
  assert.equal(read.kind, "read")
  assert.equal(read.deduplicated, false)
  assert.equal(read.delivery, undefined, "mark_read response has no delivery")
  assert.equal(read.artifact.status, "read")
  assert.equal(syntheticCalls.length, 1, "mark_read never notifies")

  // Approving evidence is a wrong-kind error.
  await assert.rejects(
    rpc.approve_plan({ artifactID: evidenceID, requestID: "req_approve-evidence-1" }, { error: (code, message, data) => { throw new StoreError(code, message, data) } }),
    (error) => error.code === "invalid_kind",
  )
  await assert.rejects(
    rpc.retry_plan_delivery({ artifactID: evidenceID, requestID: "req_read-evidence-1" }, { error: (code, message, data) => { throw new StoreError(code, message, data) } }),
    (error) => error.code === "invalid_kind",
  )

  // Reports flow through list/get/mark_read as non-plan artifacts.
  const planID = await execTool(
    tools,
    "plan_create",
    { title: "Link me", description: "Plan description.", workingDirectory: DIRECTORY },
    toolContext(PLANNER_SESSION, "planner"),
  )
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "goalScope", content: "G." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "checks", content: "C." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_patch", { artifactID: planID, field: "intendedChanges", oldText: "", newText: "I." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_finalize", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  await rpc.approve_plan({ artifactID: planID, requestID: "req_approve-plan-2" }, { error: () => { throw new Error("no") } })

  const reportID = await execTool(tools, "report_create", { planArtifactID: planID }, toolContext(SEARCH_SESSION, "search"))
  await execTool(tools, "report_content_put", { artifactID: reportID, section: "summary", content: "Done." }, toolContext(SEARCH_SESSION, "search"))
  await execTool(tools, "report_finalize", { artifactID: reportID }, toolContext(SEARCH_SESSION, "search"))

  const list2 = await rpc.list({}, { error: () => { throw new Error("no") } })
  const reportSummary = list2.artifacts.find((entry) => entry.id === reportID)
  assert.ok(reportSummary, "reports appear in list")
  assert.equal(reportSummary.kind, "report")
  assert.equal(reportSummary.primaryAuthor, "Search")
  assert.equal(reportSummary.ownerSessionID, PLANNER_SESSION, "report owner resolves to the Planner ancestry")

  const reportGet = await rpc.get({ artifactID: reportID }, { error: () => { throw new Error("no") } })
  assert.equal(reportGet.artifact.kind, "report")
  assert.equal(reportGet.artifact.writerSessionID, undefined, "get strips the report writer identity")
  assert.equal(reportGet.artifact.status, "published")

  const reportRead = await rpc.mark_read({ artifactID: reportID, requestID: "req_read-report-1" }, { error: () => { throw new Error("no") } })
  assert.equal(reportRead.artifact.status, "read", "reports dismiss with mark_read")
  assert.equal(syntheticCalls.length, 2, "report mark_read never notifies (feedback + plan approval are the only deliveries)")
})

test("unavailable writer delivery fails visibly and stays recorded; it is never rerouted", async (t) => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
    [PLANNER_SESSION]: sessionInfo(),
  }
  const { contracts, tools, syntheticCalls } = await setupPlugin(t, { sessions, syntheticThrowFor: [SEARCH_SESSION] })
  const rpc = contracts.find((entry) => entry.contract.id === "personal.artifacts").handlers

  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  )
  await execTool(tools, "evidence_overview_put", { artifactID: evidenceID, summary: "# Note\n" }, toolContext(SEARCH_SESSION, "search"))

  // The completed writer session cannot be reached: the decision is recorded
  // with state failed, never silently rerouted to the owner.
  const feedback = await rpc.feedback(
    { artifactID: evidenceID, requestID: "req_writer-fail-1", question: "Direct?", recipient: "writer" },
    { error: () => { throw new Error("no") } },
  )
  assert.equal(feedback.delivery.state, "failed")
  assert.match(feedback.delivery.error, /unavailable session/)
  assert.equal(syntheticCalls.length, 0, "the attempt never admitted a message")

  const view = await rpc.get({ artifactID: evidenceID }, { error: () => { throw new Error("no") } })
  const recorded = view.artifact.feedback.find((entry) => entry.requestID === "req_writer-fail-1")
  assert.ok(recorded, "the decision is recorded durably")
  assert.equal(recorded.recipient, "writer")
  assert.equal(recorded.delivery.state, "failed")
})

test("plan approval freezes tool edits; evidence edits after mark-read return to the visible draft", async (t) => {
  const sessions = {
    [PLANNER_SESSION]: sessionInfo(),
    [SEARCH_SESSION]: sessionInfo({ id: SEARCH_SESSION, agent: "search", parentID: PLANNER_SESSION }),
  }
  const { contracts, tools } = await setupPlugin(t, { sessions })
  const rpc = contracts.find((entry) => entry.contract.id === "personal.artifacts").handlers

  const planID = await execTool(
    tools,
    "plan_create",
    { title: "Shared plan", description: "A shared plan artifact.", workingDirectory: DIRECTORY },
    toolContext(PLANNER_SESSION, "planner"),
  )
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "goalScope", content: "- Goal." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_set", { artifactID: planID, field: "checks", content: "Run tests." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_field_patch", { artifactID: planID, field: "intendedChanges", oldText: "", newText: "- Change." }, toolContext(PLANNER_SESSION, "planner"))
  await execTool(tools, "plan_finalize", { artifactID: planID }, toolContext(PLANNER_SESSION, "planner"))
  await rpc.approve_plan({ artifactID: planID, requestID: "req_approve-plan-1" }, { error: () => { throw new Error("no") } })

  const frozen = await execTool(tools, "plan_field_set", { artifactID: planID, field: "goalScope", content: "Late edit." }, toolContext(PLANNER_SESSION, "planner"))
  assert.match(frozen, /^ARTIFACT_ERROR/)
  assert.match(frozen, /approved/, "approved plans reject every flat-field edit")

  // Evidence mark-read -> overview edit returns to the visible draft and must be
  // finalized again before the editor can mark it read.
  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  )
  await execTool(tools, "evidence_overview_put", { artifactID: evidenceID, summary: "# Note\n" }, toolContext(SEARCH_SESSION, "search"))
  await execTool(tools, "evidence_finalize", { artifactID: evidenceID }, toolContext(SEARCH_SESSION, "search"))
  await rpc.mark_read({ artifactID: evidenceID, requestID: "req_read-evidence-2" }, { error: () => { throw new Error("no") } })

  const edited = await execTool(tools, "evidence_overview_put", { artifactID: evidenceID, summary: "Revised." }, toolContext(SEARCH_SESSION, "search"))
  assert.equal(edited, evidenceID)
  const listed = await rpc.list({}, { error: () => { throw new Error("no") } })
  assert.equal(listed.artifacts.length, 2)
  assert.ok(listed.artifacts.every((entry) => entry.content === undefined), "list reads do not fetch content")
  const evidenceView = await rpc.get({ artifactID: evidenceID }, { error: () => { throw new Error("no") } })
  assert.equal(evidenceView.artifact.status, "draft")
  assert.equal(evidenceView.artifact.finalized, false)
  assert.equal(evidenceView.artifact.readAt, undefined, "the read marker is not part of the RPC view")
  assert.equal(evidenceView.artifact.writerSessionID, undefined, "get output strips the writer identity")
})
