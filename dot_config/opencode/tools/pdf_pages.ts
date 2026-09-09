import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, realpath, stat, readFile, writeFile, rm, mkdir, lstat, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

const MAX_PAGES = 5
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024
const TIMEOUT_MS = 30_000

// No shell: document paths remain arguments, including quotes and metacharacters.
async function run(argv: string[], signal: AbortSignal, timeout = TIMEOUT_MS): Promise<string> {
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
    const timer = setTimeout(() => stop(new Error(`${argv[0]} timed out.`)), timeout)
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


const INDEX_VERSION = 1
const MAX_INDEX_BYTES = 64 * 1024 * 1024
const MAX_INDEX_PAGES = 100_000

async function fingerprint(source: string): Promise<string> {
  const s = await stat(source, { bigint: true })
  return createHash("sha256").update(JSON.stringify([
    INDEX_VERSION, source, s.dev.toString(), s.ino.toString(), s.size.toString(),
    s.mtimeNs.toString(), s.ctimeNs.toString(),
  ])).digest("hex")
}

// Keep form feeds: they identify physical pages, including pages with no text.
function splitPages(text: string, count: number): string[] {
  const pages = text.split("\f")
  if (pages.length === count + 1 && !pages.at(-1)!.trim()) pages.pop()
  if (pages.length !== count) throw new Error("Text page boundaries do not match PDF page count; use explicit page extraction.")
  return pages
}

async function indexedPages(source: string, signal: AbortSignal) {
  const key = await fingerprint(source)
  const root = `/tmp/opencode-pdf-index-${process.getuid!()}`
  await mkdir(root, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) {
    throw new Error("PDF index cache must be a private directory owned by the current user.")
  }
  const directory = join(root, key)
  const load = async () => {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
    if (manifest.key !== key || !Number.isSafeInteger(manifest.pages) || manifest.pages < 1 || manifest.pages > MAX_INDEX_PAGES) throw new Error("Invalid index manifest")
    const path = join(directory, "text.txt")
    if ((await stat(path)).size > MAX_INDEX_BYTES) throw new Error("Cached PDF text exceeds 64 MiB")
    return splitPages(await readFile(path, "utf8"), manifest.pages)
  }
  signal.throwIfAborted()
  try {
    const pages = await load()
    if (await fingerprint(source) !== key) throw new Error("Source changed during search; retry.")
    return { key, pages, reused: true }
  } catch (error) {
    signal.throwIfAborted()
    // Missing or damaged caches are rebuilt. Publish only complete directories.
    if (await fingerprint(source) !== key) throw new Error("Source changed during search; retry.")
  }
  const temp = await mkdtemp(join(root, ".build-"))
  try {
    const metadata = await run(["pdfinfo", source], signal)
    const count = Number(metadata.match(/^Pages:\s+(\d+)\s*$/m)?.[1])
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INDEX_PAGES) throw new Error("Unsupported PDF page count for indexing.")
    const path = join(temp, "text.txt")
    await run(["pdftotext", "-layout", "-enc", "UTF-8", source, path], signal, 120_000)
    if ((await stat(path)).size > MAX_INDEX_BYTES) throw new Error("Document text exceeds the 64 MiB local index limit; use page extraction.")
    const pages = splitPages(await readFile(path, "utf8"), count)
    signal.throwIfAborted()
    if (await fingerprint(source) !== key) throw new Error("Source changed while indexing; retry.")
    await writeFile(join(temp, "manifest.json"), JSON.stringify({ key, pages: count }))
    // A concurrent search may already have published the same index.
    try { await rename(temp, directory) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error
      try { await load() } catch {
        await rm(directory, { recursive: true, force: true })
        await rename(temp, directory)
      }
    }
    return { key, pages, reused: false }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

// Literal phrase matching: flexible whitespace and optional line-end hyphenation.
// Search the original string so excerpts keep original spelling and line breaks.
function phrasePattern(query: string): RegExp {
  const normalized = query.replace(/(\p{L})[-\u2010][ \t]*\r?\n[ \t]*(?=\p{L})/gu, "$1")
    .replace(/\u00ad/g, "").trim().replace(/\s+/gu, " ")
  if (!normalized) throw new Error("Search query must contain visible text.")
  const chars = Array.from(normalized)
  let pattern = ""
  for (let i = 0; i < chars.length; i++) {
    if (i && /\p{L}/u.test(chars[i - 1]) && /\p{L}/u.test(chars[i])) {
      pattern += "(?:\\u00ad|[-\\u2010][ \\t]*\\r?\\n[ \\t]*)?"
    }
    pattern += chars[i] === " " ? "\\s+" : chars[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(pattern, "iu")
}

async function searchDocument(source: string, query: string, limit: number, offset: number, signal: AbortSignal) {
  const pattern = phrasePattern(query)
  const index = await indexedPages(source, signal)
  const results: { physical_page: number; excerpt: string }[] = []
  const emptySample: number[] = []
  let empty = 0
  let matched = 0
  for (let i = 0; i < index.pages.length; i++) {
    if (i % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    signal.throwIfAborted()
    const page = index.pages[i]
    if (!page.trim()) { empty++; if (emptySample.length < 20) emptySample.push(i + 1) }
    const match = pattern.exec(page)
    if (!match) continue
    if (matched >= offset && results.length < limit) {
      const start = Math.max(0, match.index - 100)
      const end = Math.min(page.length, start + 320)
      results.push({ physical_page: i + 1, excerpt: (start ? "…" : "") + page.slice(start, end) + (end < page.length ? "…" : "") })
    }
    matched++
  }
  if (await fingerprint(source) !== index.key) throw new Error("Source changed during search; restart pagination.")
  return JSON.stringify({ operation: "search", source, query, index_id: index.key, cache_reused: index.reused,
    source_page_count: index.pages.length, matched_pages: matched, offset, results,
    next_offset: offset + results.length < matched ? offset + results.length : null,
    coverage: { pages_with_text: index.pages.length - empty, pages_without_text: empty, empty_page_sample: emptySample },
    warnings: ["Literal, case-insensitive phrase search; whitespace and common line-end hyphenation are tolerated. No semantic search or OCR.",
      "Text coverage does not imply visual coverage; even a scan may contain a small text footer. Verify candidate pages with image extraction.",
      ...(empty ? ["Some pages have no extractable text. No match does not prove the topic is absent."] : [])],
    next: "Extract relevant physical pages with the same tool. Never read or attach the full local index. Restart pagination if index_id changes.",
  }, null, 2)
}

export default tool({
  description:
    "Search a PDF using operation=search and query (cached local text; bounded page hits), or " +
    "extract explicit PDF pages into temporary text, PNGs, or a page-only PDF. " +
    "Never attaches or returns the original PDF. Returns paths and original page mappings; " +
    "use read on those outputs. Physical pages are 1-based, not printed labels. Max 5 pages.",
  args: {
    path: tool.schema.string().min(1).describe("Local source PDF path; relative paths use the session directory."),
    operation: tool.schema.enum(["extract", "search"]).optional().describe("Default extract preserves existing calls. Search indexes locally and returns only page hits."),
    query: tool.schema.string().min(1).max(200).optional().describe("Required for search: literal case-insensitive phrase, not a regex."),
    max_results: tool.schema.number().int().min(1).max(20).optional().describe("Search matching pages per response; default 10."),
    offset: tool.schema.number().int().min(0).optional().describe("Search pagination offset; use returned next_offset, default 0."),
    first_page: tool.schema.number().int().min(1).optional().describe("First physical PDF page (1-based); required only for extraction."),
    last_page: tool.schema.number().int().min(1).optional().describe("Last physical page, inclusive; defaults to first_page."),
    format: tool.schema.enum(["text", "image", "pdf"]).optional().describe("Default text; image for scans/diagrams; pdf only with native PDF model support."),
  },
  async execute(args, context) {
    const operation = args.operation ?? "extract"
    const first = args.first_page
    const last = args.last_page ?? first
    const format = args.format ?? "text"
    // Validate again for callers that invoke execute without schema validation.
    if (operation === "extract" && (first === undefined || last === undefined || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last - first + 1 > MAX_PAGES)) {
      throw new Error(`Select an inclusive range of 1-${MAX_PAGES} physical pages, starting at page 1 or later.`)
    }
    if (!["extract", "search"].includes(operation)) throw new Error("Unknown operation.")
    if (operation === "search") {
      if (!args.query?.trim() || args.query.length > 200) throw new Error("Search requires a nonempty query of at most 200 characters.")
      if (first !== undefined || args.last_page !== undefined || args.format !== undefined) throw new Error("Search is document-wide: omit page and format arguments.")
      if (!Number.isSafeInteger(args.max_results ?? 10) || (args.max_results ?? 10) < 1 || (args.max_results ?? 10) > 20 || !Number.isSafeInteger(args.offset ?? 0) || (args.offset ?? 0) < 0) throw new Error("Invalid search pagination.")
    } else if (args.query !== undefined || args.offset !== undefined || args.max_results !== undefined) throw new Error("Search arguments require operation=search.")
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
    await context.ask({ permission: "pdf_pages", patterns: [...new Set([requested, source])], always: [source], metadata: { source, operation, first, last, format } })
    context.abort.throwIfAborted()
    if (!(await stat(source)).isFile()) throw new Error("Source must be a regular local PDF file.")
    if (operation === "search") return searchDocument(source, args.query!, args.max_results ?? 10, args.offset ?? 0, context.abort)
    if (first === undefined || last === undefined) throw new Error("Extraction requires first_page.")
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
