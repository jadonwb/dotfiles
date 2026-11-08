// Project identity for shared artifacts.
//
// Artifacts must follow the repository, not the tab: sessions opened in a
// subdirectory, and sessions opened in a git worktree, should share one
// artifact scope. The rule is:
//
//   - a normal checkout or a submodule: the repository root
//   - a linked worktree: the main checkout that owns the common git directory
//   - no git repository: the directory itself
//
// `OPENCODE_PROJECT_ROOT` overrides the result, which keeps tests and
// unusual layouts deterministic.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

function git(directory, args) {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Resolve the shared project root for one session directory. */
export function projectLocation(directory) {
  const override = process.env.OPENCODE_PROJECT_ROOT;
  if (typeof override === "string" && override.trim().length > 0) {
    return resolve(override.trim());
  }
  const resolved = resolve(directory);
  const toplevel = git(resolved, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return resolved;

  // Submodules have their own root; do not share artifacts with the superproject.
  const superproject = git(resolved, [
    "rev-parse",
    "--show-superproject-working-tree",
  ]);
  if (superproject) return toplevel;

  const common = git(resolved, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!common) return toplevel;

  // A linked worktree's common dir points at the main checkout's .git. A normal
  // checkout's common dir is its own .git, whose parent is the toplevel.
  const owner = dirname(common);
  return resolve(owner) === resolve(toplevel) ? toplevel : owner;
}
