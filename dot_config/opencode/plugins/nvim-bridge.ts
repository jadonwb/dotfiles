import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

// Neovim control channel.
//
// The editor publishes `{ server, cwd, pid, updated }` in a runtime directory
// (see lua/features/bridge/registry.lua). This plugin reads that registry and
// drives the matching editor with `nvim --server … --remote-expr`, using the
// editor's own documented API. There is no custom protocol: the same calls any
// external tool can make.
//
// Why the registry exists: a plugin runs in the OpenCode *server*, which does
// not inherit the environment of the editor that started a run. `$NVIM` is
// therefore unavailable, but the socket path is stable for the editor's life.

const exec = promisify(execFile)

const STALE_MS = 5 * 60 * 1000

type Editor = {
  server: string
  cwd: string
  pid: number
  profile?: string
  updated: number
}

/** A killed editor leaves its entry behind; only live processes count. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function registryDirs(): string[] {
  const dirs: string[] = []
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) dirs.push(join(runtime, "nvim-bridge"))
  // The editor falls back to its cache directory when XDG_RUNTIME_DIR is unset.
  dirs.push(join(homedir(), ".cache", "nvim", "nvim-bridge"))
  return dirs
}

async function readEditors(): Promise<Editor[]> {
  const editors: Editor[] = []
  const now = Date.now() / 1000

  for (const dir of registryDirs()) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }

    for (const name of names) {
      if (!name.endsWith(".json")) continue
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as Partial<Editor>
        if (typeof parsed.server !== "string" || !parsed.server) continue
        if (typeof parsed.cwd !== "string") continue
        const updated = typeof parsed.updated === "number" ? parsed.updated : 0
        if (now - updated > STALE_MS / 1000) continue
        if (typeof parsed.pid !== "number" || !alive(parsed.pid)) continue
        editors.push({
          server: parsed.server,
          cwd: parsed.cwd,
          pid: typeof parsed.pid === "number" ? parsed.pid : 0,
          profile: parsed.profile,
          updated,
        })
      } catch {
        // A half-written entry is ignored; the next refresh picks it up.
      }
    }
  }

  return editors
}

/**
 * Prefer the editor whose working directory contains the session's directory;
 * otherwise the most recently active one.
 */
function pick(editors: Editor[], directory: string): Editor | undefined {
  let best: Editor | undefined
  let bestScore = -1

  for (const editor of editors) {
    let score = 0
    if (directory === editor.cwd) score = 1_000_000
    else if (directory.startsWith(editor.cwd.replace(/\/$/, "") + "/")) score = editor.cwd.length
    if (score > bestScore) {
      best = editor
      bestScore = score
    }
  }

  if (bestScore > 0 && best) return best
  return editors.sort((a, b) => b.updated - a.updated)[0]
}

async function remote(editor: Editor, expression: string): Promise<string> {
  const { stdout } = await exec("nvim", ["--server", editor.server, "--remote-expr", expression], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

function quote(value: string): string {
  return JSON.stringify(value)
}

export default {
  id: "nvim-bridge",
  async setup(ctx: any) {
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "nvim",
        description: "Inspect and drive the Neovim instance attached to this project",
      })

      editor.add({
        name: "control",
        description:
          "Drive the user's Neovim editor: show a file, open the agent transcript, point a layout slot at another provider, or read the layout state. Use it when the user should see something in the editor rather than only in the terminal transcript.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["open", "transcript", "slot", "layout", "status", "append", "show"],
              description:
                "open: show a file (needs path, optional line). transcript: show the agent transcript buffer. slot: point a layout slot at a provider (needs slot, provider). layout: current layout state as JSON. status: live slot windows as JSON. append: add a note line to the transcript (needs text).",
            },
            path: { type: "string", description: "File to open, absolute or relative to the project" },
            line: { type: "integer", description: "1-based line to jump to after opening" },
            slot: {
              type: "string",
              enum: ["left", "right_top", "right_mid", "right_bottom", "bottom"],
            },
            provider: {
              type: "string",
              description:
                "Provider to show in the slot, for example changes, session, prompt, terminal, quickfix, problems, explorer, preview",
            },
            text: { type: "string", description: "Note to append to the transcript, or the content for `show`" },
            title: { type: "string", description: "Title for the `show` surface" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "nvim" },
        execute: async (input: any, context: any) => {
          const action = String(input.action ?? "")

          const editors = await readEditors()
          if (editors.length === 0) {
            return {
              content:
                "No Neovim instance is registered. The user must start this editor with the nvim-bridge config and leave it running.",
            }
          }

          const target = pick(editors, String(ctx.location?.directory ?? process.cwd()))
          if (!target) {
            return { content: "No reachable Neovim instance." }
          }

          await context.progress({ status: `nvim ${action}` })

          try {
            switch (action) {
              case "open": {
                if (!input.path) return { content: "open needs a path" }
                const line = Number.isInteger(input.line) ? String(input.line) : "nil"
                const ok = await remote(
                  target,
                  `v:lua.NVBridge.open_file(${quote(String(input.path))}, ${line})`,
                )
                return {
                  content:
                    ok === "true"
                      ? `Opened ${input.path}${input.line ? `:${input.line}` : ""} in Neovim`
                      : `Neovim could not open ${input.path}`,
                }
              }

              case "transcript": {
                await remote(target, "v:lua.NVBridge.open()")
                return { content: "Showing the agent transcript in Neovim" }
              }

              case "slot": {
                if (!input.slot || !input.provider) return { content: "slot needs slot and provider" }
                const ok = await remote(
                  target,
                  `v:lua.NVSlots.set_provider(${quote(String(input.slot))}, ${quote(String(input.provider))})`,
                )
                return {
                  content:
                    ok === "true"
                      ? `Slot ${input.slot} now shows ${input.provider}`
                      : `Neovim rejected ${input.provider} for slot ${input.slot}`,
                }
              }

              case "layout": {
                const json = await remote(target, 'luaeval("vim.json.encode(NVSlots.state())")')
                return { content: json || "{}" }
              }

              case "status": {
                const json = await remote(target, 'luaeval("vim.json.encode(NVSlots.status())")')
                return { content: json || "{}" }
              }

              case "show": {
                if (!input.text) return { content: "show needs text" }
                const ok = await remote(
                  target,
                  `v:lua.NVBridge.show_text(${quote(String(input.title ?? "Artifact"))}, ${quote(String(input.text))})`,
                )
                return {
                  content: ok === "true" ? "Shown in Neovim" : "Neovim could not show the content",
                }
              }

              case "append": {
                if (!input.text) return { content: "append needs text" }
                await remote(target, `v:lua.NVBridge.append(${quote(String(input.text))})`)
                return { content: "Appended to the transcript" }
              }

              default:
                return { content: `Unknown action: ${action}` }
            }
          } catch (error) {
            return { content: `Neovim call failed: ${String(error)}` }
          }
        },
      })
    })
  },
}
