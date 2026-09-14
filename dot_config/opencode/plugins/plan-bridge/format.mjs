// One-way rendering of the read-only artifact view (current.md).
//
// The view is generated from the authoritative record and is never read back
// into storage: the store patches the verbatim body it saved, while editors and
// `artifact_get` read the Prettier-formatted view. Rendering composes a minimal
// frontmatter block (id, kind, status, title) followed by the verbatim body and
// then formats the complete document, so the formatted output is idempotent.

import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export const VIEW_FRONTMATTER_KEYS = Object.freeze(["id", "kind", "status", "title"])

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

/** Compose the unformatted displayed document: frontmatter + verbatim body. */
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
