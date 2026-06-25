import { homedir } from "os"
import { join } from "path"
import { mkdirSync } from "fs"

const BRIEFS_DIR = join(homedir(), ".local", "share", "opencode", "briefs")
mkdirSync(BRIEFS_DIR, { recursive: true })

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
            api.ui.DialogAlert({ title: "Brief Path", message: path })
          )
          dialog?.setSize?.("medium")
        },
      },
    ])
  },
}
