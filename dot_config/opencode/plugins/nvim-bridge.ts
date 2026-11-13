import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

// Neovim control channel.
//
// The editor publishes `{ server, cwd, pid, updated, sessions }` in a runtime
// directory (see lua/features/bridge/registry.lua) and drives it with
// `nvim --server … --remote-expr`, using the editor's own documented API.
// There is no custom protocol: the same calls any external tool can make.
//
// The connection is editor-initiated. `sessions` lists the OpenCode sessions
// that editor connected to (its prompt target, the transcripts it shows).
// Only those sessions get the tool — a `context` hook removes it from every
// other request — and a call drives exactly the editor bound to its session,
// never one guessed from the working directory.
//
// Why the registry exists: a plugin runs in the OpenCode *server*, which does
// not inherit the environment of the editor that started a run. `$NVIM` is
// therefore unavailable, but the socket path is stable for the editor's life.

const exec = promisify(execFile)

type Editor = {
  server: string
  cwd: string
  pid: number
  profile?: string
  updated: number
  sessions: string[]
}

/** The tool's effective name: namespace `nvim`, name `control`. */
const TOOL = "nvim_control"

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
        // Liveness, not age: an editor left idle for an hour is still the
        // user's editor. A dead one is skipped (and pruned by the next editor).
        if (typeof parsed.pid !== "number" || !alive(parsed.pid)) continue
        editors.push({
          server: parsed.server,
          cwd: parsed.cwd,
          pid: typeof parsed.pid === "number" ? parsed.pid : 0,
          profile: parsed.profile,
          updated,
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((s) => typeof s === "string") : [],
        })
      } catch {
        // A half-written entry is ignored; the next refresh picks it up.
      }
    }
  }

  return editors
}

/** The editor that connected to `sessionID`: the most recently active one if several did. */
function boundTo(editors: Editor[], sessionID: string | undefined): Editor | undefined {
  if (!sessionID) return undefined
  return editors.filter((editor) => editor.sessions.includes(sessionID)).sort((a, b) => b.updated - a.updated)[0]
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
    // Only sessions a Neovim connected to see the tool. The hook sees direct
    // tools only, so the tool is not part of Code Mode's catalog.
    await ctx.session.hook("context", async (event: any) => {
      if (!event.tools || !(TOOL in event.tools)) return
      if (!boundTo(await readEditors(), event.sessionID)) delete event.tools[TOOL]
    })

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
        options: { namespace: "nvim", codemode: false },
        execute: async (input: any, context: any) => {
          const action = String(input.action ?? "")

          const target = boundTo(await readEditors(), context.sessionID)
          if (!target) {
            return { content: "No Neovim is connected to this session. The user connects one from Neovim." }
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
