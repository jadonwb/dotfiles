import { homedir } from "os"
import { join } from "path"
import { mkdirSync } from "fs"
import { execSync } from "child_process"

const BRIEFS_DIR = join(homedir(), ".local", "share", "opencode", "briefs")
mkdirSync(BRIEFS_DIR, { recursive: true })

function copyToClipboard(text: string): boolean {
  const commands = ["wl-copy", "xclip -selection clipboard", "pbcopy"]
  for (const cmd of commands) {
    try { execSync(cmd, { input: text, stdio: "ignore" }); return true } catch {}
  }
  return false
}

export default {
  id: "brief-path-tui",
  tui: async (api: any) => {
    api.command.register(() => [
      {
        title: "Brief Path",
        value: "brief-path.show",
        description: "Show the brief file path for the current session",
        slash: { name: "brief-path" },
        onSelect: async (dialog: any) => {
          const route = api.route.current
          if (route.name !== "session" || typeof route.params?.sessionID !== "string") {
            api.ui.toast({ variant: "warning", message: "Open a session to use /brief-path." })
            return
          }
          const path = join(BRIEFS_DIR, `${route.params.sessionID}.brief.md`)
          dialog?.clear?.()
          dialog?.replace?.(() =>
            api.ui.DialogAlert({
              title: "Brief Path",
              message: path,
              onConfirm: () => {
                try {
                  if (copyToClipboard(path)) {
                    api.ui.toast({ variant: "success", message: "Copied to clipboard" })
                  }
                } catch {
                  // clipboard unavailable — silently continue
                }
              },
            })
          )
          dialog?.setSize?.("medium")
        },
      },
    ])
  },
}
