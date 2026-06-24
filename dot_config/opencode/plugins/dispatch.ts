import { type Plugin } from "@opencode-ai/plugin";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// Descriptions that route to a different subagent for model override
const AGENT_OVERRIDES: Record<string, string> = {
  research: "researcher",
};

// Map short description names to command file names
const DESC_TO_FILE: Record<string, string> = {
  quick: "quick-search",
  scout: "scout-search",
  research: "deep-research",
  verify: "verify-string-search",
  edit: "execute-edit",
  debug: "execute-debug",
  test: "execute-test",
  run: "execute-run",
};

export const DispatchPlugin: Plugin = async ({ client }) => {
  // Load command file bodies at init — strip frontmatter and $ARGUMENTS
  const bodies: Record<string, string> = {};
  const dir = join(import.meta.dirname, "..", "commands");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const name = file.replace(".md", "");
    const raw = readFileSync(join(dir, file), "utf-8");
    const parts = raw.split("---");
    const body =
      parts.length >= 3
        ? parts
            .slice(2)
            .join("---")
            .replace(/\$ARGUMENTS\s*$/m, "")
            .trim()
        : raw;
    bodies[name] = body;
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;

      const desc = output.args?.description as string | undefined;
      if (!desc) return;

      const filename = DESC_TO_FILE[desc] || desc;
      const body = bodies[filename];
      if (!body) return;

      // Prepend command instructions to the prompt (idempotent — guard against
      // the hook firing multiple times per task() call)
      const prompt = (output.args?.prompt as string) || "";
      if (!prompt.startsWith(body)) {
        output.args.prompt = body + "\n\n" + prompt;
      }

      // Reroute subagent for model overrides
      if (AGENT_OVERRIDES[desc]) {
        output.args.subagent_type = AGENT_OVERRIDES[desc];
      }
    },
  };
};
