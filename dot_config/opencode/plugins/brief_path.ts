import { tool, type Plugin } from "@opencode-ai/plugin"
import { homedir } from "os"
import { mkdirSync } from "fs"
import { join } from "path"

export const BriefPathPlugin: Plugin = async () => {
  const BRIEFS_DIR = join(homedir(), ".local", "share", "opencode", "briefs")
  mkdirSync(BRIEFS_DIR, { recursive: true })

  return {
    tool: {
      get_brief_path: tool({
        description:
          "Returns the session-scoped brief filepath. Always call this before reading or writing a brief to get the correct path. The path uses the current session ID to prevent cross-session overwrites.",
        args: {},
        async execute(_args, ctx) {
          return join(BRIEFS_DIR, `${ctx.sessionID}.brief.md`)
        },
      }),
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "brief-path") return
      const path = join(BRIEFS_DIR, `${input.sessionID}.brief.md`)
      output.parts = [{ type: "text", text: path }]
    },

    "shell.env": async (input, output) => {
      if (input.sessionID) {
        output.env.BRIEF = join(BRIEFS_DIR, `${input.sessionID}.brief.md`)
      }
    },
  }
}
