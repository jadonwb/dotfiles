// Tests for project identity (plugins/artifacts/project.mjs): which directory
// owns shared artifacts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectLocation } from "../../plugins/artifacts/project.mjs";
import { createStore } from "../../plugins/artifacts/store.mjs";

async function makeDir(t) {
  const root = await mkdtemp(join(tmpdir(), "project-location-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

test("a plain directory is its own project root", async (t) => {
  const root = await makeDir(t);
  assert.equal(projectLocation(root), await realpath(root));
});

test("OPENCODE_PROJECT_ROOT overrides git detection", async (t) => {
  const root = await makeDir(t);
  const override = await makeDir(t);
  const previous = process.env.OPENCODE_PROJECT_ROOT;
  process.env.OPENCODE_PROJECT_ROOT = override;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_PROJECT_ROOT;
    else process.env.OPENCODE_PROJECT_ROOT = previous;
  });
  assert.equal(projectLocation(root), await realpath(override));
});

test("a subdirectory resolves to the repository root", async (t) => {
  const root = await makeDir(t);
  git(root, ["init", "-q"]);
  await writeFile(join(root, "file.txt"), "x");
  const nested = join(root, "a", "b");
  await mkdir(nested, { recursive: true });
  assert.equal(projectLocation(nested), await realpath(root));
});

test("a linked worktree shares the main checkout's artifact scope", async (t) => {
  const root = await makeDir(t);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "file.txt"), "x");
  git(root, ["add", "file.txt"]);
  git(root, ["commit", "-qm", "init"]);
  const worktree = join(root, "..", `wt-${Date.now()}`);
  git(root, ["worktree", "add", "-q", worktree]);
  t.after(() => rm(worktree, { recursive: true, force: true }));
  assert.equal(projectLocation(worktree), await realpath(root));
});

test("artifacts created in a real worktree are visible from the main checkout", async (t) => {
  const root = await makeDir(t);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "file.txt"), "x");
  git(root, ["add", "file.txt"]);
  git(root, ["commit", "-qm", "init"]);
  const worktree = join(root, "..", `wt-artifacts-${Date.now()}`);
  git(root, ["worktree", "add", "-q", "-b", "artifacts-test", worktree]);
  t.after(() => rm(worktree, { recursive: true, force: true }));

  const main = projectLocation(root);
  const linked = projectLocation(worktree);
  assert.equal(main, linked, "the worktree resolves to the main checkout");

  const store = createStore({ root: join(root, ".state") });
  const owner = "ses_owner0000000000000000";
  const writer = "ses_writer000000000000000";
  const plan = await store.createArtifact({
    kind: "plan",
    ownerSessionID: owner,
    writerSessionID: writer,
    primaryAuthor: "System",
    location: linked,
    title: "Worktree plan",
    description: "Created from the worktree.",
    workingDirectory: worktree,
    initial: { goalScope: "- plan needle from the worktree" },
  });

  const loaded = await store.getPlan({
    artifactID: plan.artifactID,
    location: main,
  });
  assert.match(loaded.content, /plan needle from the worktree/);

  const found = await store.artifactSearch({
    location: main,
    query: "plan needle",
  });
  assert.deepEqual(
    found.results.map((result) => result.id),
    [plan.artifactID],
  );

  const evidence = await store.createArtifact({
    kind: "evidence",
    ownerSessionID: owner,
    writerSessionID: writer,
    primaryAuthor: "Search",
    location: main,
    title: "Main evidence",
    description: "Created from the main checkout.",
  });
  await store.evidenceFindingPut({
    artifactID: evidence.artifactID,
    location: main,
    writerSessionID: writer,
    title: "Finding",
    content: "evidence needle from the main checkout.",
  });

  const listed = await store.listArtifacts({ location: linked });
  assert.deepEqual(
    listed.map((item) => item.id).sort(),
    [plan.artifactID, evidence.artifactID].sort(),
  );

  // Deleting the worktree removes only the checkout; the registry lives in the
  // shared state root and stays readable from the main checkout.
  git(root, ["worktree", "remove", "--force", worktree]);
  const afterRemoval = await store.getPlan({
    artifactID: plan.artifactID,
    location: main,
  });
  assert.match(afterRemoval.content, /plan needle from the worktree/);
  const listedAfterRemoval = await store.listArtifacts({ location: main });
  assert.deepEqual(
    listedAfterRemoval.map((item) => item.id).sort(),
    [plan.artifactID, evidence.artifactID].sort(),
  );
});
