// Tests for the capability-specific artifact tools, the artifact RPC contract,
// and the plugin registration wiring (mocked admission: no real prompt/synthetic
// message is ever submitted; ctx.session is a mock).
// Run from the chezmoi working directory:
//   mise exec -- node --experimental-strip-types --test dot_config/opencode/tests/artifacts/artifact-tools.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStore, StoreError } from "../../plugins/artifacts/store.mjs";
import {
  addArtifactTools,
  primaryAuthorOf,
  resolveProvenance,
} from "../../plugins/artifacts/artifact-tools.ts";
import plugin from "../../plugins/artifacts/index.ts";
import rpcPlugin from "../../plugins/artifacts-rpc/index.ts";

const DIRECTORY = "/tmp/opencode/artifact-tools-location";
const PRIMARY_SESSION = "ses_primary00000000000000000";
const SEARCH_SESSION = "ses_search00000000000000000";
const WORKER_SESSION = "ses_worker000000000000000000";
const REVIEW_SESSION = "ses_review00000000000000000";
const OTHER_SESSION = "ses_villain0000000000000000";

// The complete effective tool name set (namespace_name); each is also its
// permission string. Names outside this set must never be registered.
const EXPECTED_TOOL_NAMES = [
  "artifact_search",
  "evidence_create",
  "evidence_finalize",
  "evidence_finding",
  "evidence_load",
  "evidence_summary",
  "evidence_update",
  "plan_complete",
  "plan_create",
  "plan_finalize",
  "plan_load",
  "plan_update",
  "review_create",
  "review_finalize",
  "review_finding",
  "review_load",
  "review_summary",
  "review_update",
];
function sessionInfo(overrides = {}) {
  return {
    id: PRIMARY_SESSION,
    agent: "system",
    location: { directory: DIRECTORY },
    ...overrides,
  };
}

async function makeTempStateRoot(t) {
  const root = await mkdtemp(
    join(tmpdir(), "opencode", "artifact-tools-state-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.XDG_STATE_HOME = root;
  return root;
}

async function makeStore(t) {
  const root = await mkdtemp(
    join(tmpdir(), "opencode", "artifact-tools-store-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { store: createStore({ root }), root };
}

function toolContext(sessionID, agent) {
  return { sessionID, agent, messageID: "msg_test", id: "tool_test" };
}

function findTool(tools, effectiveName) {
  const tool = tools.find(
    (candidate) => candidate.options.permission === effectiveName,
  );
  if (!tool) throw new Error(`tool ${effectiveName} not registered`);
  return tool;
}

function installEditor({ namespaces = [], tools = [] } = {}) {
  return {
    namespace: (namespace) => namespaces.push(namespace),
    add: (tool) => tools.push(tool),
  };
}

/** ToolExecute helper: returns the bare content string. */
async function execTool(tools, effectiveName, input, context) {
  const result = await findTool(tools, effectiveName).execute(input, context);
  return result.content;
}

// ---------------------------------------------------------------------------
// Owner resolution and frontend author metadata
// ---------------------------------------------------------------------------

test("owner resolution walks server-assigned ancestry to the nearest primary agent", async () => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
    [PRIMARY_SESSION]: sessionInfo(),
  };
  const deps = {
    getSession: async ({ sessionID }) => sessions[sessionID],
    directory: DIRECTORY,
    projectDirectory: DIRECTORY,
  };
  const resolved = await resolveProvenance(
    deps,
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.deepEqual(resolved, { ownerSessionID: PRIMARY_SESSION });

  const self = await resolveProvenance(
    deps,
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.equal(self.ownerSessionID, PRIMARY_SESSION);

  // Two-hop chains resolve to the root primary agent; a cycle falls back to the caller.
  const deep = {
    ...sessions,
    [WORKER_SESSION]: sessionInfo({
      id: WORKER_SESSION,
      agent: "worker",
      parentID: SEARCH_SESSION,
    }),
  };
  const deepResolved = await resolveProvenance(
    {
      getSession: async ({ sessionID }) => deep[sessionID],
      directory: DIRECTORY,
      projectDirectory: DIRECTORY,
    },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.equal(deepResolved.ownerSessionID, PRIMARY_SESSION);

  const cycle = {
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: WORKER_SESSION,
    }),
    [WORKER_SESSION]: sessionInfo({
      id: WORKER_SESSION,
      agent: "worker",
      parentID: SEARCH_SESSION,
    }),
  };
  const cycleResolved = await resolveProvenance(
    {
      getSession: async ({ sessionID }) => cycle[sessionID],
      directory: DIRECTORY,
      projectDirectory: DIRECTORY,
    },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.equal(cycleResolved.ownerSessionID, SEARCH_SESSION);

  // The caller session must validate against the location.
  await assert.rejects(
    resolveProvenance(
      {
        getSession: async () => {
          throw new Error("boom");
        },
        directory: DIRECTORY,
        projectDirectory: DIRECTORY,
      },
      toolContext(SEARCH_SESSION, "search"),
    ),
    /owner_unresolved/,
  );
});

test("primaryAuthor is a frontend label derived from the agent, never a session ID", () => {
  assert.equal(primaryAuthorOf("system"), "System");
  assert.equal(primaryAuthorOf("search"), "Search");
  assert.equal(primaryAuthorOf("worker"), "Worker");
  assert.equal(primaryAuthorOf("review"), "Review");
  assert.equal(primaryAuthorOf(""), "Author");
  assert.equal(primaryAuthorOf(undefined), "Author");
});

// ---------------------------------------------------------------------------
// Registration shape
// ---------------------------------------------------------------------------

test("registration declares plan/evidence/review namespaces and the exact effective tool names", async (t) => {
  const { store } = await makeStore(t);
  const namespaces = [];
  const tools = [];
  addArtifactTools(installEditor({ namespaces, tools }), {
    store,
    directory: DIRECTORY,
    projectDirectory: DIRECTORY,
    getSession: async ({ sessionID }) => sessionInfo({ id: sessionID }),
  });

  assert.deepEqual(
    namespaces.map((namespace) => namespace.name).sort(),
    ["artifact", "evidence", "plan", "review"],
    "the Code Mode namespaces are declared",
  );
  const permissions = tools.map((tool) => tool.options.permission).sort();
  assert.deepEqual(
    permissions,
    [...EXPECTED_TOOL_NAMES].sort(),
    "only the registered tool names exist",
  );

  for (const tool of tools) {
    assert.equal(
      tool.options.codemode,
      true,
      `${tool.options.namespace}_${tool.name} is Code Mode callable`,
    );
    assert.equal(
      tool.options.permission,
      `${tool.options.namespace}_${tool.name}`,
      "permission is the documented effective name",
    );
    assert.ok(
      namespaces.some((namespace) => namespace.name === tool.options.namespace),
      "namespace is declared",
    );
  }
});

// ---------------------------------------------------------------------------
// Plan tools: end-to-end chain with directly reusable bare IDs
// ---------------------------------------------------------------------------

test("plan tools: create→update→evidence membership→finalize returns directly reusable machine values", async (t) => {
  const { store } = await makeStore(t);
  const sessions = {
    [PRIMARY_SESSION]: sessionInfo(),
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
  };
  const deps = {
    store,
    directory: DIRECTORY,
    projectDirectory: DIRECTORY,
    getSession: async ({ sessionID }) => sessions[sessionID],
  };
  const namespaces = [];
  const tools = [];
  addArtifactTools(installEditor({ namespaces, tools }), deps);

  // create accepts initial fields and returns the bare artifact ID.
  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "Shared plan",
      description: "A shared plan artifact.",
      workingDirectory: DIRECTORY,
      goalScope: "Scope one.",
      intendedChanges: "Change one.",
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(
    planID,
    /^art_[a-f0-9]{8}$/,
    "create returns the bare artifact ID",
  );

  // update replaces fields wholesale and returns the bare artifact ID.
  const updateResult = await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      context: "Context one.",
      checks: "Run the tests.",
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.equal(updateResult, planID, "plan_update returns the bare artifact ID");

  // A targeted patch changes one exact occurrence.
  const patchResult = await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      patch: {
        field: "intendedChanges",
        oldText: "Change one.",
        newText: "Change two.",
      },
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.equal(patchResult, planID, "plan patch returns the bare artifact ID");

  // Patch conflict surfaces as a declared error, not a silent merge.
  const conflicted = await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      patch: {
        field: "intendedChanges",
        oldText: "Stale base.",
        newText: "X.",
      },
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(conflicted, /^ARTIFACT_ERROR\npatch_conflict:/);

  // Approving an unfinished draft is blocked at the store (readiness gate).
  await assert.rejects(
    store.approveArtifact({
      artifactID: planID,
      location: DIRECTORY,
      requestID: "req_approve-plan-0001",
    }),
    (error) => error instanceof StoreError && error.code === "not_ready",
  );

  // Checks are optional and can be cleared with an empty string.
  assert.equal(
    await execTool(
      tools,
      "plan_update",
      { artifactID: planID, checks: "" },
      toolContext(PRIMARY_SESSION, "system"),
    ),
    planID,
  );

  const ready = await execTool(
    tools,
    "plan_finalize",
    { artifactID: planID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.equal(ready, `${planID} finalized`);

  // Publish evidence, attach it by artifact ID, and verify the snapshot list.
  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Support", description: "Supporting evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "evidence_update",
    { artifactID: evidenceID, summary: "Summary." },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "evidence_finalize",
    { artifactID: evidenceID },
    toolContext(SEARCH_SESSION, "search"),
  );
  const addResult = await execTool(
    tools,
    "plan_update",
    { artifactID: planID, evidenceIDs: [evidenceID] },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.equal(
    addResult,
    planID,
    "plan_update evidenceIDs returns the bare plan artifact ID",
  );
  assert.equal(
    await execTool(
      tools,
      "plan_finalize",
      { artifactID: planID },
      toolContext(PRIMARY_SESSION, "system"),
    ),
    `${planID} finalized`,
    "evidence membership is a content edit, so the plan is finalized again",
  );

  // plan_load is the compact read; it includes status/readiness and the body.
  const loaded = await execTool(
    tools,
    "plan_load",
    { artifactID: planID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(loaded, /^ARTIFACT_CONTENT\n/);
  assert.match(loaded, /Status: draft/);
  assert.match(loaded, /Finalized: true/);
  assert.match(loaded, /Kind: plan/);
  assert.match(loaded, /Title: Shared plan/);
  assert.match(loaded, /Author: System/);
  assert.match(loaded, /Evidence: art_[a-f0-9]{8}/);
  assert.match(loaded, /# Goal \/ Scope/, "the generated document is inline");
  assert.match(
    loaded,
    /- Supporting evidence artifact\. \(art_[a-f0-9]{8}\)/,
    "evidence snapshot renders beside the artifact ID",
  );
  assert.doesNotMatch(
    loaded,
    /Owner: ses_/,
    "full loaders never render session identities",
  );

  await store.approveArtifact({
    artifactID: planID,
    location: DIRECTORY,
    requestID: "req_approve-plan-0001",
  });
  const approved = await execTool(
    tools,
    "plan_load",
    { artifactID: planID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(approved, /Status: approved/);

  // A nonexistent ID is a clean not_found from a loader.
  const missing = await execTool(
    tools,
    "evidence_load",
    { artifactID: "art_00000000" },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(missing, /^ARTIFACT_ERROR/);
  assert.match(missing, /not_found/);
});

test("plan completion freezes the plan and a new plan can reference it", async (t) => {
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  const { tools } = await setupPlugin(t, { sessions });
  const ctx = toolContext(PRIMARY_SESSION, "system");

  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "First plan",
      description: "First plan.",
      workingDirectory: DIRECTORY,
      goalScope: "Goal.",
      intendedChanges: "Change.",
    },
    ctx,
  );
  await execTool(tools, "plan_finalize", { artifactID: planID }, ctx);
  const completed = await execTool(
    tools,
    "plan_complete",
    {
      artifactID: planID,
      summary: "Done.",
      changed: "One file.",
      verification: "Tests pass.",
      unfinished: "None.",
    },
    ctx,
  );
  assert.equal(completed, `${planID} completed`);

  const loaded = await execTool(
    tools,
    "plan_load",
    { artifactID: planID },
    ctx,
  );
  assert.match(loaded, /Completed: /);
  assert.match(loaded, /## Report/);
  assert.match(loaded, /### Verification/);
  assert.match(loaded, /Tests pass\./);

  // The completion record freezes all later content mutations.
  const frozen = await execTool(
    tools,
    "plan_update",
    { artifactID: planID, goalScope: "New goal." },
    ctx,
  );
  assert.match(frozen, /^ARTIFACT_ERROR\nforbidden:/);
  assert.match(frozen, /completed and frozen/);

  const twice = await execTool(
    tools,
    "plan_complete",
    { artifactID: planID, summary: "Again." },
    ctx,
  );
  assert.match(twice, /^ARTIFACT_ERROR/);
  assert.match(twice, /already completed/);

  // A follow-up plan can point at the completed plan without reopening it.
  const nextID = await execTool(
    tools,
    "plan_create",
    {
      title: "Second plan",
      description: "Follow-up plan.",
      workingDirectory: DIRECTORY,
      previousPlanID: planID,
      goalScope: "Next goal.",
      intendedChanges: "Next change.",
    },
    ctx,
  );
  const nextLoaded = await execTool(
    tools,
    "plan_load",
    { artifactID: nextID },
    ctx,
  );
  assert.match(nextLoaded, new RegExp(`Previous plan: ${planID}`));
});

// ---------------------------------------------------------------------------
// Evidence tools
// ---------------------------------------------------------------------------

test("evidence tools: writer-only mutation, resume access, overview/findings, summary-vs-load boundaries", async (t) => {
  const { store } = await makeStore(t);
  const sessions = {
    [PRIMARY_SESSION]: sessionInfo(),
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
    [OTHER_SESSION]: sessionInfo({
      id: OTHER_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
  };
  const deps = {
    store,
    directory: DIRECTORY,
    projectDirectory: DIRECTORY,
    getSession: async ({ sessionID }) => sessions[sessionID],
  };
  const namespaces = [];
  const tools = [];
  addArtifactTools(installEditor({ namespaces, tools }), deps);

  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.match(evidenceID, /^art_[a-f0-9]{8}$/);

  const overview = await execTool(
    tools,
    "evidence_update",
    {
      artifactID: evidenceID,
      question: "Which files?",
      summary: "Key summary.",
      limitations: "Limits.",
    },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.equal(
    overview,
    evidenceID,
    "overview_put returns the bare artifact ID",
  );

  // Appending a finding returns the bare generated finding ID — reusable directly.
  const findingID = await execTool(
    tools,
    "evidence_finding",
    { artifactID: evidenceID, title: "Exact paths", content: "store.mjs." },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.match(
    findingID,
    /^fin_[a-f0-9]{8}$/,
    "appending returns the bare finding ID",
  );

  const replaced = await execTool(
    tools,
    "evidence_finding",
    {
      artifactID: evidenceID,
      findingID,
      title: "Exact paths",
      content: "Three files.",
    },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.equal(
    replaced,
    findingID,
    "a supplied finding ID returns the same bare ID",
  );

  // Mutation is writer-only: a sibling Search session and the owner primary agent
  // are both rejected even though the owner matches the artifact owner.
  for (const sessionID of [OTHER_SESSION, PRIMARY_SESSION]) {
    const rejected = await execTool(
      tools,
      "evidence_update",
      { artifactID: evidenceID, summary: "x" },
      toolContext(
        sessionID,
        sessionID === PRIMARY_SESSION ? "system" : "search",
      ),
    );
    assert.match(rejected, /^ARTIFACT_ERROR/);
    assert.match(
      rejected,
      /forbidden: Content mutations are restricted to the writer session/,
    );
  }

  // Resuming the same writer session retains write access.
  const resumed = await execTool(
    tools,
    "evidence_update",
    { artifactID: evidenceID, limitations: "Revised limits." },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.equal(resumed, evidenceID);

  // Kind isolation: evidence tools reject plan IDs.
  const planInStore = await store.createArtifact({
    kind: "plan",
    ownerSessionID: PRIMARY_SESSION,
    writerSessionID: SEARCH_SESSION,
    primaryAuthor: "System",
    location: DIRECTORY,
    title: "Plan",
    description: "d",
    workingDirectory: DIRECTORY,
  });
  const wrongKind = await execTool(
    tools,
    "evidence_update",
    { artifactID: planInStore.artifactID, summary: "x" },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.match(wrongKind, /^ARTIFACT_ERROR/);
  assert.match(
    wrongKind,
    /invalid_kind/,
    "evidence_update is evidence-only",
  );

  const finalized = await execTool(
    tools,
    "evidence_finalize",
    { artifactID: evidenceID },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.equal(
    finalized,
    `${evidenceID} published`,
    "evidence finalize returns the bare contract",
  );

  // Full loader (primary agent/Review): content plus the author's finding IDs.
  const loaded = await execTool(
    tools,
    "evidence_load",
    { artifactID: evidenceID },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.match(loaded, /^ARTIFACT_CONTENT\n/);
  assert.match(
    loaded,
    new RegExp(`Findings: ${findingID}`),
    "finding IDs are listed for the author's follow-up edits",
  );
  assert.match(loaded, /# Evidence/);
  assert.match(loaded, /\*\*Question\.\*\* Which files\?/);
  const evidenceView = await store.getArtifact({
    artifactID: evidenceID,
    location: DIRECTORY,
  });
  assert.equal(
    evidenceView.status,
    "published",
    "evidence_load must not mark read",
  );

  // Primary summary reader: overview fields only, never findings.
  const summary = await execTool(
    tools,
    "evidence_summary",
    { artifactID: evidenceID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(summary, /^ARTIFACT_SUMMARY\n/);
  assert.match(summary, /Status: published/);
  assert.match(summary, /Question: Which files\?/);
  assert.match(summary, /Summary: Key summary\./);
  assert.match(summary, /Limitations: Revised limits\./);
  assert.doesNotMatch(
    summary,
    /Findings:/,
    "evidence_summary never returns detailed findings",
  );
  assert.doesNotMatch(
    summary,
    /store\.mjs|Three files/,
    "evidence_summary never inlines finding content",
  );

  // Removing by the bare finding ID works.
  const removed = await execTool(
    tools,
    "evidence_finding",
    { artifactID: evidenceID, findingID, remove: true },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.equal(
    removed,
    findingID,
    "evidence_finding remove returns the bare finding ID",
  );
  assert.match(
    await execTool(
      tools,
      "evidence_summary",
      { artifactID: evidenceID },
      toolContext(PRIMARY_SESSION, "system"),
    ),
    /Status: draft/,
    "a finding mutation returns evidence to draft",
  );
});

// ---------------------------------------------------------------------------
// Review tools
// ---------------------------------------------------------------------------

test("review tools: outcome, summary, findings, finalize, load, summary; kinds stay isolated", async (t) => {
  const { store } = await makeStore(t);
  const sessions = {
    [PRIMARY_SESSION]: sessionInfo(),
    [REVIEW_SESSION]: sessionInfo({
      id: REVIEW_SESSION,
      agent: "review",
      parentID: PRIMARY_SESSION,
    }),
  };
  const deps = {
    store,
    directory: DIRECTORY,
    projectDirectory: DIRECTORY,
    getSession: async ({ sessionID }) => sessions[sessionID],
  };
  const namespaces = [];
  const tools = [];
  addArtifactTools(installEditor({ namespaces, tools }), deps);

  const reviewID = await execTool(
    tools,
    "review_create",
    { title: "Review result", description: "Review artifact." },
    toolContext(REVIEW_SESSION, "review"),
  );
  assert.match(reviewID, /^art_[a-f0-9]{8}$/);

  const outcome = await execTool(
    tools,
    "review_update",
    { artifactID: reviewID, outcome: "Changes required" },
    toolContext(REVIEW_SESSION, "review"),
  );
  assert.equal(outcome, reviewID, "review update returns the bare artifact ID");
  const summary = await execTool(
    tools,
    "review_update",
    { artifactID: reviewID, summary: "One medium finding; no blockers." },
    toolContext(REVIEW_SESSION, "review"),
  );
  assert.equal(summary, reviewID, "review update sets the summary in place");

  const findingID = await execTool(
    tools,
    "review_finding",
    {
      artifactID: reviewID,
      title: "Scope leak",
      severity: "high",
      affected: "store.mjs",
      correction: "Constrain removal.",
    },
    toolContext(REVIEW_SESSION, "review"),
  );
  assert.match(findingID, /^fin_[a-f0-9]{8}$/);

  const replaced = await execTool(
    tools,
    "review_finding",
    {
      artifactID: reviewID,
      findingID,
      title: "Scope leak (revised)",
      severity: "medium",
      correction: "Same correction.",
    },
    toolContext(REVIEW_SESSION, "review"),
  );
  assert.equal(
    replaced,
    findingID,
    "a supplied finding ID returns the same bare ID",
  );

  const finalized = await execTool(
    tools,
    "review_finalize",
    { artifactID: reviewID },
    toolContext(REVIEW_SESSION, "review"),
  );
  assert.equal(
    finalized,
    `${reviewID} published`,
    "review finalize returns the bare contract",
  );

  // Full review load: full content, outcome, finding IDs.
  const loaded = await execTool(
    tools,
    "review_load",
    { artifactID: reviewID },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.match(loaded, /^ARTIFACT_CONTENT\n/);
  assert.match(loaded, /Outcome: Changes required/);
  assert.match(loaded, new RegExp(`Findings: ${findingID}`));
  assert.match(loaded, /# Review/);
  assert.match(loaded, /## Outcome/);
  assert.match(loaded, /## Summary/);
  assert.match(loaded, /- Severity: medium/);
  assert.match(loaded, /- Correction: Same correction\./);

  // Primary summary reader: outcome/summary only, never findings.
  const reviewSummary = await execTool(
    tools,
    "review_summary",
    { artifactID: reviewID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(reviewSummary, /^ARTIFACT_SUMMARY\n/);
  assert.match(reviewSummary, /Outcome: Changes required/);
  assert.match(reviewSummary, /Summary: One medium finding; no blockers\./);
  assert.doesNotMatch(
    reviewSummary,
    /Findings:/,
    "review_summary never returns detailed findings",
  );
  assert.doesNotMatch(
    reviewSummary,
    /Scope leak/,
    "review_summary never inlines finding content",
  );

  const wrongKind = await execTool(
    tools,
    "review_summary",
    { artifactID: "art_00000000" },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(wrongKind, /^ARTIFACT_ERROR/);
  assert.match(wrongKind, /not_found/);
});

// ---------------------------------------------------------------------------
// Loaders resolve no session
// ---------------------------------------------------------------------------

test("read tools resolve no session: loaders work when getSession is unavailable", async (t) => {
  const { store } = await makeStore(t);
  const evidence = await store.createArtifact({
    kind: "evidence",
    ownerSessionID: PRIMARY_SESSION,
    writerSessionID: SEARCH_SESSION,
    primaryAuthor: "Search",
    location: DIRECTORY,
    title: "Note",
    description: "d",
  });
  await store.evidenceOverviewPut({
    artifactID: evidence.artifactID,
    location: DIRECTORY,
    writerSessionID: SEARCH_SESSION,
    summary: "A",
  });

  const deps = {
    store,
    directory: DIRECTORY,
    projectDirectory: DIRECTORY,
    getSession: async () => {
      throw new Error("boom");
    },
  };
  const namespaces = [];
  const tools = [];
  addArtifactTools(installEditor({ namespaces, tools }), deps);
  const loaded = await execTool(
    tools,
    "evidence_load",
    { artifactID: evidence.artifactID },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.match(loaded, /^ARTIFACT_CONTENT/);
});

// ---------------------------------------------------------------------------
// Plugin registration wiring (mocked ctx: nothing is sent anywhere)
// ---------------------------------------------------------------------------

async function setupPlugin(
  t,
  { sessions = {}, syntheticThrowFor = [], agents = {} } = {},
) {
  await makeTempStateRoot(t);
  const tools = [];
  const contracts = [];
  const namespaces = [];
  const syntheticCalls = [];
  const hooks = [];
  const ctx = {
    location: { directory: DIRECTORY },
    agent: {
      get: async ({ agentID }) => {
        if (!(agentID in agents)) throw new Error(`unknown agent ${agentID}`);
        return agents[agentID];
      },
    },
    session: {
      get: async ({ sessionID }) => {
        if (!(sessionID in sessions))
          throw new Error(`unknown session ${sessionID}`);
        return sessions[sessionID];
      },
      synthetic: async (input) => {
        if (syntheticThrowFor.includes(input.sessionID)) {
          throw new Error(`unavailable session ${input.sessionID}`);
        }
        syntheticCalls.push(input);
        return { id: "msg_mocked" };
      },
      hook: async (name, callback) => {
        hooks.push({ name, callback });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (fn) => {
        fn({
          namespace: (namespace) => namespaces.push(namespace),
          add: (tool) => tools.push(tool),
        });
      },
    },
    rpc: {
      register: async (contract, handlers) => {
        contracts.push({ contract, handlers });
      },
    },
  };
  await plugin.setup(ctx);
  // The RPC adapter is a separate plugin; the editor-facing half registers the
  // same domain through the bridge.
  await rpcPlugin.setup(ctx);
  return { tools, contracts, namespaces, syntheticCalls, sessions, hooks };
}

test("RPC surface exposes frontend metadata only, strips the writer session, and delivers compact queued owner feedback/approvals", async (t) => {
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  const { contracts, tools, namespaces, syntheticCalls } = await setupPlugin(
    t,
    { sessions },
  );
  const rpc = contracts.find(
    (entry) => entry.contract.id === "personal.artifacts",
  ).handlers;
  assert.deepEqual(namespaces.map((namespace) => namespace.name).sort(), [
    "artifact",
    "evidence",
    "plan",
    "review",
  ]);

  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "Shared plan",
      description: "A shared plan artifact.",
      workingDirectory: DIRECTORY,
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  const list = await rpc.list(
    {},
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(list.artifacts.length, 1);
  const artifact = list.artifacts[0];
  assert.equal(artifact.finalized, false, "list carries readiness");
  assert.equal(
    artifact.primaryAuthor,
    "System",
    "list carries the frontend primary author",
  );
  assert.equal(
    artifact.writerSessionID,
    undefined,
    "the writer session identity stays internal",
  );
  assert.equal(
    artifact.ownerSessionID,
    PRIMARY_SESSION,
    "the owner session id stays on the wire for feedback routing",
  );
  assert.equal(artifact.revision, undefined);
  assert.equal(artifact.authorSessionID, undefined);

  await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      goalScope: "- Goal.",
      intendedChanges: "- Change.",
      checks: "Run tests.",
    },
    toolContext(PRIMARY_SESSION, "system"),
  );

  // Explicit owner recipient: synthetic queued message to the owner session.
  const feedback = await rpc.feedback(
    {
      artifactID: planID,
      requestID: "req_feedback-mocked-1",
      question: "Is this complete?",
      selectedText: "- Goal.",
      recipient: "owner",
    },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(feedback.requestID, "req_feedback-mocked-1");
  assert.equal(feedback.kind, "feedback");
  assert.equal(feedback.delivery.state, "delivered");
  assert.equal(syntheticCalls.length, 1);
  const call = syntheticCalls[0];
  assert.equal(
    call.sessionID,
    PRIMARY_SESSION,
    "owner feedback targets the owning primary session",
  );
  assert.equal(call.delivery, "queue");
  assert.equal(call.resume, true);
  assert.equal(call.description, "Feedback: Shared plan");
  assert.equal(call.metadata.recipient, "owner");
  assert.equal(call.metadata.artifactID, planID);
  assert.match(call.text, /User question: Is this complete\?/);

  const duplicate = await rpc.feedback(
    {
      artifactID: planID,
      requestID: "req_feedback-mocked-1",
      question: "Again?",
    },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(duplicate.deduplicated, true);
  assert.equal(syntheticCalls.length, 1);

  // Non-finalized plans cannot be approved: not_ready, no delivery.
  await assert.rejects(
    rpc.approve_plan(
      { artifactID: planID, requestID: "req_approve-mocked-1" },
      {
        error: (code, message, data) => {
          throw new StoreError(code, message, data);
        },
      },
    ),
    (error) => error.code === "not_ready",
  );
  assert.equal(syntheticCalls.length, 1);

  await execTool(
    tools,
    "plan_finalize",
    { artifactID: planID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  const approved = await rpc.approve_plan(
    { artifactID: planID, requestID: "req_approve-mocked-1" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(approved.kind, "approval");
  assert.equal(approved.delivery.state, "delivered");
  assert.equal(approved.artifact.status, "approved");
  assert.equal(approved.artifact.finalized, true);
  assert.equal(
    approved.artifact.writerSessionID,
    undefined,
    "approve output strips the writer identity too",
  );
  assert.equal(syntheticCalls.length, 2);
  const approvalCall = syntheticCalls[1];
  assert.equal(approvalCall.description, "Approval: Shared plan");
  assert.equal(
    approvalCall.text,
    `approval delivered: ${planID} (kind=plan status=approved finalized=true)`,
    "the approval payload carries the frozen fields the primary agent needs for review",
  );
  assert.equal(approvalCall.metadata.recipient, "owner");

  const again = await rpc.approve_plan(
    { artifactID: planID, requestID: "req_approve-mocked-2" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(again.deduplicated, true);
  assert.equal(again.requestID, "req_approve-mocked-1");
  assert.equal(syntheticCalls.length, 2);

  const retried = await rpc.retry_plan_delivery(
    { artifactID: planID, requestID: "req_approve-mocked-1" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(retried.requestID, "req_approve-mocked-1");
  assert.equal(
    retried.deduplicated,
    true,
    "already-delivered submissions are not re-sent",
  );
  assert.equal(retried.kind, "approval");

  // Feedback is NOT retryable under the plan-only contract.
  await assert.rejects(
    rpc.retry_plan_delivery(
      { artifactID: planID, requestID: "req_feedback-mocked-1" },
      {
        error: (code, message, data) => {
          throw new StoreError(code, message, data);
        },
      },
    ),
    (error) => error.code === "not_found",
  );
  await assert.rejects(
    rpc.retry_plan_delivery(
      { artifactID: planID, requestID: "req_unknown-mocked-1" },
      {
        error: (code, message, data) => {
          throw new StoreError(code, message, data);
        },
      },
    ),
    (error) => error.code === "not_found",
  );
});

test("retried plan-approval delivery re-emits the same authoritative approval payload", async (t) => {
  await makeTempStateRoot(t);
  const tools = [];
  const contracts = [];
  const syntheticCalls = [];
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  let admit = false;
  const ctx = {
    location: { directory: DIRECTORY },
    session: {
      get: async ({ sessionID }) => sessions[sessionID],
      synthetic: async (input) => {
        if (!admit) {
          admit = true;
          throw new Error("unavailable session");
        }
        syntheticCalls.push(input);
        return { id: "msg_mocked" };
      },
    },
    tool: {
      transform: async (fn) => {
        fn({ namespace: () => {}, add: (tool) => tools.push(tool) });
      },
    },
    rpc: {
      register: async (contract, handlers) => {
        contracts.push({ contract, handlers });
      },
    },
  };
  await plugin.setup(ctx);
  await rpcPlugin.setup(ctx);
  const rpc = contracts.find(
    (entry) => entry.contract.id === "personal.artifacts",
  ).handlers;

  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "Shared plan",
      description: "A shared plan artifact.",
      workingDirectory: DIRECTORY,
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      goalScope: "- Goal.",
      intendedChanges: "- Change.",
      checks: "Run tests.",
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await execTool(
    tools,
    "plan_finalize",
    { artifactID: planID },
    toolContext(PRIMARY_SESSION, "system"),
  );

  // The first admission fails, so the approval is recorded but undelivered.
  const approved = await rpc.approve_plan(
    { artifactID: planID, requestID: "req_approve-retry-1" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(approved.delivery.state, "failed");
  assert.equal(
    syntheticCalls.length,
    0,
    "nothing was admitted on the failed attempt",
  );

  // Retry re-emits the same current authoritative payload from the frozen record.
  const retried = await rpc.retry_plan_delivery(
    { artifactID: planID, requestID: "req_approve-retry-1" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(retried.delivery.state, "delivered");
  assert.equal(retried.deduplicated, false);
  assert.equal(syntheticCalls.length, 1);
  assert.equal(
    syntheticCalls[0].text,
    `approval delivered: ${planID} (kind=plan status=approved finalized=true)`,
    "retry re-emits the same deterministic authoritative payload",
  );
});

test("writer feedback routes to the stored writer session; approval stays plan-only", async (t) => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
    [PRIMARY_SESSION]: sessionInfo(),
  };
  const { contracts, tools, syntheticCalls } = await setupPlugin(t, {
    sessions,
  });
  const rpc = contracts.find(
    (entry) => entry.contract.id === "personal.artifacts",
  ).handlers;

  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "evidence_update",
    { artifactID: evidenceID, summary: "# Note\n" },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "evidence_finalize",
    { artifactID: evidenceID },
    toolContext(SEARCH_SESSION, "search"),
  );

  // recipient "writer" targets the stored writer identity (the Search session),
  // not the owner primary agent.
  const feedback = await rpc.feedback(
    {
      artifactID: evidenceID,
      requestID: "req_writer-fb-1",
      question: "Direct?",
      recipient: "writer",
    },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(feedback.delivery.state, "delivered");
  assert.equal(syntheticCalls.length, 1);
  assert.equal(
    syntheticCalls[0].sessionID,
    SEARCH_SESSION,
    "writer feedback targets the stored writer session",
  );
  assert.equal(syntheticCalls[0].metadata.recipient, "writer");
  assert.equal(syntheticCalls[0].metadata.requestID, "req_writer-fb-1");

  // mark_read: status read, kind read, and NO synthetic message is emitted.
  const read = await rpc.mark_read(
    { artifactID: evidenceID, requestID: "req_read-evidence-1" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(read.kind, "read");
  assert.equal(read.deduplicated, false);
  assert.equal(read.delivery, undefined, "mark_read response has no delivery");
  assert.equal(read.artifact.status, "read");
  assert.equal(syntheticCalls.length, 1, "mark_read never notifies");

  // Approving evidence is a wrong-kind error.
  await assert.rejects(
    rpc.approve_plan(
      { artifactID: evidenceID, requestID: "req_approve-evidence-1" },
      {
        error: (code, message, data) => {
          throw new StoreError(code, message, data);
        },
      },
    ),
    (error) => error.code === "invalid_kind",
  );
  await assert.rejects(
    rpc.retry_plan_delivery(
      { artifactID: evidenceID, requestID: "req_read-evidence-1" },
      {
        error: (code, message, data) => {
          throw new StoreError(code, message, data);
        },
      },
    ),
    (error) => error.code === "invalid_kind",
  );

});

test("unavailable writer delivery fails visibly and stays recorded; it is never rerouted", async (t) => {
  const sessions = {
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
    [PRIMARY_SESSION]: sessionInfo(),
  };
  const { contracts, tools, syntheticCalls } = await setupPlugin(t, {
    sessions,
    syntheticThrowFor: [SEARCH_SESSION],
  });
  const rpc = contracts.find(
    (entry) => entry.contract.id === "personal.artifacts",
  ).handlers;

  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "evidence_update",
    { artifactID: evidenceID, summary: "# Note\n" },
    toolContext(SEARCH_SESSION, "search"),
  );

  // The completed writer session cannot be reached: the decision is recorded
  // with state failed, never silently rerouted to the owner.
  const feedback = await rpc.feedback(
    {
      artifactID: evidenceID,
      requestID: "req_writer-fail-1",
      question: "Direct?",
      recipient: "writer",
    },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(feedback.delivery.state, "failed");
  assert.match(feedback.delivery.error, /unavailable session/);
  assert.equal(
    syntheticCalls.length,
    0,
    "the attempt never admitted a message",
  );

  const view = await rpc.get(
    { artifactID: evidenceID },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  const recorded = view.artifact.feedback.find(
    (entry) => entry.requestID === "req_writer-fail-1",
  );
  assert.ok(recorded, "the decision is recorded durably");
  assert.equal(recorded.recipient, "writer");
  assert.equal(recorded.delivery.state, "failed");
});

test("plan approval is a review marker; edits return to draft; evidence edits after mark-read return to the visible draft", async (t) => {
  const sessions = {
    [PRIMARY_SESSION]: sessionInfo(),
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
  };
  const { contracts, tools } = await setupPlugin(t, { sessions });
  const rpc = contracts.find(
    (entry) => entry.contract.id === "personal.artifacts",
  ).handlers;

  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "Shared plan",
      description: "A shared plan artifact.",
      workingDirectory: DIRECTORY,
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      goalScope: "- Goal.",
      intendedChanges: "- Change.",
      checks: "Run tests.",
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await execTool(
    tools,
    "plan_finalize",
    { artifactID: planID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await rpc.approve_plan(
    { artifactID: planID, requestID: "req_approve-plan-1" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );

  // Approval no longer freezes the plan. A later edit is allowed and returns
  // the plan to draft so the user can review the new version.
  const editedPlan = await execTool(
    tools,
    "plan_update",
    { artifactID: planID, goalScope: "Late edit." },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.equal(editedPlan, planID);
  const planView = await rpc.get(
    { artifactID: planID },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(planView.artifact.status, "draft");
  assert.equal(planView.artifact.finalized, false);
  assert.equal(
    planView.artifact.approval,
    null,
    "editing a reviewed plan clears the review marker",
  );

  // Evidence mark-read -> overview edit returns to the visible draft and must be
  // finalized again before the editor can mark it read.
  const evidenceID = await execTool(
    tools,
    "evidence_create",
    { title: "Search note", description: "Evidence artifact." },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "evidence_update",
    { artifactID: evidenceID, summary: "# Note\n" },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "evidence_finalize",
    { artifactID: evidenceID },
    toolContext(SEARCH_SESSION, "search"),
  );
  await rpc.mark_read(
    { artifactID: evidenceID, requestID: "req_read-evidence-2" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );

  const edited = await execTool(
    tools,
    "evidence_update",
    { artifactID: evidenceID, summary: "Revised." },
    toolContext(SEARCH_SESSION, "search"),
  );
  assert.equal(edited, evidenceID);
  const listed = await rpc.list(
    {},
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(listed.artifacts.length, 2);
  assert.ok(
    listed.artifacts.every((entry) => entry.content === undefined),
    "list reads do not fetch content",
  );
  const evidenceView = await rpc.get(
    { artifactID: evidenceID },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(evidenceView.artifact.status, "draft");
  assert.equal(evidenceView.artifact.finalized, false);
  assert.equal(
    evidenceView.artifact.readAt,
    undefined,
    "the read marker is not part of the RPC view",
  );
  assert.equal(
    evidenceView.artifact.writerSessionID,
    undefined,
    "get output strips the writer identity",
  );
});

test("create and finalize accept initial content so a draft can be filled incrementally", async (t) => {
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  const { tools } = await setupPlugin(t, { sessions });
  const ctx = toolContext(PRIMARY_SESSION, "system");

  const evidenceID = await execTool(
    tools,
    "evidence_create",
    {
      title: "Combined evidence",
      description: "One-call overview.",
      question: "What changed?",
      summary: "Initial summary.",
    },
    ctx,
  );
  assert.match(evidenceID, /^art_[a-f0-9]{8}$/);
  const evidenceLoaded = await execTool(
    tools,
    "evidence_load",
    { artifactID: evidenceID },
    ctx,
  );
  assert.match(evidenceLoaded, /\*\*Question\.\*\* What changed\?/);
  assert.match(evidenceLoaded, /Initial summary\./);
  const evidenceFinal = await execTool(
    tools,
    "evidence_finalize",
    {
      artifactID: evidenceID,
      summary: "Final summary.",
      limitations: "One limitation.",
    },
    ctx,
  );
  assert.equal(evidenceFinal, `${evidenceID} published`);

  const reviewID = await execTool(
    tools,
    "review_create",
    {
      title: "Combined review",
      description: "One-call review.",
      outcome: "Pass",
      summary: "Initial review.",
    },
    ctx,
  );
  const reviewFinal = await execTool(
    tools,
    "review_finalize",
    {
      artifactID: reviewID,
      outcome: "Changes required",
      summary: "Final review.",
    },
    ctx,
  );
  assert.equal(reviewFinal, `${reviewID} published`);
  const reviewLoaded = await execTool(
    tools,
    "review_load",
    { artifactID: reviewID },
    ctx,
  );
  assert.match(reviewLoaded, /Changes required/);
  assert.match(reviewLoaded, /Final review\./);

  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "Patch plan",
      description: "Patch semantics.",
      workingDirectory: DIRECTORY,
    },
    ctx,
  );
  await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      intendedChanges: "One.\nTwo.",
    },
    ctx,
  );
  await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      patch: {
        field: "intendedChanges",
        oldText: "Two.",
        newText: "Three.",
      },
    },
    ctx,
  );
  const planLoaded = await execTool(
    tools,
    "plan_load",
    { artifactID: planID },
    ctx,
  );
  assert.match(planLoaded, /One\. Three\./);
});

test("artifact search covers the project, not another location", async (t) => {
  const { store } = await makeStore(t);
  const PROJECT = "/tmp/opencode/search-project";
  const WORKTREE = "/tmp/opencode/search-worktree";
  const OTHER = "/tmp/opencode/search-other";

  const evidence = await store.createArtifact({
    kind: "evidence",
    ownerSessionID: PRIMARY_SESSION,
    writerSessionID: PRIMARY_SESSION,
    primaryAuthor: "Search",
    location: PROJECT,
    title: "Project evidence",
    description: "Shared by worktrees.",
  });
  await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: PROJECT,
    writerSessionID: PRIMARY_SESSION,
    title: "Project finding",
    content: "project needle phrase.",
  });
  const otherEvidence = await store.createArtifact({
    kind: "evidence",
    ownerSessionID: PRIMARY_SESSION,
    writerSessionID: PRIMARY_SESSION,
    primaryAuthor: "Search",
    location: OTHER,
    title: "Other evidence",
    description: "Another location.",
  });
  await store.evidenceFindingPut({
    artifactID: otherEvidence.artifactID,
    location: OTHER,
    writerSessionID: PRIMARY_SESSION,
    title: "Other finding",
    content: "project needle phrase.",
  });

  const tools = [];
  addArtifactTools(installEditor({ tools }), {
    store,
    directory: WORKTREE,
    projectDirectory: PROJECT,
    getSession: async () => {
      throw new Error("search does not resolve sessions");
    },
  });
  const output = await execTool(
    tools,
    "artifact_search",
    { query: "needle phrase" },
    toolContext(PRIMARY_SESSION, "system"),
  );

  assert.match(output, new RegExp(evidence.artifactID), "project evidence is found");
  assert.doesNotMatch(
    output,
    new RegExp(otherEvidence.artifactID),
    "artifacts in another location are not returned",
  );
});

test("artifacts created in one worktree load and search from another worktree", async (t) => {
  const { store } = await makeStore(t);
  const PROJECT = "/tmp/opencode/worktree-project";
  const WORKTREE_A = "/tmp/opencode/worktree-project/a";
  const WORKTREE_B = "/tmp/opencode/worktree-project/b";
  const SESSION_B = "ses_worktreeb0000000000000";
  const sessions = {
    [PRIMARY_SESSION]: sessionInfo({
      location: { directory: WORKTREE_A },
    }),
    [SESSION_B]: sessionInfo({
      id: SESSION_B,
      location: { directory: WORKTREE_B },
    }),
  };
  const depsFor = (directory) => ({
    store,
    directory,
    projectDirectory: PROJECT,
    getSession: async ({ sessionID }) => sessions[sessionID],
  });

  const toolsA = [];
  addArtifactTools(installEditor({ tools: toolsA }), depsFor(WORKTREE_A));
  const planID = await execTool(
    toolsA,
    "plan_create",
    {
      title: "Cross-worktree plan",
      description: "Authored in A.",
      workingDirectory: WORKTREE_A,
      goalScope: "Share one artifact scope.",
      context: "worktree needle phrase.",
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(planID, /^art_[a-f0-9]{8}$/);

  const toolsB = [];
  addArtifactTools(installEditor({ tools: toolsB }), depsFor(WORKTREE_B));
  const loadedFromB = await execTool(
    toolsB,
    "plan_load",
    { artifactID: planID },
    toolContext(SESSION_B, "system"),
  );
  assert.match(loadedFromB, /Share one artifact scope\./);

  const searchFromB = await execTool(
    toolsB,
    "artifact_search",
    { query: "worktree needle phrase" },
    toolContext(SESSION_B, "system"),
  );
  assert.match(searchFromB, new RegExp(planID), "search spans the project");

  await execTool(
    toolsA,
    "plan_update",
    { artifactID: planID, checks: "Run the tests in A." },
    toolContext(PRIMARY_SESSION, "system"),
  );
  const reloadedFromB = await execTool(
    toolsB,
    "plan_load",
    { artifactID: planID },
    toolContext(SESSION_B, "system"),
  );
  assert.match(reloadedFromB, /Run the tests in A\./);
});
