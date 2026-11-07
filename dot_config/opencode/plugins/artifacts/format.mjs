// One-way rendering of the read-only artifact view (current.md).
//
// The view is generated from the authoritative record and is never read back
// into storage. Rendering composes a minimal frontmatter block containing only
// frontend artifact metadata (id, kind, status, title, primaryAuthor,
// description — never owner/writer/session routing IDs) followed by a
// deterministic kind-specific Markdown body and then formats the complete
// document with the pinned Prettier binary, so the formatted output is
// idempotent (byte-stable for the same record).
//
// Kind-specific bodies are pure functions of the record:
// - plan: "# Goal / Scope", "## Intended Changes and Behaviors", "## Context",
//   a nested "### Evidence" list snapshotting each referenced evidence
//   artifact's short description next to its artifact ID, then "## Checks".
// - evidence: "# Evidence", the main question/topic, "## Summary",
//   "## Limitations", then one named finding section per detailed finding.
// - review: "# Review", the machine-readable "## Outcome", the human-readable
//   "## Summary", then one named finding section per finding.
// - report: "# Report" with "## Summary", "## Changed", "## Checks", and
//   "## Unfinished" sections.
//
// Machine finding IDs never appear in the Markdown; they are returned by the
// tools and listed compactly by the full load tools only (never by summary
// readers or the rendered view).

import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export const VIEW_FRONTMATTER_KEYS = Object.freeze(["id", "kind", "status", "title", "primaryAuthor", "description"])

// Canonical plan prose fields, ordered as they render. The plan record stores
// each as a single string plus an evidence membership array of snapshotted art_
// artifact IDs.
export const PLAN_FIELD_ORDER = Object.freeze(["goalScope", "intendedChanges", "context", "checks"])

const PRETTIER_BINARY = join(homedir(), ".local/share/nvim/mason/bin/prettier")
const PRETTIER_CONFIG = join(homedir(), ".prettierrc.yaml")
const PRETTIER_STDIN_FILENAME = "artifact.md"

/** Serialize the minimal view frontmatter block (no trailing newline). */
export function serializeViewFrontmatter(header) {
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("view header must be an object")
  }
  const lines = VIEW_FRONTMATTER_KEYS.map((key) => {
    if (typeof header[key] !== "string" || header[key].length === 0) {
      throw new Error(`view frontmatter field ${key} must be a non-empty string`)
    }
    return `${key}: ${JSON.stringify(header[key])}`
  })
  return ["---", ...lines, "---"].join("\n")
}

/** Compose the unformatted displayed document: frontmatter + body. */
export function composeView(header, body) {
  if (typeof body !== "string") {
    throw new Error("view body must be a string")
  }
  return `${serializeViewFrontmatter(header)}\n${body}`
}

/** Format a complete Markdown document with the pinned Prettier binary. */
export function formatMarkdown(markdown) {
  return new Promise((resolve, reject) => {
    const child = spawn(PRETTIER_BINARY, ["--stdin-filepath", PRETTIER_STDIN_FILENAME, "--config", PRETTIER_CONFIG], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk))
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk))
    child.on("error", (error) => {
      reject(new Error(`prettier could not be started (${PRETTIER_BINARY}): ${error.message}`))
    })
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks).toString("utf8").trim()
        reject(new Error(`prettier exited with code ${code}${detail.length > 0 ? `: ${detail}` : ""}`))
        return
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf8"))
    })
    child.stdin?.end(markdown, "utf8")
  })
}

/** Render the read-only view: compose frontmatter + body, then format it. */
export function renderView(header, body) {
  return formatMarkdown(composeView(header, body))
}

function pushHeading(lines, heading, content) {
  if (typeof content !== "string" || content.length === 0) return
  lines.push(`## ${heading}`, "", content, "")
}

/** Deterministic plan body: flat prose fields plus snapshot evidence membership. */
export function planBodyOf(record) {
  const lines = []
  if (typeof record.goalScope === "string" && record.goalScope.length > 0) {
    lines.push("# Goal / Scope", "", record.goalScope, "")
  }
  if (typeof record.workingDirectory === "string" && record.workingDirectory.length > 0) {
    lines.push(`Working directory: ${record.workingDirectory}`, "")
  }
  pushHeading(lines, "Intended Changes and Behaviors", record.intendedChanges)
  pushHeading(lines, "Context", record.context)
  const evidence = record.evidence || []
  if (evidence.length > 0) {
    lines.push("### Evidence", "")
    for (const entry of evidence) {
      const label = typeof entry.description === "string" && entry.description.length > 0 ? entry.description : entry.id
      lines.push(`- ${label} (${entry.id})`, "")
    }
  }
  pushHeading(lines, "Checks", record.checks)
  return lines.join("\n")
}

/** Deterministic evidence body: main question, Summary, Limitations, findings. */
export function evidenceBodyOf(record) {
  const lines = ["# Evidence", ""]
  if (typeof record.question === "string" && record.question.length > 0) {
    lines.push(`**Question.** ${record.question}`, "")
  }
  pushHeading(lines, "Summary", record.summary)
  pushHeading(lines, "Limitations", record.limitations)
  const findings = record.findings || []
  if (findings.length > 0) {
    lines.push("## Findings", "")
    for (const finding of findings) {
      lines.push(`### ${finding.title}`, "")
      lines.push(finding.content, "")
    }
  }
  return lines.join("\n")
}

/** Deterministic review body: Outcome, Summary, then named finding sections. */
export function reviewBodyOf(record) {
  const lines = ["# Review", ""]
  if (typeof record.outcome === "string" && record.outcome.length > 0) {
    lines.push("## Outcome", "", record.outcome, "")
  }
  pushHeading(lines, "Summary", record.summary)
  for (const finding of record.findings || []) {
    lines.push(`## ${finding.title}`, "")
    lines.push(`- Severity: ${finding.severity}`)
    if (finding.affected) lines.push(`- Affected: ${finding.affected}`)
    if (finding.evidence) lines.push(`- Evidence: ${finding.evidence}`)
    if (finding.risk) lines.push(`- Risk: ${finding.risk}`)
    if (finding.correction) lines.push(`- Correction: ${finding.correction}`)
    lines.push("")
  }
  return lines.join("\n")
}

/** Deterministic report body: linked plan, Summary, Changed, Checks, Unfinished. */
export function reportBodyOf(record) {
  const lines = ["# Report", ""]
  if (typeof record.planArtifactID === "string" && record.planArtifactID.length > 0) {
    lines.push(`Plan: ${record.planArtifactID}`, "")
  }
  pushHeading(lines, "Summary", record.summary)
  pushHeading(lines, "Changed", record.changed)
  pushHeading(lines, "Checks", record.checks)
  pushHeading(lines, "Unfinished", record.unfinished)
  return lines.join("\n")
}

/** Compose the body for whichever kind this record is. */
export function bodyOf(record) {
  if (record.kind === "plan") return planBodyOf(record)
  if (record.kind === "evidence") return evidenceBodyOf(record)
  if (record.kind === "review") return reviewBodyOf(record)
  return reportBodyOf(record)
}