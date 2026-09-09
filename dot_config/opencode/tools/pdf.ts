import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, realpath, stat, lstat, readFile, writeFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, isAbsolute, resolve } from "node:path"

const TIMEOUT_MS = 30_000
const MAX_TEXT_BYTES = 24 * 1024
const MAX_PAGE_TEXT_BYTES = 2 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const CACHE_VERSION = 2
const BATCH_PAGES = 24

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


function integer(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`)
  }
  return value
}

async function fingerprint(source: string) {
  const s = await stat(source, { bigint: true })
  return createHash('sha256').update(JSON.stringify([
    CACHE_VERSION, source, String(s.dev), String(s.ino), String(s.size),
    String(s.mtimeNs), String(s.ctimeNs),
  ])).digest('hex')
}

async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077)) {
    throw new Error('PDF cache directory must be private and owned by the current user.')
  }
}

async function openDocument(filePath: string, context: ToolContext, permission: string) {
  context.abort.throwIfAborted()
  const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
  const requested = resolve(context.directory, expanded)
  const source = await realpath(requested)
  const root = await realpath(context.worktree || context.directory)
  const rel = relative(root, source)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    await context.ask({ permission: 'external_directory', patterns: [source], always: [join(dirname(source), '*')], metadata: { source } })
  }
  await context.ask({ permission, patterns: [...new Set([requested, source])], always: [source], metadata: { source } })
  if (!(await stat(source)).isFile()) throw new Error('Source must be a regular local PDF file.')
  const id = await fingerprint(source)
  const cacheRoot = `/tmp/opencode-pdf-v2-${process.getuid!()}`
  await privateDirectory(cacheRoot)
  const cache = join(cacheRoot, id)
  await privateDirectory(cache)
  const info = await run(['pdfinfo', source], context.abort)
  const count = Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1])
  integer(count, 1, 100_000, 'PDF page count')
  const unchanged = async () => {
    context.abort.throwIfAborted()
    if (await fingerprint(source) !== id) throw new Error('PDF changed during the operation. Start a new read or search without a cursor.')
  }
  await unchanged()
  return { source, id, count, cache, unchanged }
}

type Document = Awaited<ReturnType<typeof openDocument>>

function range(doc: Document, first: number, last: number, maxPages = 100_000) {
  integer(first, 1, doc.count, 'first_page')
  integer(last, first, doc.count, 'last_page')
  if (last - first + 1 > maxPages) throw new Error(`Read at most ${maxPages} physical pages per call.`)
}

async function cachedPage(doc: Document, page: number): Promise<string | undefined> {
  const path = join(doc.cache, `${page}.txt`)
  try {
    const s = await lstat(path)
    if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_PAGE_TEXT_BYTES) return undefined
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

// Extract only missing consecutive pages. The cache is shared by read and search.
async function pageTexts(doc: Document, first: number, last: number, signal: AbortSignal) {
  const result: string[] = []
  for (let page = first; page <= last;) {
    signal.throwIfAborted()
    const hit = await cachedPage(doc, page)
    if (hit !== undefined) { result.push(hit); page++; continue }
    let end = page
    while (end < last && end - page + 1 < BATCH_PAGES && await cachedPage(doc, end + 1) === undefined) end++
    const temp = await mkdtemp(join(doc.cache, '.extract-'))
    try {
      const path = join(temp, 'text.txt')
      await run(['pdftotext', '-f', String(page), '-l', String(end), '-layout', '-enc', 'UTF-8', doc.source, path], signal, 120_000)
      if ((await stat(path)).size > MAX_PAGE_TEXT_BYTES * (end - page + 1)) {
        throw new Error('Extracted text exceeds the local processing limit. Use a smaller range or image mode.')
      }
      const chunks = (await readFile(path, 'utf8')).split('\f')
      if (chunks.length === end - page + 2 && !chunks.at(-1)!.trim()) chunks.pop()
      if (chunks.length !== end - page + 1) throw new Error('PDF text page boundaries could not be verified. Use image mode.')
      await doc.unchanged()
      for (let i = 0; i < chunks.length; i++) {
        if (Buffer.byteLength(chunks[i]) > MAX_PAGE_TEXT_BYTES) throw new Error(`Page ${page + i} exceeds the local text limit. Use image mode.`)
        const staged = join(temp, `${i}.txt`)
        await writeFile(staged, chunks[i], { mode: 0o600 })
        await rename(staged, join(doc.cache, `${page + i}.txt`))
      }
      result.push(...chunks)
      page = end + 1
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
  return result
}

// Wrap pathological long lines without dropping characters. Offsets refer to these
// stable display lines, using the same layout in search locations and text reads.
function displayLines(text: string) {
  return text.replace(/\r\n?/g, '\n').split('\n').flatMap(line => {
    const chars = Array.from(line)
    if (!chars.length) return ['']
    const parts: string[] = []
    for (let i = 0; i < chars.length; i += 1000) parts.push(chars.slice(i, i + 1000).join(''))
    return parts
  })
}

const filePathArg = () => tool.schema.string().min(1).describe('Local PDF path; relative paths use the session directory.')
const pageArg = () => tool.schema.number().int().min(1)

export const read = tool({
  description: 'Read 1–3 physical PDF pages. Returns bounded text directly, or attaches only selected page images/PDF. Never attaches the original document. Physical pages are 1-based, not printed labels. Default: one page as text.',
  args: {
    filePath: filePathArg(),
    first_page: pageArg().describe('First physical page to read (1-based).'),
    last_page: pageArg().optional().describe('Last physical page, inclusive; defaults to first_page. At most 3 pages.'),
    format: tool.schema.enum(['text', 'image', 'pdf']).optional().describe('Default text. Image for diagrams/scans. PDF only with native PDF input support.'),
    offset: pageArg().optional().describe('Text only: starting display line within the selected page range; default 1.'),
    limit: tool.schema.number().int().min(1).max(1000).optional().describe('Text only: maximum display lines; default 200. Also capped at 24 KiB.'),
    source_id: tool.schema.string().optional().describe('For text continuation, use the returned source_id to reject a changed document.'),
    resolution: tool.schema.enum(['standard', 'high']).optional().describe('Image only: maximum long side 2000 or 3200 pixels; default standard.'),
  },
  async execute(args, context) {
    const format = args.format ?? 'text'
    if (!['text', 'image', 'pdf'].includes(format)) throw new Error('Unknown format.')
    if (format !== 'text' && (args.offset !== undefined || args.limit !== undefined || args.source_id !== undefined)) throw new Error('offset, limit, and source_id apply only to text reads.')
    if (format !== 'image' && args.resolution !== undefined) throw new Error('resolution applies only to image reads.')
    if (args.resolution !== undefined && !['standard', 'high'].includes(args.resolution)) throw new Error('Unknown image resolution.')
    const doc = await openDocument(args.filePath, context, 'pdf_read')
    if (args.source_id !== undefined && args.source_id !== doc.id) throw new Error('PDF changed since the previous read. Restart without source_id and offset.')
    const first = args.first_page, last = args.last_page ?? first
    range(doc, first, last, 3)
    const title = `${format === 'text' ? 'Read' : 'View'} PDF pages ${first}–${last}`
    if (format === 'text') {
      const offset = integer(args.offset ?? 1, 1, Number.MAX_SAFE_INTEGER, 'offset')
      const limit = integer(args.limit ?? 200, 1, 1000, 'limit')
      const texts = await pageTexts(doc, first, last, context.abort)
      const lines = texts.flatMap((text, i) => displayLines(text).map((content, j) => ({ page: first + i, page_line: j + 1, content })))
      if (offset > lines.length) throw new Error(`offset exceeds the ${lines.length} display lines in this selection.`)
      const output: string[] = [`Source: ${doc.source}`, `Physical pages: ${first}–${last} of ${doc.count}`, `Source ID: ${doc.id}`, 'Lines: selection-line [physical-page:page-line] text']
      let bytes = 0, next = offset
      for (let i = offset - 1; i < lines.length && i < offset - 1 + limit; i++) {
        const line = `${i + 1} [${lines[i].page}:${lines[i].page_line}] ${lines[i].content}`
        if (bytes + Buffer.byteLength(line) + 1 > MAX_TEXT_BYTES) break
        output.push(line); bytes += Buffer.byteLength(line) + 1; next = i + 2
      }
      const empty = texts.flatMap((text, i) => text.trim() ? [] : [first + i])
      if (empty.length) output.push(`No extractable text on physical pages: ${empty.join(', ')}. Use image mode; this does not mean the pages are blank.`)
      const more = next <= lines.length
      output.push(more ? `Continue: ${JSON.stringify({ filePath: doc.source, first_page: first, last_page: last, format: 'text', offset: next, limit, source_id: doc.id })}` : `End of selection: ${lines.length} display lines.`)
      await doc.unchanged()
      return { title, output: output.join('\n'), metadata: { source_id: doc.id, first_page: first, last_page: last, total_lines: lines.length, truncated: more, next_offset: more ? next : null } }
    }
    const temp = await mkdtemp(join(doc.cache, '.visual-'))
    try {
      const files: { path: string; filename: string; mime: string }[] = []
      if (format === 'image') {
        const size = args.resolution === 'high' ? 3200 : 2000
        for (let page = first; page <= last; page++) {
          const prefix = join(temp, `page-${page}`)
          await run(['pdftoppm', '-f', String(page), '-l', String(page), '-singlefile', '-scale-to', String(size), '-png', doc.source, prefix], context.abort)
          files.push({ path: `${prefix}.png`, filename: `page-${page}.png`, mime: 'image/png' })
        }
      } else {
        await run(['pdfseparate', '-f', String(first), '-l', String(last), doc.source, join(temp, 'page-%d.pdf')], context.abort)
        const parts = Array.from({ length: last - first + 1 }, (_, i) => join(temp, `page-${first + i}.pdf`))
        for (const part of parts) if ((await stat(part)).size > MAX_ATTACHMENT_BYTES) throw new Error('Selected PDF page exceeds 8 MiB. Use image or text mode.')
        const selected = join(temp, 'selection.pdf')
        if (parts.length === 1) await rename(parts[0], selected)
        else await run(['pdfunite', ...parts, selected], context.abort)
        const info = await run(['pdfinfo', selected], context.abort)
        if (Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1]) !== parts.length) throw new Error('Selected PDF page count could not be verified.')
        files.push({ path: selected, filename: `pages-${first}-${last}.pdf`, mime: 'application/pdf' })
      }
      let total = 0
      for (const file of files) {
        const size = (await stat(file.path)).size
        total += size
        if (!size || total > MAX_ATTACHMENT_BYTES) throw new Error('Selected attachments are empty or exceed 8 MiB total. Request fewer pages, standard resolution, or text.')
      }
      const attachments = []
      for (const file of files) attachments.push({ type: 'file' as const, mime: file.mime, filename: file.filename, url: `data:${file.mime};base64,${(await readFile(file.path)).toString('base64')}` })
      await doc.unchanged()
      return { title, output: `Source: ${doc.source}\nPhysical pages: ${first}–${last} of ${doc.count}\n${format === 'image' ? `Images are in source-page order; long side at most ${args.resolution === 'high' ? 3200 : 2000} pixels. Do not infer unreadable fine print.` : `Attached PDF page 1 is original physical page ${first}. Native PDF model/provider support is required.`}`, metadata: { source_id: doc.id, first_page: first, last_page: last, attachment_bytes: total }, attachments }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  },
})

export const search = tool({
  description: 'Search PDF text locally in a physical page range or the whole document. Returns bounded matching-page excerpts, one hit per page, plus a continuation cursor. Literal case-insensitive phrase search; no regex, semantic search, or OCR. Never returns the full text cache or attaches the source.',
  args: {
    filePath: filePathArg(),
    query: tool.schema.string().min(1).max(200).describe('Literal phrase; whitespace and common line-end hyphenation are tolerated.'),
    first_page: pageArg().optional().describe('First physical page to search; default 1.'),
    last_page: pageArg().optional().describe('Last physical page to search, inclusive; default last document page.'),
    max_results: tool.schema.number().int().min(1).max(20).optional().describe('Maximum matching pages returned; default 10.'),
    cursor: tool.schema.string().optional().describe('Returned next_cursor. Keep source, query and page range unchanged.'),
  },
  async execute(args, context) {
    if (!args.query?.trim() || args.query.length > 200) throw new Error('query must contain 1–200 characters of text.')
    const limit = integer(args.max_results ?? 10, 1, 20, 'max_results')
    const pattern = phrasePattern(args.query)
    const doc = await openDocument(args.filePath, context, 'pdf_search')
    const first = args.first_page ?? 1, last = args.last_page ?? doc.count
    range(doc, first, last)
    const key = createHash('sha256').update(JSON.stringify([doc.id, args.query, first, last])).digest('hex')
    let start = first
    if (args.cursor !== undefined) {
      try {
        if (args.cursor.length > 512) throw new Error()
        const value = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'))
        if (value.key !== key) throw new Error()
        start = integer(value.page, first, last, 'cursor page')
      } catch { throw new Error('Invalid or stale cursor. Keep query/range unchanged, or restart without cursor if the PDF changed.') }
    }
    const results: { physical_page: number; page_line: number; excerpt: string; read: { first_page: number; offset: number } }[] = []
    let next = start, empty = 0, scanned = 0
    const emptySample: number[] = []
    while (next <= last && results.length < limit) {
      const batchFirst = next
      const end = Math.min(last, next + BATCH_PAGES - 1)
      const texts = await pageTexts(doc, next, end, context.abort)
      for (let i = 0; i < texts.length && results.length < limit; i++) {
        context.abort.throwIfAborted()
        const page = batchFirst + i, text = texts[i]
        next = page + 1; scanned++
        if (!text.trim()) { empty++; if (emptySample.length < 20) emptySample.push(page) }
        // Match the display representation so locations work directly in pdf_read.
        const display = displayLines(text).join('\n')
        const match = pattern.exec(display)
        if (!match) continue
        const line = display.slice(0, match.index).split('\n').length
        const begin = Math.max(0, match.index - 100)
        const excerpt = display.slice(begin, begin + 400)
        results.push({ physical_page: page, page_line: line, excerpt: (begin ? '…' : '') + excerpt + (begin + 400 < display.length ? '…' : ''), read: { first_page: page, offset: Math.max(1, line - 3) } })
      }
      // Allow cancellation even on fully cached document searches.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    await doc.unchanged()
    const nextCursor = next <= last ? Buffer.from(JSON.stringify({ key, page: next })).toString('base64url') : null
    return { title: `Search PDF: ${args.query}`, output: JSON.stringify({ source: doc.source, source_id: doc.id, query: args.query, source_page_count: doc.count, requested_range: [first, last], scanned_this_call: [start, next - 1], results, next_cursor: nextCursor, coverage_this_call: { pages_checked: scanned, pages_without_text: empty, empty_page_sample: emptySample }, warnings: ['Text search cannot establish absence from diagrams or scans, even when a page has a text footer. No OCR.', ...(nextCursor ? ['Search stopped at the result limit; continue to check remaining pages.'] : [])] }, null, 2), metadata: { source_id: doc.id, next_cursor: nextCursor } }
  },
})
