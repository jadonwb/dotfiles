// V2 plugin: registers the save_evidence tool.
// Ported from the V1 custom tool file ~/.config/opencode/tools/save_evidence.ts.
// Behavior is unchanged: appends-only Markdown notes under the state directory,
// read-only files, hashed session paths. The V1 context.abort checkpoint was
// dropped because the V2 tool context carries no abort signal.
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const MAX_BYTES = 64 * 1024

export default {
  id: "personal.save-evidence",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "save_evidence",
        description:
          "Save a focused Markdown research note for another worker to read. " +
          "Returns its absolute path without repeating its contents. Each call creates " +
          "a new note; existing notes and project files cannot be edited by this tool. " +
          "The title is written as the note's H1 heading; do not write your own H1 heading in the content. " +
          "Use inline answers for brief evidence. Maximum note size: 64 KiB UTF-8.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 160, description: "A short, single-line subject for the note. It becomes the note's H1 heading." },
            content: { type: "string", minLength: 1, description: "Focused Markdown findings with descriptive headings, exact implementation details, source references, and limitations." },
          },
          required: ["title", "content"],
          additionalProperties: false,
        },
        options: { permission: "save_evidence" },
        async execute(args: any, context: { sessionID: string }) {
          const title = args.title.trim()
          const content = args.content.trim()
          if (!title || title.length > 160 || /[\r\n]/.test(title) || !content) {
            throw new Error("Provide a single-line title (1–160 characters) and nonempty Markdown content.")
          }
          const body = `# ${title}\n\n${content}\n`
          if (Buffer.byteLength(body, "utf8") > MAX_BYTES) {
            throw new Error("Note exceeds 64 KiB UTF-8. Keep only evidence needed for this question, or split distinct subjects.")
          }

          const configuredRoot = process.env.XDG_STATE_HOME
          const stateRoot = configuredRoot && isAbsolute(configuredRoot)
            ? configuredRoot : join(homedir(), ".local", "state")
          // No caller-selected output path. The hash keeps session identifiers out of paths.
          const session = createHash("sha256").update(context.sessionID).digest("hex").slice(0, 24)
          const directory = join(stateRoot, "opencode", "evidence", session)
          await mkdir(directory, { recursive: true, mode: 0o700 })
          const noteDirectory = await mkdtemp(join(directory, "note-"))
          const notePath = join(noteDirectory, "evidence.md")
          try {
            await writeFile(notePath, body, { flag: "wx", mode: 0o400 })
          } catch (error) {
            await rm(noteDirectory, { recursive: true, force: true }).catch(() => {})
            throw error
          }
          return {
            content: [
              "EVIDENCE_SAVED",
              `Path: ${notePath}`,
              `Title: ${title}`,
              "Reference this exact path and the relevant headings. Save corrections as a new note.",
            ].join("\n"),
          }
        },
      })
    })
  },
}
