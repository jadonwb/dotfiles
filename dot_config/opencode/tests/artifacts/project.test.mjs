// Tests for project identity (plugins/artifacts/project.mjs): which directory
// owns shared project memory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectLocation } from "../../plugins/artifacts/project.mjs";

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

test("OPENCODE_PROJECT_MEMORY_ROOT overrides git detection", async (t) => {
  const root = await makeDir(t);
  const override = await makeDir(t);
  const previous = process.env.OPENCODE_PROJECT_MEMORY_ROOT;
  process.env.OPENCODE_PROJECT_MEMORY_ROOT = override;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_PROJECT_MEMORY_ROOT;
    else process.env.OPENCODE_PROJECT_MEMORY_ROOT = previous;
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

test("a linked worktree shares the main checkout's memory", async (t) => {
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
