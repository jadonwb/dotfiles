import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { mkdtemp, realpath, stat, readFile, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

const MAX_PAGES = 5
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024
const TIMEOUT_MS = 30_000

// No shell: document paths remain arguments, including quotes and metacharacters.
async function run(argv: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    const stop = (error: Error) => {
      failure ??= error
      child.kill("SIGKILL")
    }
    const abort = () => stop(new Error("PDF extraction cancelled."))
    const timer = setTimeout(() => stop(new Error(`${argv[0]} timed out.`)), TIMEOUT_MS)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) stop(new Error("PDF utility diagnostic output exceeded 1 MiB."))
      else target.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = error.code === "ENOENT"
        ? new Error(`Missing ${argv[0]}. Install Poppler (poppler-utils on Ubuntu; poppler on Arch).`)
        : error
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(`${argv[0]} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`))
      resolveResult(Buffer.concat(stdout).toString("utf8"))
    })
  })
}

export default tool({
  description:
    "Extract only explicit PDF pages into temporary text, PNGs, or a page-only PDF. " +
    "Never attaches or returns the original PDF. Returns paths and original page mappings; " +
    "use read on those outputs. Physical pages are 1-based, not printed labels. Max 5 pages.",
  args: {
    path: tool.schema.string().min(1).describe("Local source PDF path; relative paths use the session directory."),
    first_page: tool.schema.number().int().min(1).describe("First physical PDF page (1-based), required."),
    last_page: tool.schema.number().int().min(1).optional().describe("Last physical page, inclusive; defaults to first_page."),
    format: tool.schema.enum(["text", "image", "pdf"]).optional().describe("Default text; image for scans/diagrams; pdf only with native PDF model support."),
  },
  async execute(args, context) {
    const first = args.first_page
    const last = args.last_page ?? first
    const format = args.format ?? "text"
    // Validate again for callers that invoke execute without schema validation.
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last - first + 1 > MAX_PAGES) {
      throw new Error(`Select an inclusive range of 1-${MAX_PAGES} physical pages, starting at page 1 or later.`)
    }
    if (!["text", "image", "pdf"].includes(format)) throw new Error("Unknown output format.")
    const expanded = args.path.startsWith("~/") ? join(homedir(), args.path.slice(2)) : args.path
    const requested = resolve(context.directory, expanded)
    const source = await realpath(requested)
    const root = await realpath(context.worktree || context.directory)
    const rel = relative(root, source)
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      await context.ask({ permission: "external_directory", patterns: [source], always: [join(dirname(source), "*")], metadata: { source } })
    }
    // Separate permission from default read: default read denies original PDFs.
    // Restrict pdf_pages by source-path patterns if certain documents are off limits.
    await context.ask({ permission: "pdf_pages", patterns: [...new Set([requested, source])], always: [source], metadata: { source, first, last, format } })
    context.abort.throwIfAborted()
    if (!(await stat(source)).isFile()) throw new Error("Source must be a regular local PDF file.")
    const info = await run(["pdfinfo", source], context.abort)
    const count = Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1])
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Could not determine the PDF page count.")
    if (last > count) throw new Error(`Requested page ${last}, but the PDF has ${count} physical pages.`)

    // mkdtemp creates a private per-call directory. No caller-controlled output path.
    const directory = await mkdtemp("/tmp/opencode-pdf-")
    const outputs: { path: string; source_pages: number[]; bytes: number }[] = []
    let total = 0
    const record = async (path: string, pages: number[]) => {
      const size = (await stat(path)).size
      const cap = format === "text" ? MAX_TEXT_BYTES : MAX_OUTPUT_BYTES
      total += size
      if (size === 0 || total > cap) throw new Error(`Extracted output is empty or exceeds ${cap} bytes. Request fewer pages.`)
      outputs.push({ path, source_pages: pages, bytes: size })
    }
    const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i)
    const warnings: string[] = []
    try {
      if (format === "text") {
        // Separate files retain source-page identity even when read in line windows.
        for (const page of pages) {
          const path = join(directory, `page-${page}.txt`)
          await run(["pdftotext", "-f", String(page), "-l", String(page), "-layout", "-enc", "UTF-8", source, path], context.abort)
          const size = (await stat(path)).size
          if (size > MAX_TEXT_BYTES) throw new Error("Page text exceeds 256 KiB; inspect the page as an image.")
          const text = await readFile(path, "utf8")
          if (!text.trim()) warnings.push(`Page ${page}: no extractable text. Use image mode; this does not prove the page is blank.`)
          await writeFile(path, `Source: ${source}\nPhysical PDF page: ${page} of ${count}\n\n${text}`)
          await record(path, [page])
        }
      } else if (format === "image") {
        for (const page of pages) {
          const prefix = join(directory, `page-${page}`)
          await run(["pdftoppm", "-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "2000", "-png", source, prefix], context.abort)
          await record(`${prefix}.png`, [page])
        }
        warnings.push("Images have a maximum 2000-pixel long side. Do not infer unreadable fine print.")
      } else {
        const parts = pages.map((page) => join(directory, `part-${page}.pdf`))
        // Per-page splitting bounds the selected page tree before combination.
        await run(["pdfseparate", "-f", String(first), "-l", String(last), source, join(directory, "part-%d.pdf")], context.abort)
        for (const path of parts) {
          if ((await stat(path)).size > MAX_OUTPUT_BYTES) throw new Error("A PDF page exceeds 8 MiB; use image or text mode.")
        }
        const selection = join(directory, "selection.pdf")
        if (parts.length === 1) {
          const { rename } = await import("node:fs/promises")
          await rename(parts[0], selection)
        } else {
          await run(["pdfunite", ...parts, selection], context.abort)
          for (const path of parts) await rm(path)
        }
        const selectedInfo = await run(["pdfinfo", selection], context.abort)
        if (Number(selectedInfo.match(/^Pages:\s+(\d+)\s*$/m)?.[1]) !== pages.length) throw new Error("Extracted PDF page count did not match the request.")
        await record(selection, pages)
        warnings.push("Extract page 1 corresponds to the first requested source page. Native PDF model/provider support is required.")
      }
      context.abort.throwIfAborted()
      return JSON.stringify({ source, source_page_count: count, format, outputs, warnings,
        next: "Read only the returned output paths. Cite the original source and physical page. Temporary files may be removed by OS cleanup.",
      }, null, 2)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  },
})
