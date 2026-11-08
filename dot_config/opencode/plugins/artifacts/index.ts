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
const PROJECT_CORE_LIMIT = 800;

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

    const CHECKPOINT_PRIORITY =
      /^##\s+(Objective|Requirements|Decisions|Blockers|Next Move)\b/i;

    type MemorySection = { heading: string | null; text: string; index: number };

    /** Split a checkpoint into `## ` sections; the preamble has a null heading. */
    function splitSections(body: string): MemorySection[] {
      const sections: MemorySection[] = [];
      let current: { heading: string | null; lines: string[] } = {
        heading: null,
        lines: [],
      };
      for (const line of body.split("\n")) {
        if (/^##\s+/.test(line)) {
          if (current.heading !== null || current.lines.length > 0) {
            sections.push({
              heading: current.heading,
              text: current.lines.join("\n"),
              index: sections.length,
            });
          }
          current = { heading: line, lines: [line] };
        } else {
          current.lines.push(line);
        }
      }
      if (current.heading !== null || current.lines.length > 0) {
        sections.push({
          heading: current.heading,
          text: current.lines.join("\n"),
          index: sections.length,
        });
      }
      return sections;
    }

    function headTailClip(body: string, id: string): string {
      const head = Math.floor(CHECKPOINT_LIMIT * 0.55);
      const tail = CHECKPOINT_LIMIT - head;
      return `${body.slice(0, head)}\n\n[… ${body.length - CHECKPOINT_LIMIT} characters omitted; load ${id} for the full checkpoint …]\n\n${body.slice(-tail)}`;
    }

    /**
     * Bound a checkpoint by section instead of by character position. The
     * durable decision sections survive; recent non-priority sections (usually
     * Progress) fill the remaining budget from the end. Freeform documents with
     * no `## ` headings fall back to the old head+tail clip.
     */
    function clipCheckpoint(body: string, id: string): string {
      if (body.length <= CHECKPOINT_LIMIT) return body;
      const sections = splitSections(body);
      const priority = sections.filter(
        (section) =>
          section.heading !== null && CHECKPOINT_PRIORITY.test(section.heading),
      );
      if (priority.length === 0) return headTailClip(body, id);

      const kept = new Set<number>();
      for (const section of sections) {
        if (section.heading === null || priority.includes(section)) {
          kept.add(section.index);
        }
      }
      let used = sections
        .filter((section) => kept.has(section.index))
        .reduce((total, section) => total + section.text.length, 0);

      // Keep the newest non-priority sections first, since progress is appended.
      for (let index = sections.length - 1; index >= 0; index--) {
        const section = sections[index];
        if (kept.has(section.index)) continue;
        if (used + section.text.length > CHECKPOINT_LIMIT) continue;
        kept.add(section.index);
        used += section.text.length;
      }

      if (used > CHECKPOINT_LIMIT) {
        const keptText = sections
          .filter((section) => kept.has(section.index))
          .map((section) => section.text)
          .join("\n\n");
        return headTailClip(keptText, id);
      }

      const parts: string[] = [];
      let omitted = 0;
      let marker = false;
      for (const section of sections) {
        if (kept.has(section.index)) {
          parts.push(section.text);
          continue;
        }
        omitted += section.text.length;
        if (!marker) {
          parts.push(`[… 0 characters omitted; load ${id} for the full checkpoint …]`);
          marker = true;
        }
      }
      return parts
        .join("\n\n")
        .replace(
          `[… 0 characters omitted; load ${id} for the full checkpoint …]`,
          `[… ${omitted} characters omitted; load ${id} for the full checkpoint …]`,
        );
    }

    /** Extract one `## ` section body, including its heading, or null. */
    function extractSection(body: string, heading: RegExp): string | null {
      const lines = body.split("\n");
      const collected: string[] = [];
      let capturing = false;
      for (const line of lines) {
        if (/^##\s+/.test(line)) {
          if (capturing) break;
          capturing = heading.test(line);
          if (capturing) collected.push(line);
          continue;
        }
        if (capturing) collected.push(line);
      }
      const text = collected.join("\n").trim();
      return text.length > 0 ? text : null;
    }

    function clipText(text: string, limit: number): string {
      if (text.length <= limit) return text;
      return `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted …]`;
    }

    /**
     * Project memory is an index by default. Small documents are inlined;
     * larger ones inline the portable `## Core` section and contribute the
     * title, description, update time, and section headings so the agent knows
     * what exists and can load or search it on demand.
     */
    function projectIndex(
      body: string,
      view: {
        id: string;
        title: string;
        description?: string | null;
        updatedAt?: string;
      },
    ): string | null {
      const trimmed = body.trim();
      if (trimmed.length === 0) return null;
      if (trimmed.length <= PROJECT_INLINE_LIMIT) return trimmed;
      const core = extractSection(trimmed, /^##\s+Core\b/i);
      const headings = trimmed
        .split("\n")
        .filter(
          (line) =>
            /^#{1,3} /.test(line) && !/^##\s+Core\b/i.test(line),
        )
        .slice(0, 60);
      return [
        `Title: ${view.title}`,
        view.description ? `Description: ${view.description}` : null,
        `Updated: ${view.updatedAt ?? "unknown"}`,
        core ? `Core:\n${clipText(core, PROJECT_CORE_LIMIT)}` : null,
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

    async function isPrimaryAgent(agentID: string): Promise<boolean> {
      try {
        const agent = await ctx.agent?.get({ agentID });
        if (agent && typeof agent.mode === "string") {
          return agent.mode === "primary";
        }
      } catch {
        // Fall through to the system-only behavior on older plugin APIs.
      }
      return agentID === "system";
    }

    try {
      await ctx.session.hook("context", async (event: any) => {
        // Memory belongs to the primary conversation. Worker sessions get their
        // own prompt and should not inherit the parent's working state.
        const agentID = typeof event.agent === "string" ? event.agent : "";
        if (!(await isPrimaryAgent(agentID))) return;
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
