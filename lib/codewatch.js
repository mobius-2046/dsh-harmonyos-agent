/**
 * Read-only project browsing: what a developer needs when they want to confirm
 * "what does this handler actually do" without leaving the chat.
 *
 * Everything here is deliberately dumb: no parser, no index file, no watching.
 * The page exists to save an IDE round trip for reading, not to replace one.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** Directories that never help a reader and can be huge. */
const SKIP_DIRS = new Set([
  '.git', '.hg', '.idea', '.vscode', '.hvigor', 'node_modules', 'oh_modules',
  'build', 'dist', 'hvigor', '.gradle', '.cache', '__pycache__',
])

const SOURCE_EXTENSIONS = new Set(['.ets', '.ts', '.tsx', '.js', '.json', '.json5', '.md'])

/**
 * Resolve a path inside the project root, refusing anything that escapes it.
 * @param {string} root project root.
 * @param {string} rel user supplied relative path.
 * @returns {string | null} absolute path, or null when it escapes the root.
 */
export function insideRoot(root, rel) {
  const base = resolve(root)
  const target = resolve(base, String(rel ?? ''))
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/**
 * Walk the project and return readable files plus the directories on the way.
 * @param {string} root project root.
 * @param {{ maxEntries?: number, maxDepth?: number }} [options] limits.
 * @returns {{ root: string, entries: Array<{ path: string, name: string, dir: boolean, size: number }>, truncated: boolean }}
 */
export function listTree(root, options = {}) {
  const maxEntries = options.maxEntries ?? 3000
  const maxDepth = options.maxDepth ?? 10
  const base = resolve(root)
  const entries = []
  let truncated = false

  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    names.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const item of names) {
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      if (item.name.startsWith('.') && item.name !== '.gitignore') continue
      const full = join(dir, item.name)
      const rel = relative(base, full).split(sep).join('/')
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue
        entries.push({ path: rel, name: item.name, dir: true, size: 0 })
        walk(full, depth + 1)
        continue
      }
      if (!item.isFile()) continue
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      entries.push({ path: rel, name: item.name, dir: false, size })
    }
  }

  walk(base, 0)
  return { root: base, entries, truncated }
}

/**
 * Read one text file, capped so a stray 40 MB log cannot land in the browser.
 * @param {string} root project root.
 * @param {string} rel relative path inside the project.
 * @param {{ maxBytes?: number }} [options] size cap.
 * @returns {{ ok: boolean, path?: string, text?: string, bytes?: number, truncated?: boolean, error?: string }}
 */
export function readSource(root, rel, options = {}) {
  const maxBytes = options.maxBytes ?? 200_000
  const target = insideRoot(root, rel)
  if (target === null) return { ok: false, error: '路径越界：只能读工程目录里的文件' }
  let stat
  try {
    stat = statSync(target)
  } catch {
    return { ok: false, error: `没有这个文件：${rel}` }
  }
  if (stat.isDirectory()) return { ok: false, error: '这是目录，不是文件' }
  if (!SOURCE_EXTENSIONS.has(target.slice(target.lastIndexOf('.')).toLowerCase())) {
    return { ok: false, error: `不预览这种文件（${target.slice(target.lastIndexOf('.')).toLowerCase()}），只预览源码和文本` }
  }
  const buffer = readFileSync(target)
  const truncated = buffer.length > maxBytes
  const text = buffer.subarray(0, maxBytes).toString('utf8')
  return { ok: true, path: rel, text, bytes: buffer.length, truncated }
}

/** Declaration shapes worth jumping to. */
const SYMBOL_PATTERNS = [
  { kind: 'struct', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?struct\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'enum', re: /^\s*(?:export\s+)?enum\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
]

/**
 * Find declarations by name substring. Linear scan of source files, capped.
 * @param {string} root project root.
 * @param {string} query case-insensitive substring of the symbol name.
 * @param {{ maxFiles?: number, maxResults?: number }} [options] scan limits.
 * @returns {{ results: Array<{ file: string, line: number, kind: string, name: string }>, scanned: number, truncated: boolean }}
 */
export function findSymbols(root, query, options = {}) {
  const maxFiles = options.maxFiles ?? 1500
  const maxResults = options.maxResults ?? 60
  const needle = String(query ?? '').trim().toLowerCase()
  const results = []
  let scanned = 0
  let truncated = false
  if (needle === '') return { results, scanned, truncated }

  const { entries } = listTree(root, { maxEntries: 20000 })
  for (const entry of entries) {
    if (entry.dir) continue
    const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
    if (ext !== '.ets' && ext !== '.ts' && ext !== '.tsx') continue
    if (scanned >= maxFiles) {
      truncated = true
      break
    }
    scanned += 1
    let text
    try {
      text = readFileSync(join(resolve(root), entry.path), 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.includes('struct') && !line.includes('class') && !line.includes('interface') && !line.includes('enum') && !line.includes('function') && !line.includes('const ')) continue
      for (const { kind, re } of SYMBOL_PATTERNS) {
        const match = re.exec(line)
        if (match === null) continue
        const name = match.groups?.name ?? ''
        if (!name.toLowerCase().includes(needle)) continue
        results.push({ file: entry.path, line: index + 1, kind, name })
        break
      }
      if (results.length >= maxResults) {
        truncated = true
        break
      }
    }
    if (results.length >= maxResults) break
  }
  return { results, scanned, truncated }
}
