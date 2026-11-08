import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, closeSync, mkdirSync, openSync, unlinkSync } from "node:fs"
import { join } from "node:path"

// Server-side desktop notifications. The TUI's attention path is terminal-
// mediated (and duplicates when a desktop client is also open), so this plugin
// is the single notifier: one notification per completed primary session.
//
// Duplicate plugin copies in one server share `claims`; separate server
// processes coordinate through an atomic lock file in the runtime directory.

const LOCK_TTL_MS = 15_000
const DEBUG = process.env.OPENCODE_NOTIFY_DEBUG === "1"
const DEBUG_LOG = "/tmp/opencode/desktop-notify.log"

const shared: { claims: Set<string> } = ((globalThis as any).__opencodeDesktopNotify ??= {
  claims: new Set<string>(),
})

const lockDirectory = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "opencode-desktop-notify")

function trace(line: string) {
  if (!DEBUG) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  } catch {}
}

function claim(key: string): boolean {
  if (shared.claims.has(key)) return false
  shared.claims.add(key)
  setTimeout(() => shared.claims.delete(key), LOCK_TTL_MS)

  try {
    mkdirSync(lockDirectory, { recursive: true })
  } catch {
    return true
  }

  const lock = join(lockDirectory, createHash("sha256").update(key).digest("hex"))
  try {
    closeSync(openSync(lock, "wx"))
  } catch {
    return false
  }

  setTimeout(() => {
    try {
      unlinkSync(lock)
    } catch {}
  }, LOCK_TTL_MS)
  return true
}

function notify(title: string, body: string) {
  const env = { ...process.env }
  if (!env.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`
  }

  try {
    const child = spawn(
      "notify-send",
      [
        "--app-name",
        "OpenCode",
        "--icon",
        "ai.opencode.desktop",
        "--urgency",
        "normal",
        "--expire-time",
        "-1",
        "--",
        title,
        body,
      ],
      { env, stdio: "ignore", detached: true },
    )
    child.on("error", (error) => trace(`notify-send error: ${error.message}`))
    child.on("exit", (code) => trace(`notify-send exited code=${code}`))
    child.unref()
    trace(`notify-send spawned pid=${child.pid} title=${JSON.stringify(title)}`)
  } catch (error) {
    trace(`notify-send threw: ${String(error)}`)
  }
}

const STATUS: Record<string, string> = {
  "session.execution.succeeded": "Session done",
  "session.execution.failed": "Session failed",
  "session.execution.interrupted": "Session interrupted",
}

export default {
  id: "desktop-notifications",
  async setup(ctx: any) {
    trace("setup called")
    const controller = new AbortController()

    const run = async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          trace(`event ${event.type}`)
          const body = STATUS[event.type]
          if (!body) continue

          const sessionID = event.data?.sessionID
          if (typeof sessionID !== "string" || !sessionID) {
            trace(`event ${event.type} without sessionID`)
            continue
          }

          const session = await ctx.session
            .get({ sessionID }, { signal: controller.signal })
            .catch((error: unknown) => {
              trace(`session.get failed for ${sessionID}: ${String(error)}`)
              return undefined
            })

          if (session?.parentID) {
            trace(`skip child session ${sessionID}`)
            continue
          }

          // The event id is shared by every server that sees the same run. Fall
          // back to a two-second bucket for events without one.
          const key = `${event.type}:${sessionID}:${event.id ?? Math.floor(Date.now() / 2000)}`
          if (!claim(key)) {
            trace(`claim lost for ${key}`)
            continue
          }

          const title =
            typeof session?.title === "string" && session.title.trim() ? session.title.trim() : "OpenCode"
          notify(title, body)
        }
        trace("event stream ended")
      } catch (error) {
        trace(`event stream failed: ${String(error)}`)
      }
    }

    void run()
    return () => controller.abort()
  },
}
