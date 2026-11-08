// Standalone artifact plugin: storage and agent tools. It deliberately knows
// nothing about the Neovim bridge or RPC.
//
// The editor-facing half lives in ../artifacts-rpc, which imports the store and
// the contract and registers `personal.artifacts` through the bridge. Keeping
// that adapter out of this plugin means the artifact tools stay usable without
// any bridge code.
//
// Registry logic lives in ./store.mjs, tool/authorization logic in
// ./artifact-tools.ts, and project identity in ./project.mjs. The location is
// captured once at setup (tool contexts have no directory), the owner is
// resolved from server-assigned session ancestry, and the writer is the
// artifact's creating session.
//
// Artifacts are project-scoped: plans, evidence, and reviews created in one
// worktree are listed and loadable from every worktree of the same checkout.
// No context is injected and no summary is rewritten; durable notes live in
// AGENTS.md, repository docs, and the artifacts themselves.
import { createStore } from "./store.mjs";
import { addArtifactTools } from "./artifact-tools.ts";
import { projectLocation } from "./project.mjs";

export default {
  id: "personal.artifact-registry",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const projectDirectory = projectLocation(directory);
    const store = createStore();
    await ctx.tool.transform((editor) => {
      addArtifactTools(editor, {
        store,
        directory,
        projectDirectory,
        getSession: (input) => ctx.session.get(input),
      });
    });
  },
};
