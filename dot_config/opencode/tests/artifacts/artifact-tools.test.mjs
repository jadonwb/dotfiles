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
  "memory_init",
  "memory_load",
  "memory_update",
  "plan_create",
  "plan_finalize",
  "plan_load",
  "plan_update",
  "report_create",
  "report_finalize",
  "report_load",
  "report_summary",
  "report_update",
  "review_create",
  "review_finalize",
  "review_finding",
  "review_load",
  "review_summary",
  "review_update",
];
// Names that must never appear in the registered tool set (asserted below).
const UNREGISTERED_NAMES = [
  "memory_open",
  "memory_put",
  "memory_append",
  "memory_patch",
  "memory_summary",
  "plan_field_set",
  "plan_field_patch",
  "plan_evidence_add",
  "plan_evidence_remove",
  "plan_status",
  "evidence_overview_put",
  "evidence_finding_put",
  "evidence_finding_remove",
  "review_outcome_put",
  "review_summary_put",
  "review_finding_put",
  "review_finding_remove",
  "report_content_put",
  "report_content_remove",
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

test("registration declares plan/evidence/review/report namespaces and the exact effective tool names", async (t) => {
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
    ["artifact", "evidence", "memory", "plan", "report", "review"],
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
  for (const removed of UNREGISTERED_NAMES) {
    assert.equal(
      tools.some((tool) => tool.options.permission === removed),
      false,
      `${removed} is never registered`,
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
    "evidence_overview_put is evidence-only",
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
    { title: "Review report", description: "Review artifact." },
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
// Report tools
// ---------------------------------------------------------------------------

async function toolsWithApprovedPlan(t, contextOverrides = {}) {
  const { store } = await makeStore(t);
  const sessions = {
    [PRIMARY_SESSION]: sessionInfo(),
    [WORKER_SESSION]: sessionInfo({
      id: WORKER_SESSION,
      agent: "worker",
      parentID: PRIMARY_SESSION,
    }),
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
    [REVIEW_SESSION]: sessionInfo({
      id: REVIEW_SESSION,
      agent: "review",
      parentID: PRIMARY_SESSION,
    }),
    ...contextOverrides,
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

  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "Linked plan",
      description: "A linked plan artifact.",
      workingDirectory: DIRECTORY,
      goalScope: "Goal.",
      intendedChanges: "Change.",
      checks: "Check.",
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await execTool(
    tools,
    "plan_finalize",
    { artifactID: planID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await store.approveArtifact({
    artifactID: planID,
    location: DIRECTORY,
    requestID: "req_approve-report-plan",
  });
  return { store, tools, planID, sessions, deps };
}

test("report tools: create links a draft or reviewed plan, content sections, finalize, load, summary", async (t) => {
  const { store, tools, planID } = await toolsWithApprovedPlan(t);

  // A draft plan may back a report: reports record work, not an approval gate.
  const draftPlan = await execTool(
    tools,
    "plan_create",
    {
      title: "Draft plan",
      description: "Not approved yet.",
      workingDirectory: DIRECTORY,
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  const draftReport = await execTool(
    tools,
    "report_create",
    { planArtifactID: draftPlan },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.match(
    draftReport,
    /^art_[a-f0-9]{8}$/,
    "report_create accepts a draft plan",
  );

  const reportID = await execTool(
    tools,
    "report_create",
    { planArtifactID: planID },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.match(
    reportID,
    /^art_[a-f0-9]{8}$/,
    "report_create returns the bare artifact ID",
  );

  await execTool(
    tools,
    "report_update",
    {
      artifactID: reportID,
      changed: "store.mjs: flat plan model.",
    },
    toolContext(WORKER_SESSION, "worker"),
  );
  await execTool(
    tools,
    "report_update",
    {
      artifactID: reportID,
      checks: "store.test.mjs: pass.",
    },
    toolContext(WORKER_SESSION, "worker"),
  );
  const unfinished = await execTool(
    tools,
    "report_update",
    {
      artifactID: reportID,
      unfinished: "Cutover deferred.",
    },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.equal(unfinished, reportID);

  const removed = await execTool(
    tools,
    "report_update",
    { artifactID: reportID, unfinished: "" },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.equal(
    removed,
    reportID,
    "report_update with an empty section returns the bare artifact ID",
  );

  const badSection = await execTool(
    tools,
    "report_update",
    { artifactID: reportID },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.match(badSection, /^ARTIFACT_ERROR/);
  assert.match(badSection, /validation/);

  // Non-writer primary agent cannot mutate the worker's report.
  const forbidden = await execTool(
    tools,
    "report_update",
    { artifactID: reportID, summary: "x" },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(forbidden, /^ARTIFACT_ERROR/);
  assert.match(forbidden, /forbidden/);

  // Finalization requires the Summary; the report has only Changed/Checks so far.
  const failed = await execTool(
    tools,
    "report_finalize",
    { artifactID: reportID },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.match(failed, /^ARTIFACT_ERROR/);
  assert.match(failed, /validation/);

  const summaryResult = await execTool(
    tools,
    "report_update",
    { artifactID: reportID, summary: "Implemented." },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.equal(
    summaryResult,
    reportID,
    "report_update returns the bare artifact ID",
  );
  await execTool(
    tools,
    "report_update",
    { artifactID: reportID, unfinished: "Cutover deferred." },
    toolContext(WORKER_SESSION, "worker"),
  );
  const finalized = await execTool(
    tools,
    "report_finalize",
    { artifactID: reportID },
    toolContext(WORKER_SESSION, "worker"),
  );
  assert.equal(
    finalized,
    `${reportID} published`,
    "report finalize returns the bare contract",
  );

  // Review load: full content including Changed/Checks/Unfinished and the linked plan.
  const loaded = await execTool(
    tools,
    "report_load",
    { artifactID: reportID },
    toolContext(REVIEW_SESSION, "review"),
  );
  assert.match(loaded, /^ARTIFACT_CONTENT\n/);
  assert.match(
    loaded,
    new RegExp(`Plan: ${planID}`),
    "report_load lists the linked plan artifact ID",
  );
  assert.match(loaded, /# Report/);
  assert.match(loaded, /## Summary/);
  assert.match(loaded, /## Changed/);
  assert.match(loaded, /store\.mjs: flat plan model\./);
  assert.match(loaded, /## Checks/);
  assert.match(loaded, /## Unfinished/);
  assert.match(loaded, /Cutover deferred\./);

  // Primary summary: metadata, linked plan, Summary only — no Changed/Checks/Unfinished.
  const summary = await execTool(
    tools,
    "report_summary",
    { artifactID: reportID },
    toolContext(PRIMARY_SESSION, "system"),
  );
  assert.match(summary, /^ARTIFACT_SUMMARY\n/);
  assert.match(summary, /Status: published/);
  assert.match(summary, new RegExp(`Plan: ${planID}`));
  assert.match(summary, /Summary: Implemented\./);
  assert.doesNotMatch(
    summary,
    /store\.mjs|store\.test\.mjs|Cutover/,
    "report_summary hides Changed/Checks/Unfinished detail",
  );

  // Reports are non-plan: mark-read RPC dismissal works via store directly.
  const read = await store.markArtifactRead({
    artifactID: reportID,
    location: DIRECTORY,
    requestID: "req_read-report-0001",
  });
  assert.equal(read.artifact.status, "read");
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
    "memory",
    "plan",
    "report",
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
    "the writer session identity never leaves the wire contract",
  );
  assert.equal(
    artifact.ownerSessionID,
    PRIMARY_SESSION,
    "owner-scoping metadata stays for attached-session filtering",
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

test("writer feedback routes to the stored writer session; reports list/mark-read; approval stays plan-only", async (t) => {
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

  // Reports flow through list/get/mark_read as non-plan artifacts.
  const planID = await execTool(
    tools,
    "plan_create",
    {
      title: "Link me",
      description: "Plan description.",
      workingDirectory: DIRECTORY,
    },
    toolContext(PRIMARY_SESSION, "system"),
  );
  await execTool(
    tools,
    "plan_update",
    {
      artifactID: planID,
      goalScope: "G.",
      intendedChanges: "I.",
      checks: "C.",
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
    { artifactID: planID, requestID: "req_approve-plan-2" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );

  const reportID = await execTool(
    tools,
    "report_create",
    { planArtifactID: planID },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "report_update",
    { artifactID: reportID, summary: "Done." },
    toolContext(SEARCH_SESSION, "search"),
  );
  await execTool(
    tools,
    "report_finalize",
    { artifactID: reportID },
    toolContext(SEARCH_SESSION, "search"),
  );

  const list2 = await rpc.list(
    {},
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  const reportSummary = list2.artifacts.find((entry) => entry.id === reportID);
  assert.ok(reportSummary, "reports appear in list");
  assert.equal(reportSummary.kind, "report");
  assert.equal(reportSummary.primaryAuthor, "Search");
  assert.equal(
    reportSummary.ownerSessionID,
    PRIMARY_SESSION,
    "report owner resolves to the primary-agent ancestry",
  );

  const reportGet = await rpc.get(
    { artifactID: reportID },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(reportGet.artifact.kind, "report");
  assert.equal(
    reportGet.artifact.writerSessionID,
    undefined,
    "get strips the report writer identity",
  );
  assert.equal(reportGet.artifact.status, "published");

  const reportRead = await rpc.mark_read(
    { artifactID: reportID, requestID: "req_read-report-1" },
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  assert.equal(
    reportRead.artifact.status,
    "read",
    "reports dismiss with mark_read",
  );
  assert.equal(
    syntheticCalls.length,
    2,
    "report mark_read never notifies (feedback + plan approval are the only deliveries)",
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

test("memory tools: init is idempotent, update append/patch are incremental, load resolves the session", async (t) => {
  const sessions = {
    [PRIMARY_SESSION]: sessionInfo(),
    [SEARCH_SESSION]: sessionInfo({
      id: SEARCH_SESSION,
      agent: "search",
      parentID: PRIMARY_SESSION,
    }),
  };
  const { tools, contracts } = await setupPlugin(t, { sessions });
  const rpc = contracts.find(
    (entry) => entry.contract.id === "personal.artifacts",
  ).handlers;
  const ctx = toolContext(PRIMARY_SESSION, "system");

  const memoryID = await execTool(tools, "memory_init", {}, ctx);
  assert.match(
    memoryID,
    /^art_[a-f0-9]{8}$/,
    "memory_init returns the bare artifact ID",
  );
  assert.equal(
    await execTool(tools, "memory_init", {}, ctx),
    memoryID,
    "memory_init is idempotent for the project",
  );

  await execTool(
    tools,
    "memory_update",
    {
      artifactID: memoryID,
      mode: "append",
      content: "## Objective\n\nShip the refactor.",
    },
    ctx,
  );
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: memoryID,
      mode: "append",
      content: "## Work State\n\nTesting.",
    },
    ctx,
  );
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: memoryID,
      mode: "patch",
      oldText: "Testing.",
      newText: "Testing and documenting.",
    },
    ctx,
  );

  const loaded = await execTool(tools, "memory_load", {}, ctx);
  assert.match(loaded, /^ARTIFACT_CONTENT/);
  assert.match(loaded, /## Objective/);
  assert.match(loaded, /Ship the refactor\./);
  assert.match(loaded, /Testing and documenting\./);

  const list = await rpc.list(
    {},
    {
      error: () => {
        throw new Error("no");
      },
    },
  );
  const row = list.artifacts.find((entry) => entry.id === memoryID);
  assert.ok(row, "memory is listed by the RPC");
  assert.equal(row.kind, "memory");
  assert.equal(row.status, "published");

  const planID = await execTool(
    tools,
    "plan_create",
    { title: "P", description: "d", workingDirectory: DIRECTORY },
    ctx,
  );
  const wrongKind = await execTool(
    tools,
    "memory_load",
    { artifactID: planID },
    ctx,
  );
  assert.match(wrongKind, /^ARTIFACT_ERROR/);
  assert.match(wrongKind, /invalid_kind/);
});

test("project memory and the session checkpoint are injected as background context", async (t) => {
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  const { tools, hooks } = await setupPlugin(t, { sessions });
  const ctx = toolContext(PRIMARY_SESSION, "system");

  const projectID = await execTool(tools, "memory_init", {}, ctx);
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: projectID,
      mode: "append",
      content: "## Build quirk\n\nTurbo needs a clean cache.",
    },
    ctx,
  );
  const checkpointID = await execTool(
    tools,
    "memory_init",
    { scope: "session" },
    ctx,
  );
  assert.notEqual(
    checkpointID,
    projectID,
    "the checkpoint is a second document",
  );
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: checkpointID,
      mode: "append",
      content: "## Next Move\n\nRun the tests.",
    },
    ctx,
  );

  const contextHook = hooks.find((entry) => entry.name === "context");
  assert.ok(contextHook, "the context hook is registered");
  const event = {
    sessionID: PRIMARY_SESSION,
    agent: "system",
    system: [],
    messages: [],
  };
  await contextHook.callback(event);
  assert.equal(event.system.length, 1, "memory is injected as a system part");
  assert.equal(event.messages.length, 0, "no synthetic user message is added");
  const text = event.system[0].text;
  assert.match(text, /<memory-context>/);
  assert.match(text, new RegExp(`<project-memory artifact="${projectID}">`));
  assert.match(text, /Turbo needs a clean cache/);
  assert.match(
    text,
    new RegExp(`<session-checkpoint artifact="${checkpointID}">`),
  );
  assert.match(text, /Run the tests\./);
  assert.match(
    text,
    /newest user instruction and freshly verified tool results override/i,
    "memory is background, not authority",
  );

  assert.equal(
    hooks.find((entry) => entry.name === "compaction"),
    undefined,
    "memory is not copied into the compaction transcript",
  );
});

test("memory injection follows the primary mode, not the agent name", async (t) => {
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  const { tools, hooks } = await setupPlugin(t, {
    sessions,
    agents: {
      system: { mode: "primary" },
      plan: { mode: "primary" },
      search: { mode: "subagent" },
    },
  });
  const ctx = toolContext(PRIMARY_SESSION, "system");

  const projectID = await execTool(tools, "memory_init", {}, ctx);
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: projectID,
      mode: "append",
      content: "## Core\n\nKeep this across primaries.",
    },
    ctx,
  );

  const contextHook = hooks.find((entry) => entry.name === "context");
  const primaryEvent = {
    sessionID: PRIMARY_SESSION,
    agent: "plan",
    system: [],
    messages: [],
  };
  await contextHook.callback(primaryEvent);
  assert.equal(
    primaryEvent.system.length,
    1,
    "a non-system primary agent gets the memory block",
  );
  assert.match(primaryEvent.system[0].text, /Keep this across primaries\./);

  const subagentEvent = {
    sessionID: PRIMARY_SESSION,
    agent: "search",
    system: [],
    messages: [],
  };
  await contextHook.callback(subagentEvent);
  assert.equal(
    subagentEvent.system.length,
    0,
    "a subagent does not inherit the primary's memory",
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

  const reportID = await execTool(
    tools,
    "report_create",
    {
      title: "Standalone report",
      description: "No plan needed.",
      summary: "Initial report.",
    },
    ctx,
  );
  const reportFinal = await execTool(
    tools,
    "report_finalize",
    {
      artifactID: reportID,
      summary: "Final report.",
      changed: "Two files.",
      checks: "Tests pass.",
    },
    ctx,
  );
  assert.equal(reportFinal, `${reportID} published`);
  const reportLoaded = await execTool(
    tools,
    "report_load",
    { artifactID: reportID },
    ctx,
  );
  assert.match(reportLoaded, /Final report\./);
  assert.match(reportLoaded, /Two files\./);
  assert.doesNotMatch(
    reportLoaded,
    /Plan: art_/,
    "a standalone report has no plan link",
  );

  const memoryID = await execTool(
    tools,
    "memory_init",
    { content: "## Objective\n\nStart early." },
    ctx,
  );
  const memoryLoaded = await execTool(
    tools,
    "memory_load",
    { artifactID: memoryID },
    ctx,
  );
  assert.match(memoryLoaded, /Start early\./);

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

test("a long checkpoint keeps priority sections and its newest tail, and large project memory is injected as an index", async (t) => {
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  const { tools, hooks } = await setupPlugin(t, { sessions });
  const ctx = toolContext(PRIMARY_SESSION, "system");

  const projectID = await execTool(tools, "memory_init", {}, ctx);
  const sections = [
    "## Core",
    "Always load this core decision.",
    ...Array.from(
      { length: 30 },
      (_, index) => `## Area ${index + 1}\n\n${"detail ".repeat(20)}`,
    ),
  ].join("\n\n");
  await execTool(
    tools,
    "memory_update",
    { artifactID: projectID, mode: "append", content: sections },
    ctx,
  );

  const checkpointID = await execTool(
    tools,
    "memory_init",
    { scope: "session" },
    ctx,
  );
  const longBody = [
    "## Objective",
    "Keep the newest progress.",
    "## Requirements",
    "- The deploy target is PROD-BETA and must survive compaction.",
    "## Progress",
    ...Array.from({ length: 400 }, (_, index) => `- filler line ${index}`),
    "## Next Move",
    "Run the final verification.",
  ].join("\n\n");
  await execTool(
    tools,
    "memory_update",
    { artifactID: checkpointID, mode: "append", content: longBody },
    ctx,
  );

  const contextHook = hooks.find((entry) => entry.name === "context");
  const event = {
    sessionID: PRIMARY_SESSION,
    agent: "system",
    system: [],
    messages: [],
  };
  await contextHook.callback(event);
  const text = event.system[0].text;

  assert.match(text, /Updated: /, "the project index exposes its update time");
  assert.match(
    text,
    /Core:\n## Core\n\nAlways load this core decision\./,
    "the project index always inlines the Core section",
  );
  assert.match(text, /characters omitted; load/, "the checkpoint is bounded");
  assert.match(
    text,
    /Run the final verification\./,
    "the newest section survives truncation",
  );
  assert.match(text, /## Next Move/, "the newest heading survives truncation");
  assert.match(
    text,
    /## Requirements/,
    "a priority section in the middle survives truncation",
  );
  assert.match(
    text,
    /PROD-BETA/,
    "a requirement is not clipped out of the middle",
  );
  assert.match(
    text,
    /## Area 30/,
    "project memory is injected as section headings",
  );
  assert.match(
    text,
    /Load art_[a-f0-9]{8} for the full text/,
    "the project memory body is loaded on demand",
  );
  assert.doesNotMatch(
    text,
    /detail detail detail detail detail detail/,
    "the project memory body is not inlined when large",
  );
});

test("successive checkpoint revisions keep corrections, rejected approaches, and unfinished work", async (t) => {
  const sessions = { [PRIMARY_SESSION]: sessionInfo() };
  const { tools, hooks } = await setupPlugin(t, { sessions });
  const ctx = toolContext(PRIMARY_SESSION, "system");

  const checkpointID = await execTool(
    tools,
    "memory_init",
    { scope: "session" },
    ctx,
  );
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: checkpointID,
      mode: "replace",
      content: [
        "## Objective",
        "Port the parser.",
        "",
        "## Requirements",
        "- Use the old API.",
        "",
        "## Decisions",
        "- Keep the streaming path unchanged.",
      ].join("\n"),
    },
    ctx,
  );

  // A user correction: the superseded requirement is replaced, not duplicated.
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: checkpointID,
      mode: "patch",
      oldText: "- Use the old API.",
      newText: "- Use the new API (user correction).",
    },
    ctx,
  );
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: checkpointID,
      mode: "patch",
      oldText: "- Keep the streaming path unchanged.",
      newText: "- Superseded: the streaming path had to change.",
    },
    ctx,
  );
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: checkpointID,
      mode: "append",
      content:
        "## Rejected Approaches\n\n- Rewriting the parser: it broke streaming.",
    },
    ctx,
  );
  await execTool(
    tools,
    "memory_update",
    {
      artifactID: checkpointID,
      mode: "append",
      content:
        "## Work State\n\n- Complete: parser port.\n- Unfinished: streaming tests.",
    },
    ctx,
  );

  const loaded = await execTool(
    tools,
    "memory_load",
    { artifactID: checkpointID },
    ctx,
  );
  assert.match(loaded, /Use the new API \(user correction\)\./);
  assert.doesNotMatch(
    loaded,
    /Use the old API\./,
    "the correction replaced the old text",
  );
  assert.match(loaded, /Rewriting the parser: it broke streaming\./);
  assert.match(loaded, /Complete: parser port\./);
  assert.match(loaded, /Unfinished: streaming tests\./);

  // The next request sees the same reconciled state, and no stale version.
  const contextHook = hooks.find((entry) => entry.name === "context");
  const event = {
    sessionID: PRIMARY_SESSION,
    agent: "system",
    system: [],
    messages: [],
  };
  await contextHook.callback(event);
  const injected = event.system[0].text;
  assert.match(injected, /Use the new API/);
  assert.doesNotMatch(injected, /Use the old API\./);
  assert.match(injected, /Rejected Approaches/);
  assert.match(injected, /Unfinished: streaming tests\./);
});

test("artifact search covers session artifacts plus shared project memory, not other scopes", async (t) => {
  const { store } = await makeStore(t);
  const PROJECT = "/tmp/opencode/search-project";
  const SESSION = "/tmp/opencode/search-session";

  const memory = await store.createArtifact({
    kind: "memory",
    ownerSessionID: PRIMARY_SESSION,
    writerSessionID: PRIMARY_SESSION,
    primaryAuthor: "System",
    location: PROJECT,
    title: "Project memory",
    description: "Shared.",
    initial: { content: "## Deploy\n\nshared needle phrase." },
  });
  const evidence = await store.createArtifact({
    kind: "evidence",
    ownerSessionID: PRIMARY_SESSION,
    writerSessionID: PRIMARY_SESSION,
    primaryAuthor: "Search",
    location: SESSION,
    title: "Session evidence",
    description: "Local.",
  });
  await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: SESSION,
    writerSessionID: PRIMARY_SESSION,
    title: "Local finding",
    content: "local needle phrase.",
  });
  const rootEvidence = await store.createArtifact({
    kind: "evidence",
    ownerSessionID: PRIMARY_SESSION,
    writerSessionID: PRIMARY_SESSION,
    primaryAuthor: "Search",
    location: PROJECT,
    title: "Root evidence",
    description: "Another scope.",
  });
  await store.evidenceFindingPut({
    artifactID: rootEvidence.artifactID,
    location: PROJECT,
    writerSessionID: PRIMARY_SESSION,
    title: "Root finding",
    content: "root needle phrase.",
  });

  const tools = [];
  addArtifactTools(installEditor({ tools }), {
    store,
    directory: SESSION,
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

  assert.match(output, new RegExp(memory.artifactID), "shared memory is found");
  assert.match(
    output,
    new RegExp(evidence.artifactID),
    "local evidence is found",
  );
  assert.doesNotMatch(
    output,
    new RegExp(rootEvidence.artifactID),
    "evidence in another directory is not returned as unloadable",
  );
});
