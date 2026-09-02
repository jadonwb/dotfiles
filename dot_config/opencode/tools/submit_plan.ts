import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

async function run(command: string[], cwd?: string): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  return { code, stdout, stderr }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "session"
}

export default tool({
  description:
    "Submit a complete implementation plan for interactive review in plannotator-tui. " +
    "The tool waits for explicit approval or revision feedback and never starts implementation.",
  args: {
    plan: tool.schema
      .string()
      .min(1)
      .describe("The complete Markdown plan to review."),
  },
  async execute(args, context) {
    if (!process.env.WEZTERM_PANE) {
      return [
        "PLAN_REVIEW_ERROR",
        "OpenCode is not running inside a WezTerm pane (WEZTERM_PANE is unset).",
        "Run OpenCode inside WezTerm and submit the plan again.",
      ].join("\n")
    }

    const stateRoot =
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
    const session = safeName(context.sessionID ?? "session")
    const reviewDir = join(stateRoot, "opencode", "plan-reviews", session)
    const revision = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const planPath = join(reviewDir, `plan-${revision}.md`)
    const resultPath = join(reviewDir, `result-${revision}.txt`)

    await mkdir(reviewDir, { recursive: true })
    await Bun.write(planPath, `${args.plan.trim()}\n`)

    // The review happens in a new tab in the current WezTerm window/domain.
    // After the TUI closes, the same tab asks for an explicit approval. The
    // marker lets this tool wait without depending on pane-close behavior.
    const reviewer = [
      'plannotator-tui "$1"',
      "tui_status=$?",
      'if [ "$tui_status" -ne 0 ]; then',
      '  printf "ERROR:%s\\n" "$tui_status" > "$2"',
      '  exit "$tui_status"',
      "fi",
      "printf '\\nApprove this exact plan? [y/N]: '",
      "IFS= read -r answer",
      'case "$answer" in',
      '  y|Y|yes|YES|Yes) printf "APPROVED\\n" > "$2" ;;',
      '  *) printf "REVISE\\n" > "$2" ;;',
      "esac",
    ].join("\n")

    const spawned = await run(
      [
        "wezterm",
        "cli",
        "spawn",
        "--cwd",
        context.directory,
        "--",
        "bash",
        "-c",
        reviewer,
        "opencode-plan-review",
        planPath,
        resultPath,
      ],
      context.directory,
    )

    if (spawned.code !== 0) {
      return [
        "PLAN_REVIEW_ERROR",
        `Could not open the WezTerm review tab: ${spawned.stderr.trim() || spawned.stdout.trim()}`,
        `Plan preserved at: ${planPath}`,
      ].join("\n")
    }

    const paneId = spawned.stdout.trim()
    if (paneId) {
      // Cosmetic only; review must continue if an older WezTerm lacks this
      // command or rejects the pane identifier.
      await run([
        "wezterm",
        "cli",
        "set-tab-title",
        "--pane-id",
        paneId,
        "Plan review",
      ])
    }

    const deadline = Date.now() + 12 * 60 * 60 * 1000
    let decision = ""

    while (Date.now() < deadline) {
      try {
        decision = (await readFile(resultPath, "utf8")).trim()
        if (decision) break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT") throw error
      }
      await Bun.sleep(300)
    }

    if (!decision) {
      return [
        "PLAN_REVIEW_ERROR",
        "Timed out waiting for the TUI review.",
        `Plan preserved at: ${planPath}`,
      ].join("\n")
    }

    if (decision.startsWith("ERROR:")) {
      return [
        "PLAN_REVIEW_ERROR",
        `plannotator-tui exited with status ${decision.slice("ERROR:".length)}.`,
        `Plan preserved at: ${planPath}`,
      ].join("\n")
    }

    const exported = await run(["plannotator-tui", "--export", planPath])
    const annotations = exported.code === 0 ? exported.stdout.trim() : ""

    if (decision === "APPROVED") {
      return [
        "PLAN_APPROVED",
        "The user approved this exact plan in the TUI workflow.",
        "Approval does not authorize or start implementation.",
        `Plan: ${planPath}`,
      ].join("\n")
    }

    return [
      "PLAN_CHANGES_REQUESTED",
      annotations ||
        "The user declined approval without exporting annotations. Ask what should change.",
      `Plan: ${planPath}`,
    ].join("\n\n")
  },
})
