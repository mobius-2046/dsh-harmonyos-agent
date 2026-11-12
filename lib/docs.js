/**
 * Offline HarmonyOS knowledge: search a docs checkout, read a section, and ask
 * the SDK type definitions which API level introduced a symbol.
 *
 * Why not an index: the reference docs are ~5k Markdown files and ~6 GB with
 * images. Building an inverted index costs more than the occasional search,
 * and would go stale the moment the checkout is updated. Instead every call
 * walks the tree under hard bounds (files, bytes, deadline) and says how much
 * it actually looked at — a partial answer stated as partial beats a silent
 * "not found".
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const SKIP_DIRS = new Set(['.git', '.gitcode', 'node_modules', 'oh_modules', 'figures', 'figures_en', 'image', 'images', 'docker'])

export const SEARCH_DEFAULTS = { limit: 5, maxFiles: 4000, maxBytes: 64 * 1024 * 1024, perFileBytes: 1024 * 1024, deadlineMs: 10_000 }

/**
 * Markdown files under `dir`, breadth-first, skipping asset and VCS folders.
 *
 * @param {string} dir root.
 * @param {{ maxFiles?: number }} [options]
 * @returns {string[]} absolute paths, in walk order.
 */
export function listMarkdown(dir, options = {}) {
  const maxFiles = options.maxFiles ?? SEARCH_DEFAULTS.maxFiles
  const out = []
  const queue = [dir]
  while (queue.length > 0 && out.length < maxFiles) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(full)
      }
    }
  }
  return out
}

/** Last ATX heading before `index`, used to tell the reader where a hit sits. */
function headingBefore(lines, index) {
  for (let i = index; i >= 0 && i > index - 400; i -= 1) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i])
    if (match) return match[1]
  }
  return ''
}

/**
 * Case-insensitive substring search across Markdown docs.
 *
 * @param {{ dirs: string[], query: string, limit?: number, maxFiles?: number, maxBytes?: number, deadlineMs?: number }} input
 * @returns {{ hits: object[], scannedFiles: number, scannedBytes: number, stopped: 'done'|'deadline'|'budget'|'limit' }}
 */
export function searchDocs(input) {
  const limit = input.limit ?? SEARCH_DEFAULTS.limit
  const maxFiles = input.maxFiles ?? SEARCH_DEFAULTS.maxFiles
  const maxBytes = input.maxBytes ?? SEARCH_DEFAULTS.maxBytes
  const deadline = Date.now() + (input.deadlineMs ?? SEARCH_DEFAULTS.deadlineMs)
  const needle = input.query.trim().toLowerCase()
  const hits = []
  let scannedFiles = 0
  let scannedBytes = 0
  let stopped = 'done'

  if (needle === '') return { hits, scannedFiles, scannedBytes, stopped }

  outer: for (const dir of input.dirs) {
    if (!existsSync(dir)) continue
    for (const file of listMarkdown(dir, { maxFiles })) {
      if (scannedFiles >= maxFiles) { stopped = 'budget'; break outer }
      if (Date.now() > deadline) { stopped = 'deadline'; break outer }
      if (scannedBytes >= maxBytes) { stopped = 'budget'; break outer }
      let size
      try {
        size = statSync(file).size
      } catch {
        continue
      }
      if (size > SEARCH_DEFAULTS.perFileBytes) continue
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      scannedFiles += 1
      scannedBytes += size
      if (!text.toLowerCase().includes(needle)) continue
      const lines = text.split(/\r?\n/)
      let inFile = 0
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].toLowerCase().includes(needle)) continue
        // Index pages ("website.md") mention hundreds of API names in a row and
        // would otherwise eat the whole result list; two hits per file keeps
        // results diverse without hiding a second real mention.
        if (inFile >= 2) break
        inFile += 1
        const start = Math.max(0, i - 1)
        const end = Math.min(lines.length, i + 2)
        hits.push({
          file,
          line: i + 1,
          heading: headingBefore(lines, i),
          snippet: lines.slice(start, end).map((line) => line.trim().slice(0, 220)).join('\n'),
        })
        if (hits.length >= limit) { stopped = 'limit'; break outer }
      }
    }
  }
  return { hits, scannedFiles, scannedBytes, stopped }
}

/** Reject `..` traversal: a read is only allowed inside a configured root. */
export function insideRoots(file, dirs) {
  const target = resolve(file)
  return dirs.some((dir) => {
    const root = resolve(dir)
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  })
}

/**
 * Read one window of a Markdown file.
 *
 * @param {{ file: string, dirs: string[], line?: number, context?: number }} input
 * @returns {{ file: string, start: number, end: number, heading: string, text: string }}
 */
export function readDoc(input) {
  if (!insideRoots(input.file, input.dirs)) throw new Error(`文件不在已配置的文档目录里：${input.file}`)
  const context = Math.min(Math.max(input.context ?? 40, 5), 400)
  const all = readFileSync(input.file, 'utf8').split(/\r?\n/)
  const anchor = Number.isFinite(input.line) ? Math.min(Math.max(1, input.line), all.length) : 1
  const start = Math.max(0, anchor - 1 - Math.floor(context / 2))
  const end = Math.min(all.length, start + context)
  return {
    file: input.file,
    start: start + 1,
    end,
    heading: headingBefore(all, start),
    text: all.slice(start, end).join('\n'),
  }
}

/**
 * Which API level introduced `symbol`, according to the SDK's own d.ts files.
 *
 * The `@since` tag is the only authoritative source shipped offline; the tag
 * sits a few lines above the declaration, so the search walks upward a bounded
 * distance.
 *
 * @param {{ sdkRoot: string, symbol: string }} input
 * @returns {object|null} hit with file, line, since, deprecated, declaration.
 */
export function lookupApi(input) {
  const symbol = input.symbol.trim()
  if (!input.sdkRoot || !existsSync(input.sdkRoot) || symbol === '') return null
  const files = readdirSync(input.sdkRoot).filter((name) => name.endsWith('.d.ts'))
  const declaration = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:function|interface|class|namespace|const|let|type|enum)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  for (const name of files) {
    const file = join(input.sdkRoot, name)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (!declaration.test(lines[i])) continue
      let since = ''
      let deprecated = false
      for (let j = i; j >= Math.max(0, i - 60); j -= 1) {
        if (!since) {
          const match = /@since\s+(\S+)/.exec(lines[j])
          if (match) since = match[1]
        }
        if (/@deprecated/.test(lines[j])) deprecated = true
        if (/^\s*\/\*\*/.test(lines[j])) break
      }
      return { file, line: i + 1, since: since || 'unknown', deprecated, declaration: lines[i].trim().slice(0, 200) }
    }
  }
  return null
}
