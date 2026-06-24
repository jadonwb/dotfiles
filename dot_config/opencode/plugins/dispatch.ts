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
            body: { command: "quick-search", arguments: args.task },
          })
          return `Dispatched /quick-search: ${args.task.substring(0, 120)}`
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
            body: { command: "scout-search", arguments: args.task },
          })
          return `Dispatched /scout-search: ${args.task.substring(0, 120)}`
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
            body: { command: "verify-string-search", arguments: args.task },
          })
          return `Dispatched /verify-string-search: ${args.task.substring(0, 120)}`
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
      "memory-review": tool({
        description:
          "Audit .opencode/project-memory/ for stale sessions, orphaned references, and inconsistencies. Uses review agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe("Task description — specific session file(s) or empty for all"),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "memory-review", arguments: args.task },
          })
          return `Dispatched /memory-review: ${args.task.substring(0, 120)}`
        },
      }),
      "docs-review": tool({
        description:
          "Compare documentation against actual code. Find factual mismatches — wrong paths, outdated signatures, missing features. Uses review agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe("Task description — documentation file(s) to verify"),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "docs-review", arguments: args.task },
          })
          return `Dispatched /docs-review: ${args.task.substring(0, 120)}`
        },
      }),
      "plan-review": tool({
        description:
          "Review a Build Brief or proposed plan for issues before execution — stale references, incomplete scope, inconsistent Find strings, missing rollbacks. Uses review agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe("Task description — the plan or Build Brief text to review"),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "plan-review", arguments: args.task },
          })
          return `Dispatched /plan-review: ${args.task.substring(0, 120)}`
        },
      }),
      edit: tool({
        description:
          "Apply file edits from a Build Brief. Delegates all Find/Replace edits to workers. Uses execute agent with pro model.",
        args: {
          task: tool.schema
            .string()
            .describe(
              "Task description — the Build Brief with Find/Replace pairs"
            ),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "execute-edit", arguments: args.task },
          })
          return `Dispatched /execute-edit: ${args.task.substring(0, 120)}`
        },
      }),
      debug: tool({
        description:
          "Diagnose and fix failures via the debug cycle (max 3 cycles). Delegates all changes to workers using verify for target strings. Uses execute agent with pro model.",
        args: {
          task: tool.schema
            .string()
            .describe(
              "Task description — reproduction command, scope, expected vs actual"
            ),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "execute-debug", arguments: args.task },
          })
          return `Dispatched /execute-debug: ${args.task.substring(0, 120)}`
        },
      }),
      test: tool({
        description:
          "Run a test command and report results. Read-only — does not fix or diagnose. Uses execute agent with flash model.",
        args: {
          task: tool.schema
            .string()
            .describe("Task description — the exact test command to run"),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "execute-test", arguments: args.task },
          })
          return `Dispatched /execute-test: ${args.task.substring(0, 120)}`
        },
      }),
      run: tool({
        description:
          "Execute shell commands the orchestrator cannot run directly — git commits, curl, wget, file operations. Uses execute agent with flash model. Only when user explicitly requests.",
        args: {
          task: tool.schema
            .string()
            .describe("Task description — the exact command to run, verbatim"),
        },
        async execute(args, context) {
          await client.session.command({
            path: { id: context.sessionID },
            body: { command: "execute-run", arguments: args.task },
          })
          return `Dispatched /execute-run: ${args.task.substring(0, 120)}`
        },
      }),
    },
  }
}
