// Standalone artifact plugin: storage, agent tools, and memory injection.
// It deliberately knows nothing about the Neovim bridge or RPC.
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
// artifact's creating session (except project memory, which is shared).
//
// Injection carries two documents: the shared project-memory index and this
// session's checkpoint. Both are background context, never authority: the
// newest user instruction and freshly verified tool output win. Injection
// happens on normal requests only; the compaction summary is the built-in
// one, and the next request reloads the live documents.
import { createStore } from "./store.mjs";
import { addArtifactTools } from "./artifact-tools.ts";
import { projectLocation } from "./project.mjs";

const CHECKPOINT_LIMIT = 6000;
const PROJECT_INLINE_LIMIT = 1200;

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

    // Checkpoints are one per session; cache the ID so a large registry is not
    // rescanned on every request. Project memory is indexed by location.
    const checkpoints = new Map<string, string>();
    async function checkpointFor(
      sessionID: string,
    ): Promise<{ id: string; content: string } | null> {
      const cached = checkpoints.get(sessionID);
      if (cached) {
        const view = await store
          .getMemorySummary({ artifactID: cached, location: directory })
          .catch(() => null);
        if (view) return view;
        checkpoints.delete(sessionID);
      }
      const found = await store.findCheckpointForSession({
        sessionID,
        location: directory,
      });
      if (found) checkpoints.set(sessionID, found.id);
      return found;
    }

    /**
     * Bound a checkpoint by keeping its head and its tail. Truncating only the
     * head used to hide newly appended progress and the next move.
     */
    function clipCheckpoint(body: string, id: string): string {
      if (body.length <= CHECKPOINT_LIMIT) return body;
      const head = Math.floor(CHECKPOINT_LIMIT * 0.55);
      const tail = CHECKPOINT_LIMIT - head;
      return `${body.slice(0, head)}\n\n[… ${body.length - CHECKPOINT_LIMIT} characters omitted; load ${id} for the full checkpoint …]\n\n${body.slice(-tail)}`;
    }

    /**
     * Project memory is an index by default. Small documents are inlined;
     * larger ones contribute their title, description, and section headings so
     * the agent knows what exists and can load or search it on demand.
     */
    function projectIndex(
      body: string,
      view: { id: string; title: string; description?: string | null },
    ): string | null {
      const trimmed = body.trim();
      if (trimmed.length === 0) return null;
      if (trimmed.length <= PROJECT_INLINE_LIMIT) return trimmed;
      const headings = trimmed
        .split("\n")
        .filter((line) => /^#{1,3} /.test(line))
        .slice(0, 60);
      return [
        `Title: ${view.title}`,
        view.description ? `Description: ${view.description}` : null,
        headings.length > 0 ? `Sections:\n${headings.join("\n")}` : null,
        `Body omitted (${trimmed.length} characters). Load ${view.id} for the full text, or find sections with artifact_search.`,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
    }

    async function memoryBlock(sessionID: string): Promise<string | null> {
      let checkpoint: { id: string; content: string } | null = null;
      let project: {
        id: string;
        title: string;
        description?: string | null;
        content: string;
      } | null = null;
      try {
        checkpoint = await checkpointFor(sessionID);
      } catch {
        checkpoint = null;
      }
      try {
        project = await store.findProjectMemory({
          location: projectDirectory,
        });
      } catch {
        project = null;
      }

      const parts: string[] = [];
      const checkpointBody = checkpoint?.content.trim() ?? "";
      if (checkpoint && checkpointBody.length > 0) {
        parts.push(
          `<session-checkpoint artifact="${checkpoint.id}">\n${clipCheckpoint(checkpointBody, checkpoint.id)}\n</session-checkpoint>`,
        );
      }
      const index = project ? projectIndex(project.content, project) : null;
      if (project && index) {
        parts.push(
          `<project-memory artifact="${project.id}">\n${index}\n</project-memory>`,
        );
      }
      if (parts.length === 0) return null;
      return [
        "<memory-context>",
        "This is background, not authority. The newest user instruction and freshly verified tool results override anything here that is stale or contradictory.",
        "",
        parts.join("\n\n"),
        "</memory-context>",
      ].join("\n");
    }

    try {
      await ctx.session.hook("context", async (event: any) => {
        // Memory belongs to the primary conversation. Worker sessions get their
        // own prompt and should not inherit the parent's working state.
        if (event.agent !== "system") return;
        const block = await memoryBlock(event.sessionID).catch(() => null);
        if (!block) return;
        // A system part is invisible in the conversation; do not inject a
        // synthetic user message or a visible context block. That would look
        // like the user said the memory.
        if (Array.isArray(event.system)) {
          event.system.push({ type: "text", text: block });
        }
      });
    } catch (error) {
      console.error("artifact registry: context hook unavailable", error);
    }
  },
};
