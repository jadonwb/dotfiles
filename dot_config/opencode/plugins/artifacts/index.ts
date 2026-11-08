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
// The context hook carries the shared project-memory index. The session
// session memory is appended to the compaction summary by the compaction response
// hook, so it is absent from normal requests and present, verbatim, after
// compaction. Both are background context, never authority: the newest user
// instruction and freshly verified tool output win.
import { createStore } from "./store.mjs";
import { addArtifactTools } from "./artifact-tools.ts";
import { sectionPreview } from "./format.mjs";
import { projectLocation } from "./project.mjs";

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

    function clipText(text: string, limit: number): string {
      if (text.length <= limit) return text;
      return `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted …]`;
    }

    /**
     * Project memory is an index by default. Small documents are inlined;
     * larger ones inline the portable `## Core` section content and list every
     * other section's title and short preview. The agent loads one section by
     * title, or the whole document, on demand.
     */
    function projectIndex(view: {
      content: string;
      sections?: Array<{ title: string; content: string }>;
    }): string | null {
      const trimmed = view.content.trim();
      if (trimmed.length === 0) return null;
      if (trimmed.length <= PROJECT_INLINE_LIMIT) return trimmed;
      const sections = Array.isArray(view.sections) ? view.sections : [];
      const core = sections.find(
        (section) => section.title.trim().toLowerCase() === "core",
      );
      const others = sections.filter((section) => section !== core);
      const sectionLines = others.map((section) => {
        const preview = sectionPreview(section);
        return `- ${section.title}${preview.length > 0 ? `: ${preview}` : ""}`;
      });
      return [
        "Project memory",
        core && core.content.trim().length > 0
          ? `Core:\n${clipText(core.content, PROJECT_CORE_LIMIT)}`
          : null,
        sectionLines.length > 0
          ? `Sections:\n${sectionLines.join("\n")}`
          : null,
        `Body omitted (${trimmed.length} characters). Load a section by title with memory_load(section), or the full body without it; search with artifact_search.`,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
    }

    async function memoryBlock(): Promise<string | null> {
      let project: {
        id: string;
        title: string;
        description?: string | null;
        updatedAt?: string;
        content: string;
        sections?: Array<{ title: string; content: string }>;
      } | null = null;
      try {
        project = await store.findProjectMemory({
          location: projectDirectory,
        });
      } catch {
        project = null;
      }
      const index = project ? projectIndex(project) : null;
      if (!project || !index) return null;
      return [
        "<memory-context>",
        "This is background, not authority. The newest user instruction and freshly verified tool results override anything here that is stale or contradictory.",
        "",
        `<project-memory artifact="${project.id}">\n${index}\n</project-memory>`,
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

    function sessionMemoryBlock(sessionMemory: {
      id: string;
      content: string;
    }): string {
      return [
        "",
        "",
        "---",
        "",
        "# Session Memory",
        "",
        `Artifact: ${sessionMemory.id}`,
        "",
        sessionMemory.content.trim(),
        "",
      ].join("\n");
    }

    /** Insert one content delta before the finish event of an SSE response. */
    function appendToSse(body: string, block: string): string | null {
      if (!body.includes("data:")) return null;
      const lines = body.split(/\r?\n/);
      let finishAt = -1;
      let doneAt = -1;
      let meta: any = null;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          if (doneAt === -1) doneAt = index;
          continue;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk && Array.isArray(chunk.choices) && chunk.choices.length > 0) {
          meta = meta ?? chunk;
          const finish = chunk.choices[0].finish_reason;
          if (
            finish !== null &&
            finish !== undefined &&
            finishAt === -1
          )
            finishAt = index;
        }
      }
      const insertAt =
        finishAt !== -1 ? finishAt : doneAt !== -1 ? doneAt : lines.length;
      const event = {
        id: meta?.id ?? "chatcmpl-compaction",
        object: "chat.completion.chunk",
        created: Number.isFinite(meta?.created)
          ? meta.created
          : Math.floor(Date.now() / 1000),
        model: typeof meta?.model === "string" ? meta.model : "compaction",
        choices: [
          {
            index: 0,
            delta: { content: block },
            finish_reason: null,
          },
        ],
      };
      lines.splice(insertAt, 0, `data: ${JSON.stringify(event)}`, "");
      return lines.join("\n");
    }

    /** Append the session memory to a non-streaming JSON completion. */
    function appendToJson(body: string, block: string): string | null {
      let data: any;
      try {
        data = JSON.parse(body);
      } catch {
        return null;
      }
      const choice = data?.choices?.[0];
      if (choice?.message && typeof choice.message.content === "string") {
        choice.message.content += block;
      } else if (typeof choice?.text === "string") {
        choice.text += block;
      } else {
        return null;
      }
      return JSON.stringify(data);
    }

    async function appendSessionMemory(
      response: Response,
      block: string,
    ): Promise<Response> {
      const contentType = response.headers.get("content-type") ?? "";
      const copy = response.clone();
      const body = await copy.text();
      const next = contentType.includes("text/event-stream")
        ? appendToSse(body, block)
        : contentType.includes("application/json")
          ? appendToJson(body, block)
          : body.includes("data:")
            ? appendToSse(body, block)
            : null;
      if (next === null) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(next, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    async function appendSessionMemoryToCompaction(event: any): Promise<void> {
      if (event?.kind !== "compaction") return;
      const sessionID =
        typeof event.sessionID === "string"
          ? event.sessionID
          : typeof event.session?.id === "string"
            ? event.session.id
            : null;
      if (!sessionID || !event.response) return;
      const sessionMemory = await store
        .findSessionMemoryForSession({ sessionID, location: directory })
        .catch(() => null);
      if (!sessionMemory || sessionMemory.content.trim().length === 0) return;
      event.response = await appendSessionMemory(
        event.response,
        sessionMemoryBlock(sessionMemory),
      ).catch(() => event.response);
    }

    try {
      await ctx.session.hook("http.response", appendSessionMemoryToCompaction);
    } catch (error) {
      console.error(
        "artifact registry: compaction response hook unavailable",
        error,
      );
    }

    try {
      await ctx.session.hook("context", async (event: any) => {
        // Memory belongs to the primary conversation. Worker sessions get their
        // own prompt and should not inherit the parent's working state.
        const agentID = typeof event.agent === "string" ? event.agent : "";
        if (!(await isPrimaryAgent(agentID))) return;
        const block = await memoryBlock().catch(() => null);
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
