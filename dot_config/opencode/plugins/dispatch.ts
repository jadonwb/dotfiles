import { type Plugin, tool } from "@opencode-ai/plugin"

export const DispatchPlugin: Plugin = async ({ client }) => {
  return {
    tool: {
      quick: tool({
        description:
          "Fast focused lookup in a known file. Uses search agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe(
              "Task description — include file paths and the specific question"
            ),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "quick-lookup", arguments: args.task },
          })
          return `Dispatched /quick-lookup: ${args.task.substring(0, 120)}`
        },
      }),
      scout: tool({
        description:
          "Map a directory or module — list files, categorize by role, identify connections. Uses search agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe(
              "Task description — include directory path and mapping focus"
            ),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "scout", arguments: args.task },
          })
          return `Dispatched /scout: ${args.task.substring(0, 120)}`
        },
      }),
      research: tool({
        description:
          "Deep multi-file reasoning with dossier-bound analysis. Uses search agent with pro model. Provide all file paths and the specific question.",
        args: {
          task: tool.schema
            .string()
            .describe(
              "Task description — include file paths, question, and context"
            ),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "deep-research", arguments: args.task },
          })
          return `Dispatched /deep-research: ${args.task.substring(0, 120)}`
        },
      }),
      verify: tool({
        description:
          "Confirm exact strings exist in a file for Build Briefs. Uses search agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe(
              "Task description — include file path and target string to verify"
            ),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "verify-string", arguments: args.task },
          })
          return `Dispatched /verify-string: ${args.task.substring(0, 120)}`
        },
      }),
      "code-review": tool({
        description:
          "Audit code changes for stale references, regressions, and bugs. Uses review agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe(
              "Task description — scope of files/directories to review"
            ),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "code-review", arguments: args.task },
          })
          return `Dispatched /code-review: ${args.task.substring(0, 120)}`
        },
      }),
      docs: tool({
        description:
          "Audit .opencode/project-memory/ for stale sessions, orphaned references, and consistency issues. Uses review agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe("Task description — any specific focus for the audit"),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "docs", arguments: args.task },
          })
          return `Dispatched /docs: ${args.task.substring(0, 120)}`
        },
      }),
    },
  }
}
