import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Directories that never hold first-party source. */
const SKIP_DIRS = new Set(['node_modules', 'oh_modules', 'build', '.hvigor', '.git', '.preview', 'hvigor', 'ohpm'])

/**
 * API level a build targets, from `build-profile.json5`.
 *
 * The field is written either as `compileSdkVersion: 20` or as
 * `"5.0.0(20)"`, and the parenthesised form is the one DevEco writes. Only
 * `compileSdkVersion` matters for "which API can I call": `compatibleSdkVersion`
 * is the floor for devices, not the ceiling for the compiler.
 *
 * @param {string} text build-profile.json5 contents.
 * @returns {{ compile: number|null, compatible: number|null }} parsed levels.
 */
export function apiLevels(text) {
  const pick = (key) => {
    // The key itself is quoted in JSON5, so the closing quote sits between the
    // name and the colon: `"compileSdkVersion": 20`.
    const match = new RegExp(`${key}"?\\s*:\\s*"?([^",\\n}]+)"?`).exec(text ?? '')
    if (!match) return null
    const value = match[1].trim()
    const paren = /\((\d+)\)/.exec(value)
    if (paren) return Number(paren[1])
    const plain = /^(\d+)$/.exec(value)
    return plain ? Number(plain[1]) : null
  }
  return { compile: pick('compileSdkVersion'), compatible: pick('compatibleSdkVersion') }
}

/**
 * Imports of `@ohos.*` / `@kit.*` modules, with the line they appear on.
 * @param {string} source file contents.
 * @returns {Array<{ specifier: string, line: number }>} module references.
 */
export function extractApiImports(source) {
  const found = []
  const lines = (source ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const pattern = /from\s+['"](@ohos\.[A-Za-z0-9_.]+|@kit\.[A-Za-z0-9_]+)['"]/g
    let match
    while ((match = pattern.exec(lines[i])) !== null) {
      found.push({ specifier: match[1], line: i + 1, text: lines[i].trim().slice(0, 140) })
    }
  }
  return found
}

/**
 * The `@since` that belongs to a module declaration file.
 *
 * A `@ohos.*.d.ts` starts with a doc block that carries the module's own
 * `@since`; declarations inside carry theirs. The module-level one answers
 * "can I import this at all", which is the question an import asks.
 * @param {string} text d.ts contents.
 * @returns {string} version, or `unknown`.
 */
export function moduleSince(text) {
  // 60 lines covers the licence header, which every d.ts carries before its doc.
  const lines = (text ?? '').split(/\r?\n/).slice(0, 60)
  for (const line of lines) {
    const match = /@since\s+([0-9]+)/.exec(line)
    if (match) return match[1]
  }
  return 'unknown'
}

/**
 * Walk a project for first-party ArkTS/TypeScript sources.
 * @param {string} root project root.
 * @param {{ maxFiles?: number, maxDepth?: number }} [options] limits.
 * @returns {string[]} absolute file paths.
 */
export function listSources(root, options = {}) {
  const maxFiles = options.maxFiles ?? 1500
  const maxDepth = options.maxDepth ?? 8
  const files = []
  const walk = (dir, depth) => {
    if (files.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
      } else if (/\.(ets|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(full)
      }
    }
  }
  walk(root, 0)
  return files
}

/**
 * Compare the imports a project uses against the API level it compiles for.
 *
 * This is a coarse check by design: it reports the module's own `@since`, not
 * each symbol's. That is enough to catch "this project is API 20 but imports a
 * module that arrived in 22", which is otherwise a build error whose text does
 * not name the version.
 *
 * @param {{ sdkRoot: string, kitsRoot?: string, target: number, files: string[], root?: string }} input
 * @returns {{ target: number, checked: number, imports: Array<object>, over: Array<object>, unknown: string[] }}
 */
export function checkApiCompat(input) {
  const imports = []
  const unknown = []
  const cache = new Map()
  for (const file of input.files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const hit of extractApiImports(text)) {
      const key = hit.specifier
      if (!cache.has(key)) {
        const since = sinceOf(key, input)
        cache.set(key, since)
      }
      const since = cache.get(key)
      if (since === 'unknown') {
        if (!unknown.includes(key)) unknown.push(key)
      }
      imports.push({
        specifier: key,
        since,
        file: input.root ? file.slice(input.root.length + 1).replaceAll('\\', '/') : basename(file),
        line: hit.line,
      })
    }
  }
  const over = imports.filter((entry) => entry.since !== 'unknown' && Number(entry.since) > input.target)
  return { target: input.target, checked: input.files.length, imports, over, unknown }
}

/**
 * Resolve one `@ohos.*` / `@kit.*` specifier to the API level it needs.
 * @param {string} specifier import specifier.
 * @param {{ sdkRoot: string, kitsRoot?: string }} input roots.
 * @returns {string} version, or `unknown`.
 */
export function sinceOf(specifier, input) {
  const moduleFile = join(input.sdkRoot, `${specifier}.d.ts`)
  if (existsSync(moduleFile)) {
    try {
      return moduleSince(readFileSync(moduleFile, 'utf8'))
    } catch {
      return 'unknown'
    }
  }
  if (specifier.startsWith('@kit.')) {
    const kitsRoot = input.kitsRoot ?? join(input.sdkRoot, '..', 'kits')
    const kitFile = join(kitsRoot, `${specifier}.d.ts`)
    if (existsSync(kitFile)) {
      try {
        const text = readFileSync(kitFile, 'utf8')
        // Kit files carry no @since of their own: they re-export modules. The kit
        // is only as old as the newest module it exposes, so resolve each
        // `@ohos.*` it mentions and take the highest version.
        const referenced = [...new Set([...text.matchAll(/@ohos\.[A-Za-z0-9_.]+/g)].map((match) => match[0]))]
        const versions = referenced
          .map((name) => Number(sinceOf(name, input)))
          .filter((value) => Number.isFinite(value))
        return versions.length > 0 ? String(Math.max(...versions)) : 'unknown'
      } catch {
        return 'unknown'
      }
    }
  }
  return 'unknown'
}

/**
 * Render the compat report as the lines a tool reply shows.
 * @param {ReturnType<typeof checkApiCompat>} report compat report.
 * @returns {string[]} lines.
 */
export function formatApiCompat(report) {
  const lines = []
  lines.push(`API 兼容检查：目标 API ${report.target}，扫了 ${report.checked} 个源文件，${report.imports.length} 处 @ohos / @kit 导入`)
  if (report.over.length === 0) {
    lines.push('没有超过目标版本的导入。')
  } else {
    const seen = new Set()
    lines.push(`超过目标 API 的导入（${report.over.length} 处）：`)
    for (const entry of report.over) {
      const key = `${entry.specifier}|${entry.file}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`- ${entry.specifier}（@since ${entry.since}） ${entry.file}:${entry.line}`)
    }
  }
  if (report.unknown.length > 0) {
    lines.push(`SDK 里查不到版本的导入：${report.unknown.join('、')}`)
  }
  return lines
}

/**
 * Is a directory a usable SDK api root?
 * @param {string} dir candidate path.
 * @returns {boolean} true when it holds `@ohos.*.d.ts` files.
 */
export function isApiRoot(dir) {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).some((name) => name.startsWith('@ohos.') && name.endsWith('.d.ts'))
  } catch {
    return false
  }
}
