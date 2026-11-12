import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'
import { runCommand } from './exec.js'
import { collectDevicesInfo } from './deviceinfo.js'
import { createBudget } from './budget.js'
import { waitUntil } from './wait.js'
import { listMarkdown, lookupApi, readDoc, searchDocs } from './docs.js'
import { explain } from './errorcodes.js'
import { readSettings, resolveKnowledge, settingsPath, writeSettings } from './settings.js'
import { acquireBuildLock, describeHolder, releaseBuildLock } from './lock.js'
import { attributeFailure } from './attribute.js'
import { signingReport } from './signing.js'
import { getLastDevice, setLastDevice } from './selection.js'
import {
  canIsolateHvigorHome,
  findHaps,
  findProject,
  resolveHdc,
  resolveHvigorw,
  resolveOhpm,
  toolchainEnv,
} from './locate.js'

const MAX_ERRORS = 12

/** Read a file, treating "missing" and "unreadable" the same. */
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Best-effort parse of hvigor output into structured entries.
 *
 * The shapes handled here come from real hvigor output:
 *   `> hvigor ERROR: 00304004 Not Found`
 *   `Error Message: Hvigor config file ... does not exist.`
 *   `* Try the following:` followed by `  > ...` hint lines
 * plus `path:line:column` references, which is how ArkTS reports the source
 * position of a diagnostics entry.
 *
 * @param {string[]} lines merged output.
 * @returns {{ errors: Array<Record<string, string|number>>, hints: string[] }}
 */
export function parseHvigorOutput(lines) {
  const errors = []
  const hints = []
  let pending

  for (let index = 0; index < lines.length; index += 1) {
    // ANSI SGR codes can prefix any line; exec.js strips them, this keeps the
    // parser correct for callers that pass raw output.
    const line = lines[index].replace(/\u001b\[[0-9;]*m/g, '').trimEnd()
    const trimmed = line.trim()

    if (/^\* Try the following/i.test(trimmed)) {
      pending = undefined
      for (const later of lines.slice(index + 1)) {
        const hint = /^>\s*(.+)$/.exec(later.trim())
        if (hint) hints.push(hint[1])
        else if (later.trim() !== '') break
      }
      continue
    }

    const hvigor = /^>\s*hvigor ERROR:\s*(?:(\d{6,8})\s+)?(.*)$/i.exec(trimmed)
    if (hvigor) {
      pending = { source: 'hvigor', code: hvigor[1] ?? '', message: hvigor[2] }
      errors.push(pending)
      continue
    }

    const detail = /^Error Message:\s*(.*)$/i.exec(trimmed)
    if (detail) {
      if (pending && pending.message === '') pending.message = detail[1]
      else if (pending) pending.detail = detail[1]
      else errors.push({ source: 'hvigor', code: '', message: detail[1] })
      continue
    }
  }

  // `path:line:column` positions reported next to an error keyword.
  const seen = new Set(errors.map((e) => `${e.message}|${e.detail ?? ''}`))
  for (const raw of lines) {
    if (!/error/i.test(raw)) continue
    const match = /((?:[A-Za-z]:)?[^\s"']*?\.(?:ets|ts|tsx|js|json5?)):(\d+):(\d+)/.exec(raw)
    if (!match) continue
    const key = `${match[1]}:${match[2]}:${match[3]}`
    if (seen.has(key)) continue
    seen.add(key)
    errors.push({ source: 'arkts', code: '', message: raw.trim(), file: match[1], line: Number(match[2]), column: Number(match[3]) })
  }

  return { errors: errors.slice(0, MAX_ERRORS), hints: hints.slice(0, 8) }
}

/**
 * Lines that ohpm / hdc / npm print instead of the hvigor `ERROR:` shape.
 * Without these a failed `ohpm install` or `hdc install` came back with an
 * empty `errors` array, and the model was left guessing from the tail.
 */
const FOREIGN_ERRORS = [
  { source: 'ohpm', test: (line) => /^(?:ohpm\s+)?(?:ERROR|Error)[:\s]/.test(line) },
  { source: 'ohpm', test: (line) => /^(?:npm\s+)?ERR!/.test(line) },
  { source: 'hdc', test: (line) => /^\[Fail\]/i.test(line) },
  { source: 'hdc', test: (line) => /^(?:error|Error):\s*(?:failed to install|device (?:not found|offline)|no devices?)/i.test(line) },
]

/**
 * Parse merged tool output: hvigor diagnostics plus the ohpm/hdc error shapes.
 * @param {string[]} lines merged stdout/stderr lines.
 * @returns {{ errors: Array<Record<string, string|number>>, hints: string[] }}
 */
export function parseOutput(lines) {
  const base = parseHvigorOutput(lines)
  const errors = [...base.errors]
  const seen = new Set(errors.map((e) => e.message))

  for (const raw of lines) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim()
    if (line === '') continue
    const hit = FOREIGN_ERRORS.find((pattern) => pattern.test(line))
    if (!hit || seen.has(line)) continue
    seen.add(line)
    errors.push({ source: hit.source, code: '', message: line })
    if (errors.length >= MAX_ERRORS) break
  }

  return { errors, hints: base.hints }
}

/**
 * Format parsed errors for a tool result.
 * @param {Array<Record<string, string|number>>} errors parsed entries.
 * @returns {string}
 */
function formatErrors(errors) {
  return errors.map((error) => {
    const where = error.file ? ` (${error.file}:${error.line}:${error.column})` : ''
    const code = error.code ? `[${error.code}] ` : ''
    const detail = error.detail ? `\n    ${error.detail}` : ''
    return `- ${code}${error.message}${where}${detail}`
  }).join('\n')
}

/**
 * The session working directory, falling back to the process directory.
 * @param {object} ctx plugin context.
 * @param {object} exec tool execution context.
 * @returns {string}
 */
function workingDir(ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session) return ctx.workingDirectory.get(session)
  } catch {}
  return process.cwd()
}

/**
 * Resolve the project root from an explicit path or the session directory.
 * @param {object} ctx plugin context.
 * @param {object} exec tool execution context.
 * @param {string|undefined} explicit caller-supplied path.
 * @returns {string}
 */
function projectRoot(ctx, exec, explicit) {
  const start = explicit ? resolve(explicit) : workingDir(ctx, exec)
  const found = findProject(start)
  if (!found) {
    throw new Error(`不是 HarmonyOS 工程：从 ${start} 向上没有找到 build-profile.json5。请传 projectDir，或在工程目录内运行。`)
  }
  return found
}

/**
 * Wrap a property map into the object-root JSON Schema the registry sends to
 * the model provider verbatim.
 *
 * `ctx.tools.register()` does not apply `defineTool`'s authoring DSL; a raw
 * registration's `parameters` is already expected to be JSON Schema. Emitting
 * the DSL here produced a schema without `type: "object"` and made every
 * request fail with `Invalid schema for function 'harmony_build': schema must be
 * a JSON Schema of 'type: "object"', got 'type: null'`.
 *
 * @param {Record<string, object>} properties field schemas by name.
 * @param {string[]} required names the caller must supply.
 * @returns {object} object-root JSON Schema.
 */
function objectSchema(properties, required = []) {
  // Mirrors the shape the shipped tools put on the wire: an object root, a
  // property map, and an optional string array. No `additionalProperties`,
  // since the provider's function-calling subset is narrower than full JSON
  // Schema and the built-in tools omit it.
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * Whether the project declares a usable signing configuration.
 *
 * Real HarmonyOS projects keep `signingConfigs` at the project level with a
 * `material` block (certpath / profile / storeFile). When it is missing the
 * build still succeeds but only an `-unsigned.hap` comes out, and installing
 * that on a real device fails with an opaque signature error.
 *
 * @param {string} projectDir project root.
 * @returns {{ configured: boolean|null, reason: string }}
 */
export function signingState(projectDir) {
  const text = readIfExists(join(projectDir, 'build-profile.json5'))
  if (text === '') return { configured: null, reason: '读不到 build-profile.json5' }
  const at = text.indexOf('"signingConfigs"')
  if (at < 0) return { configured: false, reason: 'build-profile.json5 没有 signingConfigs 段' }
  const slice = text.slice(at, at + 4000)
  const end = slice.indexOf(']')
  const block = end >= 0 ? slice.slice(0, end + 1) : slice
  const configured = /"(?:material|certpath|certPath|storeFile|profile)"\s*:/i.test(block)
  return { configured, reason: configured ? '已配置签名' : 'signingConfigs 为空' }
}

/** Drop JSON5 comments; build-profile.json5 keeps disabled modules commented out. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * Infer the launch target from the project's own config files.
 * Only used when the caller does not pass bundleName / ability.
 *
 * Real projects keep disabled modules commented out inside `modules`, and a
 * naive `"srcPath"` match picked `./DebugEntry` on a real project, so the
 * comments are stripped and the entry-type module is preferred by name.
 *
 * @param {string} projectDir project root.
 * @returns {{ bundleName?: string, ability?: string, moduleDir: string }}
 */
export function inferTarget(projectDir) {
  const app = stripComments(readIfExists(join(projectDir, 'AppScope', 'app.json5')))
  const bundleName = /"bundleName"\s*:\s*"([^"]+)"/.exec(app)?.[1]

  const profile = stripComments(readIfExists(join(projectDir, 'build-profile.json5')))
  const section = profile.slice(Math.max(profile.indexOf('"modules"'), 0))
  const modules = []
  for (const match of section.matchAll(/"name"\s*:\s*"([^"]+)"[\s\S]{0,200}?"srcPath"\s*:\s*"([^"]+)"/g)) {
    modules.push({ name: match[1], srcPath: match[2] })
  }
  const dir = modules.find((item) => item.name === 'entry')?.srcPath ?? modules[0]?.srcPath ?? './entry'

  const moduleJson = stripComments(readIfExists(join(projectDir, dir, 'src', 'main', 'module.json5')))
  const ability = /"mainElement"\s*:\s*"([^"]+)"/.exec(moduleJson)?.[1]
    ?? /"abilities"\s*:\s*\[[\s\S]*?"name"\s*:\s*"([^"]+)"/.exec(moduleJson)?.[1]
  return { bundleName, ability, moduleDir: dir }
}

/**
 * Ask hdc for the connected targets.
 * @param {object} exec tool execution context.
 * @returns {Promise<{ devices: Array<{ id: string }>, tail: string[] }>}
 */
/**
 * One line per device for the `devices` action: model, id, and the fields the
 * badge also shows, with every absent field skipped instead of printed empty.
 */
export function formatDeviceLine(info) {
  const parts = []
  if (typeof info.model === 'string') parts.push(info.model)
  parts.push(info.id)
  if (typeof info.apiVersion === 'number') parts.push(`API ${info.apiVersion}`)
  if (typeof info.batteryLevel === 'number') parts.push(`电量 ${info.batteryLevel}%`)
  if (typeof info.chargingStatus === 'string') {
    const status = info.chargingStatus.toLowerCase()
    parts.push(status === 'charging' ? '充电中' : (status === 'full' ? '已充满' : (status === 'discharging' ? '放电中' : info.chargingStatus)))
  }
  if (typeof info.batteryTempC === 'number') parts.push(`${info.batteryTempC}°C`)
  if (typeof info.memoryTotalMb === 'number' && typeof info.memoryAvailableMb === 'number') {
    const gb = (mb) => (mb / 1024).toFixed(1)
    parts.push(`内存 ${gb(info.memoryTotalMb - info.memoryAvailableMb)}/${gb(info.memoryTotalMb)}G`)
  }
  if (typeof info.storageUsedPercent === 'number') parts.push(`存储 ${info.storageUsedPercent}%`)
  return parts.join(' · ')
}

async function listDevices(exec, options = {}) {
  const hdc = resolveHdc()
  const result = await runCommand(hdc.command, ['list', 'targets'], { timeoutMs: options.timeoutMs ?? 30_000, signal: exec?.signal })
  const devices = []
  for (const line of result.lines) {
    const id = line.trim()
    if (id === '' || /^\[?empty\]?$/i.test(id) || /^list of/i.test(id)) continue
    devices.push({ id })
  }
  return { devices, tail: result.lines.slice(-10) }
}

/**
 * Capture a bounded hilog window, optionally filtered.
 * @param {object} exec tool execution context.
 * @param {{ device?: string, bundleName?: string, seconds?: number }} args
 * @returns {Promise<{ lines: string[], captured: number, seconds: number }>}
 */
/**
 * Filter hilog lines by a plain substring or a `/regex/` pattern.
 *
 * The tool runs on a device's raw hilog stream, where the useful line is one of
 * thousands; filtering on the host keeps the device command unchanged and lets
 * the caller re-ask with a different needle without re-capturing.
 *
 * @param {string[]} lines captured lines.
 * @param {string|undefined} filter substring, or `/regex/` for a pattern.
 * @returns {string[]} matching lines.
 */
export function filterLogLines(lines, filter) {
  const needle = String(filter ?? '').trim()
  if (!needle) return lines
  const regex = /^\/(.*)\/([gimsuy]*)$/.exec(needle)
  if (regex) {
    try {
      const pattern = new RegExp(regex[1], regex[2].includes('i') ? regex[2] : `${regex[2]}i`)
      return lines.filter((line) => pattern.test(line))
    } catch {
      // An invalid regex is more likely a plain string containing slashes.
    }
  }
  const lowered = needle.toLowerCase()
  return lines.filter((line) => line.toLowerCase().includes(lowered))
}

/**
 * Keep only the lines a single process wrote.
 *
 * hilog lines look like `11-11 09:28:48.928  2862  9973 I C015b0/NETSTACK ...`:
 * date, time, pid, tid. Continuation lines (stack traces, pretty-printed JSON)
 * have no header, so they inherit the decision of the line above — dropping
 * them would cut a stack trace in half.
 */
export function filterByPid(lines, pid) {
  const wanted = String(pid)
  const kept = []
  let keep = false
  for (const line of lines) {
    const head = line.trim().split(/\s+/)
    const isRecord = /^\d{2}-\d{2}$/.test(head[0] ?? '') && /^\d{2}:\d{2}:\d{2}/.test(head[1] ?? '')
    if (isRecord) keep = head[2] === wanted
    if (keep) kept.push(line)
  }
  return kept
}

/**
 * Resolve the pid of the running app from `ps -ef`.
 * @returns {Promise<number|undefined>} undefined when the app is not running.
 */
async function appPid(exec, device, bundleName) {
  if (!bundleName) return undefined
  const hdc = resolveHdc()
  const target = device ? ['-t', device] : []
  const result = await runCommand(hdc.command, [...target, 'shell', 'ps -ef'], {
    timeoutMs: 20_000,
    signal: exec?.signal,
  })
  for (const line of result.lines) {
    if (!line.includes(bundleName)) continue
    const fields = line.trim().split(/\s+/)
    const pid = Number(fields[1])
    if (Number.isFinite(pid) && pid > 0) return pid
  }
  return undefined
}

async function captureLogs(exec, args) {
  const hdc = resolveHdc()
  const target = args.device ? ['-t', args.device] : []
  const seconds = Math.min(Math.max(args.seconds ?? 6, 1), 60)
  const result = await runCommand(hdc.command, [...target, 'shell', 'hilog'], {
    timeoutMs: seconds * 1000,
    signal: exec?.signal,
  })
  const all = result.lines.filter((line) => line.trim() !== '')

  // A bundle name is not a hilog field, so matching it as a substring used to
  // drop most of the app's own output (its tag is the process abbreviation, not
  // the package id). Resolving the pid once and filtering the pid column keeps
  // the app's lines and removes the system noise around them.
  let pid = Number.isFinite(args.pid) ? args.pid : undefined
  let scope = 'all'
  if (!pid && args.bundleName && args.appOnly !== false) {
    pid = await appPid(exec, args.device, args.bundleName)
    scope = pid ? 'pid' : 'substring'
  } else if (pid) {
    scope = 'pid'
  }

  const scoped = pid
    ? filterByPid(all, pid)
    : args.bundleName
      ? all.filter((line) => line.toLowerCase().includes(args.bundleName.toLowerCase()))
      : all
  const matched = filterLogLines(scoped, args.filter)
  return {
    lines: matched.slice(-200),
    captured: matched.length,
    scanned: all.length,
    scopeCount: scoped.length,
    seconds,
    filter: args.filter ?? null,
    pid: pid ?? null,
    scope,
  }
}

/** Log lines that usually mean the app died or never came up. */
const CRASH_SIGNAL = /(?:FATAL|JS ERROR|jscrash|SIGSEGV|Unhandled|Error message:|cannot find module|Exception:)/i

/**
 * Screenshot one device and pull it next to the other run artifacts.
 *
 * `snapshot_display` writes a JPEG inside the device; the file is pulled and
 * the remote copy removed, because `/data/local/tmp` is shared by every app on
 * the device and stale shots are indistinguishable from fresh ones later.
 *
 * @param {object} exec tool execution context.
 * @param {{ device: string, label?: string }} args
 * @returns {Promise<{ ok: boolean, path: string|null, width?: number, height?: number, tail: string[] }>}
 */
async function captureScreenshot(exec, { device, label }) {
  const hdc = resolveHdc()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const remote = `/data/local/tmp/harmony-${stamp}.jpeg`
  const shot = await runCommand(hdc.command, ['-t', device, 'shell', `snapshot_display -f ${remote}`], {
    timeoutMs: 30_000,
    signal: exec?.signal,
  })
  const text = shot.lines.join('\n')
  const size = /width:\s*(\d+),\s*height:\s*(\d+)/.exec(text)
  const dir = join(tmpdir(), 'dsh-harmony-shots')
  mkdirSync(dir, { recursive: true })
  const local = join(dir, `${(label || device).replace(/[^\w.-]+/g, '_')}-${stamp}.jpeg`)
  const pull = await runCommand(hdc.command, ['-t', device, 'file', 'recv', remote, local], {
    timeoutMs: 60_000,
    signal: exec?.signal,
  })
  await runCommand(hdc.command, ['-t', device, 'shell', `rm -f ${remote}`], { timeoutMs: 15_000, signal: exec?.signal })
  const ok = /success/i.test(text) && existsSync(local)
  return { ok, path: ok ? local : null, width: size ? Number(size[1]) : undefined, height: size ? Number(size[2]) : undefined, tail: pull.lines.slice(-5) }
}

/**
 * Start, stop, clear data or uninstall one app.
 *
 * @param {object} exec tool execution context.
 * @param {{ device: string, op: string, bundleName: string, ability?: string }} args
 * @returns {Promise<{ ok: boolean, commandLine: string, tail: string[] }>}
 */
async function controlApp(exec, { device, op, bundleName, ability }) {
  const hdc = resolveHdc()
  const shell = {
    start: ability ? `aa start -a ${ability} -b ${bundleName}` : `aa start -b ${bundleName}`,
    stop: `aa force-stop ${bundleName}`,
    clear: `bm clean -d -n ${bundleName}`,
    uninstall: `bm uninstall -n ${bundleName}`,
  }[op]
  if (!shell) throw new Error(`unsupported app operation: ${op}`)
  const run = await runCommand(hdc.command, ['-t', device, 'shell', shell], { timeoutMs: 60_000, signal: exec?.signal })
  const text = run.lines.join('\n')
  // `bm`/`aa` report failures in the text, not always in the exit code.
  const ok = run.exitCode === 0 && !/error|fail|not found/i.test(text)
  return { ok, commandLine: `hdc -t ${device} shell ${shell}`, tail: run.lines.slice(-6) }
}

/**
 * Pull the current UI tree from a device.
 *
 * `uitest dumpLayout` writes JSON on the device; reading it back with `cat`
 * avoids a `file recv` round trip and leaves nothing to clean up if the pull
 * fails halfway.
 *
 * @param {object} exec tool execution context.
 * @param {string} device target id.
 * @returns {Promise<object|null>} parsed tree, or null when the dump failed.
 */
async function dumpUiTree(exec, device) {
  const hdc = resolveHdc().command
  const remote = `/data/local/tmp/harmony-ui-${Date.now()}.json`
  const dump = await runCommand(hdc, ['-t', device, 'shell', 'uitest', 'dumpLayout', '-p', remote], { timeoutMs: 60_000, signal: exec?.signal })
  if (dump.exitCode !== 0) return null
  const cat = await runCommand(hdc, ['-t', device, 'shell', 'cat', remote], { timeoutMs: 60_000, signal: exec?.signal })
  await runCommand(hdc, ['-t', device, 'shell', 'rm', '-f', remote], { timeoutMs: 30_000, signal: exec?.signal }).catch(() => {})
  const text = cat.lines.join('\n')
  const start = text.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

/** Parse a `[x1,y1][x2,y2]` bounds string into a rect. */
export function parseBounds(bounds) {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String(bounds ?? ''))
  if (!match) return null
  const [x1, y1, x2, y2] = match.slice(1).map(Number)
  return { x1, y1, x2, y2, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
}

/**
 * Flatten the UI tree into the lines a model can actually read.
 *
 * Only nodes with text or a click handler are kept: the raw tree is ~20k JSON
 * characters where most nodes are layout containers with empty attributes.
 *
 * @param {object} node root node.
 * @param {number} depth current depth.
 * @param {object[]} out accumulator.
 * @returns {object[]} flat nodes.
 */
export function flattenUi(node, depth = 0, out = []) {
  const attributes = node?.attributes ?? {}
  const text = String(attributes.text || attributes.originalText || attributes.description || '').trim()
  const clickable = attributes.clickable === 'true'
  if (text || clickable) {
    out.push({
      depth,
      text,
      type: String(attributes.type || ''),
      clickable,
      id: String(attributes.id || ''),
      visible: attributes.visible !== 'false',
      bounds: parseBounds(attributes.bounds),
      rawBounds: String(attributes.bounds || ''),
    })
  }
  for (const child of node?.children ?? []) flattenUi(child, depth + 1, out)
  return out
}

/** uitest prints "No Error" when the gesture lands; that is a success message. */
function uiOutput(run) {
  return run.lines.join('\n').replace(/No Error/gi, '')
}

function formatUiNode(node) {
  const indent = '  '.repeat(Math.min(node.depth, 8))
  const label = node.text ? ` "${node.text}"` : ''
  const click = node.clickable ? ' ·可点' : ''
  return `${indent}${node.type}${label}${click} ${node.rawBounds}`
}

export function findUiNode(nodes, query) {
  const needle = String(query).trim().toLowerCase()
  if (!needle) return null
  const withBounds = nodes.filter((node) => node.bounds)
  return (
    withBounds.find((node) => node.text.toLowerCase() === needle && node.clickable) ??
    withBounds.find((node) => node.text.toLowerCase() === needle) ??
    withBounds.find((node) => node.text.toLowerCase().includes(needle) && node.clickable) ??
    withBounds.find((node) => node.text.toLowerCase().includes(needle)) ??
    null
  )
}

/**
 * Every visible node whose text contains `query`, for read-only inspection.
 * Exact matches come first, then clickable ones, so the tap target is [0].
 *
 * @param {object[]} nodes flattened UI nodes.
 * @param {string} query text hint.
 * @returns {object[]} matches, best first.
 */
export function findUiNodes(nodes, query) {
  const needle = String(query).trim().toLowerCase()
  if (!needle) return []
  const hits = nodes.filter((node) => node.bounds && node.text && node.text.toLowerCase().includes(needle))
  const exact = (node) => node.text.toLowerCase() === needle
  return [...hits].sort((a, b) => Number(exact(b)) - Number(exact(a)) || Number(b.clickable) - Number(a.clickable))
}

/**
 * Signed HSPs produced under `<module>/build/**\/outputs`.
 *
 * A project split into HSP modules cannot be installed from its entry HAP
 * alone: hdc rejects it with `9568305 ... dependent module does not exist`.
 * The fix is to install the shared packages first, so a failed install retries
 * after staging them. Duplicated copies under `oh_modules` are skipped — they
 * are build inputs, not installable artifacts.
 *
 * @param {string} projectDir project root.
 * @returns {string[]} signed .hsp paths.
 */
function sharedPackages(projectDir) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 8 || found.length >= 40) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'oh_modules' || entry.name === '.git' || entry.name === '.hvigor') continue
        walk(join(dir, entry.name), depth + 1)
      } else if (/-signed\.hsp$/i.test(entry.name) && !/unsigned/i.test(entry.name)) {
        const full = join(dir, entry.name)
        if (/[\\/]outputs[\\/]/i.test(full) && !found.includes(full)) found.push(full)
      }
    }
  }
  walk(projectDir, 0)
  return found
}

/**
 * Names of modules declared as `type: "shared"` in the project.
 *
 * A shared module with no signed `.hsp` on disk is the real reason behind an
 * opaque `9568305 dependent module does not exist` at install time: the device
 * asks for a module nobody built. `assembleHsp` silently skips such modules
 * when it is interrupted (for example by a concurrent DevEco build), so the
 * build result should say which ones are missing instead of letting the
 * install failure look like a device problem.
 *
 * @param {string} projectDir project root.
 * @returns {string[]} shared module names.
 */
function declaredSharedModules(projectDir) {
  const text = readIfExists(join(projectDir, 'build-profile.json5'))
  if (!text) return []
  const clean = stripComments(text)
  const names = []
  // Pair each "srcPath" with the "name" of the object that owns it. A forward
  // scan from "name" is wrong here: every module's targets[].name is "default",
  // so the regex would report "default" for the next module's srcPath.
  const pattern = /"srcPath"\s*:\s*"([^"]+)"/g
  let match
  while ((match = pattern.exec(clean))) {
    const srcPath = match[1]
    if (!srcPath.startsWith('./')) continue
    const ownerStart = clean.lastIndexOf('{', match.index)
    const owner = clean.slice(ownerStart === -1 ? 0 : ownerStart, match.index)
    const nameMatch = /"name"\s*:\s*"([^"]+)"/g
    let last = null
    let found
    while ((found = nameMatch.exec(owner))) last = found[1]
    if (!last || names.includes(last)) continue
    const moduleJson = readIfExists(join(projectDir, srcPath.slice(2), 'src/main/module.json5'))
    if (moduleJson && /"type"\s*:\s*"shared"/.test(moduleJson)) names.push(last)
  }
  return names
}

/**
 * Expand a device spec into concrete ids.
 *
 * No spec means "the device I used last, if it is still connected, else the
 * first one" — the memory lives in `selection.js` and is process-scoped.
 * `all` means every connected target, and a comma-separated list pins an
 * explicit set. Unknown ids are reported instead of silently dropped.
 *
 * @param {string[]} connected ids from `hdc list targets`.
 * @param {string|undefined} spec caller-supplied `device`.
 * @param {string|undefined} preferred last device the agent used successfully.
 * @returns {{ ids: string[], unknown: string[], remembered: boolean }}
 */
export function parseTargets(connected, spec, preferred) {
  if (!spec) {
    const remembered = typeof preferred === 'string' && connected.includes(preferred)
    return { ids: [remembered ? preferred : connected[0]].filter(Boolean), unknown: [], remembered }
  }
  if (String(spec).trim().toLowerCase() === 'all') return { ids: [...connected], unknown: [], remembered: false }
  const wanted = String(spec).split(/[,\s]+/).map((id) => id.trim()).filter(Boolean)
  return {
    ids: wanted.filter((id) => connected.includes(id)),
    unknown: wanted.filter((id) => !connected.includes(id)),
    remembered: false,
  }
}

async function resolveTargets(exec, spec) {
  const { devices, tail } = await listDevices(exec)
  return { ...parseTargets(devices.map((device) => device.id), spec, getLastDevice()), tail }
}

/**
 * Install one HAP on one device, staging signed HSPs when the device reports a
 * missing dependent module (9568305).
 *
 * @param {{ command: string }} hdc resolved hdc binary.
 * @param {string} device target id.
 * @param {string} hap signed .hap path.
 * @param {{ projectDir: string }} buildData result of `build()`.
 * @param {object} exec tool execution context.
 * @returns {Promise<{ installed: boolean, staged: object[], lines: string[], exitCode: number|null }>}
 */
async function installOnDevice(hdc, device, hap, buildData, exec) {
  const installArgs = ['-t', device, 'install', '-r', hap]
  let install = await runCommand(hdc.command, installArgs, { timeoutMs: 180_000, signal: exec?.signal })
  let installed = install.exitCode === 0 && install.lines.some((line) => /success/i.test(line))

  // HSP-split projects: entry alone fails with 9568305 "dependent module does
  // not exist". Stage the signed HSPs and retry the entry HAP until it
  // installs. The device reports one missing module per attempt, and a shared
  // package can depend on another, so this needs several rounds plus an
  // "already installed" set.
  const staged = []
  const stagedOk = new Set()
  if (!installed && /dependent module does not exist/i.test(install.lines.join('\n'))) {
    const hsps = sharedPackages(buildData.projectDir)
    // Each round installs whatever dependencies are already satisfied, so the
    // number of rounds needed is the dependency depth, not a fixed constant.
    for (let attempt = 0; attempt < 8 && !installed; attempt += 1) {
      let progress = false
      for (const hsp of hsps) {
        if (stagedOk.has(hsp)) continue
        const step = await runCommand(hdc.command, ['-t', device, 'install', '-r', hsp], { timeoutMs: 180_000, signal: exec?.signal })
        const ok = step.exitCode === 0 && /success/i.test(step.lines.join('\n'))
        const entry = staged.find((item) => item.hap === hsp)
        if (ok) {
          stagedOk.add(hsp)
          progress = true
          if (entry) entry.ok = true
          else staged.push({ hap: hsp, ok: true })
        } else if (!entry) {
          const firstError = step.lines.find((line) => /error|fail/i.test(line) && !/^\s*\[Info\]/i.test(line))
          staged.push({ hap: hsp, ok: false, error: firstError?.trim() ?? '' })
        }
      }
      install = await runCommand(hdc.command, installArgs, { timeoutMs: 180_000, signal: exec?.signal })
      installed = install.exitCode === 0 && install.lines.some((line) => /success/i.test(line))
      if (!progress) break
    }
  }
  if (installed) setLastDevice(device)
  return {
    installed,
    staged,
    lines: install.lines,
    exitCode: install.exitCode,
    hint: installed ? undefined : explain(install.lines),
  }
}

/**
 * Launch the app and capture a short log window on one device.
 *
 * @param {{ command: string }} hdc resolved hdc binary.
 * @param {string} device target id.
 * @param {{ bundleName?: string, ability?: string, seconds?: number, exec?: object }} options
 * @returns {Promise<{ started: boolean, startTail: string[], logs: object, signals: string[] }>}
 */
async function launchAndCapture(hdc, device, options) {
  let started = false
  let startTail = []
  if (options.bundleName && options.ability) {
    const start = await runCommand(
      hdc.command,
      ['-t', device, 'shell', 'aa', 'start', '-a', options.ability, '-b', options.bundleName],
      { timeoutMs: 60_000, signal: options.exec?.signal },
    )
    started = start.exitCode === 0 && !/error/i.test(start.lines.join('\n'))
    startTail = start.lines.slice(-8)
  }
  const logs = await captureLogs(options.exec, {
    device,
    bundleName: options.bundleName,
    pid: options.pid,
    appOnly: options.appOnly,
    seconds: options.seconds,
    filter: options.filter,
  })
  return { started, startTail, logs, signals: logs.lines.filter((line) => CRASH_SIGNAL.test(line)) }
}

/**
 * Build the single `harmony` tool.
 *
 * Merged from four separate tools (harmony_build / harmony_devices /
 * harmony_deploy / harmony_logs): every tool schema is re-sent on every
 * request, and the four were mostly the same vocabulary, so one entry point
 * with an `action` keeps the surface small while still exposing every step.
 *
 * @param {object} ctx plugin context.
 * @returns {object[]}
 */
/**
 * Pick the readable fields out of a faultlogger report. The format is stable
 * enough across API versions to look for labelled lines rather than positions.
 * @param {string} text report body.
 * @returns {{ process: string|null, reason: string|null, timestamp: string|null, frames: string[] }}
 */
export function parseFaultLog(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const pick = (label) => {
    const line = lines.find((entry) => new RegExp(`^${label}\\s*:`, 'i').test(entry.trim()))
    return line ? line.replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), '').trim() : null
  }
  const frames = lines.filter((line) => /^#\d+\s+pc\s/.test(line.trim())).slice(0, 12)
  return {
    process: pick('Process name') ?? pick('Cmdline'),
    reason: pick('Reason') ?? pick('Exception type') ?? lines.find((line) => /^(SIGSEGV|SIGABRT|SIGBUS|TypeError|Error:)/.test(line.trim()))?.trim() ?? null,
    timestamp: pick('Timestamp') ?? pick('Time'),
    frames,
  }
}

export function createHarmonyTools(ctx) {
  /** @type {(args: object, exec: object) => Promise<{ ok: boolean, summary: string, data: object }>} */
  async function build(args, exec) {
    const projectDir = projectRoot(ctx, exec, args.projectDir)
    const hvigorw = resolveHvigorw(projectDir)
    const product = args.product ?? 'default'
    const mode = args.mode ?? 'debug'
    const common = ['--mode', 'module', '-p', `product=${product}`, '-p', `buildMode=${mode}`]
    const env = toolchainEnv(args.isolateHome ?? canIsolateHvigorHome())
    const signal = exec?.signal

    // Two invocations rather than one multi-task call: `-p module=` filters the
    // task scope, so a shared-module build needs its own run without that flag.
    const runs = []
    let hspMissing = []
    const startedAt = Date.now()
    // Two of our own builds against one project would interleave inside
    // `.hvigor` and leave half-written artifacts; refuse the second one instead
    // of letting it corrupt the first.
    const lock = acquireBuildLock(projectDir)
    if (!lock.ok) {
      return {
        ok: false,
        summary: `这个工程已有一个构建在进行（${describeHolder(lock.holder)}），本次没有再启动。等它结束再试；如果确定那个进程已经不在了，删掉 ${lock.path} 后重试。`,
        data: { stage: 'build-locked', lock: lock.path, holder: lock.holder },
      }
    }
    try {
    runs.push(await runCommand(hvigorw.command, [...(args.clean ? ['clean'] : []), 'assembleHap', ...common, ...(args.module ? ['-p', `module=${args.module}@default`] : []), '--no-daemon'], {
      cwd: projectDir,
      timeoutMs: args.timeoutMs ?? 600_000,
      env,
      signal,
    }))
    if (args.hsp) {
      const run = () => runCommand(hvigorw.command, ['assembleHsp', ...common, '--no-daemon'], {
        cwd: projectDir,
        timeoutMs: args.timeoutMs ?? 600_000,
        env,
        signal,
      })
      let hspRun = await run()
      // A hvigor that is already running (DevEco Studio's build or its daemon)
      // holds `.hvigor/outputs/build-logs/build.log` open. The second invocation
      // then dies with EBUSY before compiling anything, so one retry after the
      // other writer settles is the difference between "build failed" and a
      // finished HSP set.
      if (hspRun.exitCode !== 0 && hspRun.lines.some((line) => /EBUSY/.test(line))) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        hspRun = await run()
      }
      runs.push(hspRun)

      // An interrupted `assembleHsp` leaves some shared modules without an
      // artifact; the device then reports "dependent module does not exist" for
      // whatever depends on them. Say it here, where the build result is read.
      const built = new Set(sharedPackages(projectDir).map((path) => basename(path).replace(/-default-signed\.hsp$/i, '')))
      const missing = declaredSharedModules(projectDir).filter((name) => !built.has(name))
      if (missing.length) {
        hspMissing = missing
      }
    }
    } finally {
      releaseBuildLock(lock.path)
    }
    const result = {
      lines: runs.flatMap((run) => run.lines),
      exitCode: runs.find((run) => run.exitCode !== 0)?.exitCode ?? 0,
      timedOut: runs.some((run) => run.timedOut),
      durationMs: Date.now() - startedAt,
      commandLine: runs.map((run) => run.commandLine).join(' && '),
    }

    const parsed = parseOutput(result.lines)
    const hints = [...parsed.hints]
    if (result.lines.some((line) => /EPERM|operation not permitted/i.test(line))) {
      hints.push('hvigor 写不了用户目录（沙箱限制）。设 isolateHome: true 重试：它会改用隔离的 HVIGOR_USER_HOME，并从真实目录复制 pnpm；工程本身也必须在可写区域内。')
    }
    if (result.lines.some((line) => /EBUSY: resource busy or locked/i.test(line))) {
      hints.push('hvigor 的 `.hvigor/outputs/build-logs/build.log` 被另一个 hvigor 进程占用（常见于 DevEco Studio 正在构建，或它的守护进程没退）。等它结束或关掉 DevEco 里的构建后重试；本工具已自动重试过一次。')
    }
    if (/install pnpm/i.test(result.lines.join('\n'))) {
      hints.push('隔离 home 里没有可复用的 pnpm wrapper，hvigor 试图自行安装而失败（其 Windows 引导路径本身有问题）。确认真实 ~/.hvigor/wrapper/tools 存在，或改回 isolateHome: false。')
    }

    // Only artifacts this run produced: a stale .hap from an earlier build
    // would otherwise be reported as the result of a failed compile.
    const builtAt = Date.now() - result.durationMs - 2000
    const produced = findHaps(projectDir).filter((hap) => hap.modifiedMs >= builtAt)
    const artifacts = produced.map((hap) => hap.path)
    const signed = artifacts.some((path) => /signed/i.test(path) && !/unsigned/i.test(path))
    const signing = signingState(projectDir)
    if (artifacts.length > 0 && !signed) {
      hints.push(signing.configured
        ? '只产出了 unsigned HAP。检查 signingConfigs 里的 certpath/profile 是否与 bundleName 匹配。'
        : '只产出了 unsigned HAP：工程没有可用的 signingConfigs。真机安装会失败；在 DevEco Studio 的 Project Structure → Signing Configs 里勾选自动签名，再重新构建。')
    }
    if (result.lines.some((line) => /parse profile prop check error|signature verification failed/i.test(line))) {
      hints.push('签名校验失败：bundleName 必须与 .p7b profile 里的包名一致，证书与设备也要匹配。')
    }
    if (hspMissing.length > 0) {
      hints.push(`有 ${hspMissing.length} 个 shared 模块没有 signed HSP 产物：${hspMissing.join('、')}。装包时会报「dependent module does not exist」；通常是 assembleHsp 被并发构建打断，关掉 DevEco 的构建后重跑 hsp: true。`)
    }
    // Numeric codes from hvigor/hdc carry no meaning on their own; the shared
    // table adds the concrete next action when the output contains one.
    for (const hint of explain(result.lines)) {
      if (!hints.includes(hint)) hints.push(hint)
    }

    const ok = result.exitCode === 0 && !result.timedOut
    const lines = [
      ok
        ? `构建成功（${Math.round(result.durationMs / 1000)}s）${signed ? '，已签名' : artifacts.length > 0 ? '，未签名' : ''}`
        : `构建失败${result.timedOut ? '（超时被杀）' : ''}，exit=${result.exitCode ?? 'null'}`,
      `工程：${projectDir}`,
    ]
    if (ok && artifacts.length > 0) lines.push(`本次产物：\n${artifacts.map((p) => `- ${p}`).join('\n')}`)
    if (ok && artifacts.length === 0) lines.push('构建返回成功，但没有发现本次新生成的 .hap（检查 product / module 参数是否指向真实目标）。')
    if (parsed.errors.length > 0) lines.push(`错误：\n${formatErrors(parsed.errors)}`)
    if (hints.length > 0) lines.push(`提示：\n${hints.map((h) => `- ${h}`).join('\n')}`)
    if (!ok && parsed.errors.length === 0) lines.push(`输出尾部：\n${result.lines.slice(-40).join('\n')}`)

    return {
      ok,
      summary: lines.join('\n\n'),
      data: {
        projectDir,
        command: result.commandLine,
        exitCode: result.exitCode ?? -1,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        artifacts,
        signed,
        signingConfigured: signing.configured,
        errors: parsed.errors,
        hints,
        sharedModulesMissing: hspMissing,
        outputTail: result.lines.slice(-40),
      },
    }
  }

  /**
   * ArkTS type-check only: runs the compiler task hvigor uses before packaging,
   * so no signing and no HAP assembler. In a large project this is about half
   * the wall time of a full build, which is what makes an edit/check loop
   * practical. It still writes build intermediates, so plan mode refuses it.
   */
  async function compile(args, exec) {
    const projectDir = projectRoot(ctx, exec, args.projectDir)
    const hvigorw = resolveHvigorw(projectDir)
    const product = args.product ?? 'default'
    const mode = args.mode ?? 'debug'
    const env = toolchainEnv(args.isolateHome ?? canIsolateHvigorHome())
    const startedAt = Date.now()
    // The task lives on a module, so an unqualified run fails with a bare
    // "task not found". Fall back to the entry module the app actually starts.
    const module = args.module ?? (() => {
      const target = inferTarget(projectDir)
      return target?.moduleDir ? basename(target.moduleDir) : undefined
    })()
    const run = await runCommand(hvigorw.command, [
      '--mode', 'module',
      ...(module ? ['-p', `module=${module}@default`] : []),
      '-p', `product=${product}`,
      '-p', `buildMode=${mode}`,
      'default@CompileArkTS',
      '--no-daemon',
    ], { cwd: projectDir, timeoutMs: args.timeoutMs ?? 600_000, env, signal: exec?.signal })

    const parsed = parseOutput(run.lines)
    const plain = run.lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
    const warnings = plain.filter((line) => /^WARN\b|ArkTS:WARN/i.test(line.trim())).length
    const ok = run.exitCode === 0 && !run.timedOut
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const lines = [
      ok
        ? `编译通过（仅 ArkTS 类型检查，${seconds}s）${warnings > 0 ? `，${warnings} 条警告` : ''}`
        : `编译失败${run.timedOut ? '（超时被杀）' : ''}，exit=${run.exitCode ?? 'null'}`,
      `工程：${projectDir}`,
    ]
    if (parsed.errors.length > 0) lines.push(`错误：\n${formatErrors(parsed.errors)}`)
    if (!ok && parsed.errors.length === 0) lines.push(`输出尾部：\n${run.lines.slice(-40).join('\n')}`)

    return {
      ok,
      summary: lines.join('\n\n'),
      data: {
        projectDir,
        module,
        command: run.commandLine,
        exitCode: run.exitCode ?? -1,
        timedOut: run.timedOut,
        durationMs: Date.now() - startedAt,
        warnings,
        errors: parsed.errors,
      },
    }
  }

  /**
   * Sync ohpm dependencies (`ohpm install --all`). DevEco does this on save;
   * from a tool call it is needed after oh-package.json5 changes, and its own
   * failures (registry auth, missing local .har) are much clearer here than the
   * ArkTS "cannot find module" that shows up at build time instead.
   */
  async function deps(args, exec) {
    // A wrong projectDir or a missing DevEco install should read as a result,
    // not as a thrown stack the model has to interpret.
    let projectDir
    let ohpm
    try {
      projectDir = projectRoot(ctx, exec, args.projectDir)
      ohpm = resolveOhpm()
    } catch (error) {
      return {
        ok: false,
        summary: `依赖安装没有执行：${error?.message ?? error}\n\n传 projectDir 指向含 build-profile.json5 的工程根；ohpm 来自 DevEco Studio 的 tools/ohpm。`,
        data: { stage: 'resolve', error: String(error?.message ?? error) },
      }
    }
    const startedAt = Date.now()
    const run = await runCommand(ohpm.command, ['install', '--all'], {
      cwd: projectDir,
      timeoutMs: args.timeoutMs ?? 600_000,
      signal: exec?.signal,
    })

    const plain = run.lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
    const warnings = plain
      .map((line) => line.trim())
      .filter((line) => /^ohpm WARN:/i.test(line))
    const parsed = parseOutput(plain)
    const ok = run.exitCode === 0 && !run.timedOut && parsed.errors.length === 0
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))

    const lines = [
      ok
        ? `依赖安装完成（ohpm install --all，${seconds}s）${warnings.length > 0 ? `，${warnings.length} 条警告` : ''}`
        : `依赖安装失败${run.timedOut ? '（超时被杀）' : ''}，exit=${run.exitCode ?? 'null'}`,
      `工程：${projectDir}`,
    ]
    if (warnings.length > 0) {
      // These are mostly "the dependency key does not match the package name",
      // which builds fine but bites when someone later greps for the real name.
      const shown = warnings.slice(0, 3).map((line) => line.replace(/^ohpm WARN:\s*/i, '').replace(/\u001b\[[0-9;]*m/g, ''))
      lines.push(`警告：\n${shown.map((line) => `- ${line}`).join('\n')}${warnings.length > shown.length ? `\n- …另有 ${warnings.length - shown.length} 条` : ''}`)
    }
    if (parsed.errors.length > 0) lines.push(`错误：\n${formatErrors(parsed.errors)}`)
    if (!ok && parsed.errors.length === 0) lines.push(`输出尾部：\n${plain.slice(-30).join('\n')}`)

    return {
      ok,
      summary: lines.join('\n\n'),
      data: {
        projectDir,
        command: run.commandLine,
        exitCode: run.exitCode ?? -1,
        timedOut: run.timedOut,
        durationMs: Date.now() - startedAt,
        warnings: warnings.length,
        errors: parsed.errors,
      },
    }
  }


  const tool = {
    name: 'harmony',
    description: 'The single entry point for HarmonyOS app work. action=build compiles a HAP with hvigorw and returns hvigor/ArkTS diagnostics plus produced .hap paths; action=compile runs only the ArkTS type check (faster, no packaging or signing); action=run does build → install → launch → capture logs in one call and reports which stage failed; action=devices lists hdc targets; action=deploy installs (and optionally starts) a HAP; action=logs captures a bounded hilog window and, given a bundleName, narrows it to the pid of that app; action=screenshot saves a device screenshot to a local file and returns its path; action=app starts, force-stops, clears data or uninstalls the app; action=doctor checks hdc, device, SDK, hvigorw, signing, shared-module artifacts and ohpm in one pass; action=sign reports the signing config, material files and certificate validity before a build makes you wait; action=deps runs ohpm install --all and reports registry/local-dependency failures; action=ui reads the on-screen tree (op=dump) or taps/types/presses keys by text (op=tap/input/key/swipe); action=file pulls a device file to the host or pushes a host file to the device (op=pull/send); action=crash reads the newest faultlogger report (jscrash/cppcrash/appfreeze), optionally filtered by bundleName, and extracts process/reason/stack; action=docs searches a configured offline API docs tree (op=search), reads a hit (op=read), reports which API level introduced a symbol from the SDK d.ts files (op=api), or configures the roots (op=config dir=/sdk=). deploy/run/logs/screenshot/app accept device="all" or a comma-separated list to work on several devices at once. Refuses build/compile/run/deploy/app while plan mode is active (read-only). Prefer action=run after editing .ets files.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['build', 'compile', 'deps', 'run', 'devices', 'deploy', 'logs', 'screenshot', 'app', 'doctor', 'sign', 'ui', 'file', 'crash', 'docs'], description: 'build | compile | deps | run | devices | deploy | logs | screenshot | app | doctor | ui | file | crash | docs' },
      projectDir: { type: 'string', description: 'HarmonyOS project root (contains build-profile.json5). Defaults to the nearest one above the session directory.' },
      module: { type: 'string', description: 'build: module name to build, for example "entry". Omit to build every module of the product.' },
      product: { type: 'string', description: 'build: product name from build-profile.json5. Defaults to "default".' },
      mode: { type: 'string', enum: ['debug', 'release'], description: 'build: build mode. Defaults to "debug".' },
      clean: { type: 'boolean', description: 'build: run the clean task before assembling.' },
      isolateHome: { type: 'boolean', description: 'build: keep hvigor caches in an isolated HVIGOR_USER_HOME under the temp area, seeding the pnpm wrapper from the real profile. Defaults to auto: isolated when a wrapper can be seeded.' },
      hsp: { type: 'boolean', description: 'build/run: also run assembleHsp to rebuild shared (HSP) modules. Required once for HSP-split projects, whose entry HAP cannot install until its dependent modules exist on the device.' },
      timeoutMs: { type: 'number', description: 'build: hard timeout in milliseconds. Defaults to 600000.' },
      hap: { type: 'string', description: 'deploy/run: path to the .hap. Defaults to the newest artifact under the project (signed preferred).' },
      bundleName: { type: 'string', description: 'deploy/run: bundle name. Defaults to the value in AppScope/app.json5.' },
      ability: { type: 'string', description: 'deploy/run: ability to start, for example EntryAbility. Defaults to module.json5 mainElement or the first ability.' },
      device: { type: 'string', description: 'deploy/run/logs: a device id, "all" for every connected device, or a comma-separated list. Defaults to the first connected device.' },
      pid: { type: 'integer', description: 'logs: keep only this process id. Defaults to the pid resolved from bundleName.' },
      appOnly: { type: 'boolean', description: 'logs: when bundleName is given, resolve its pid and show only that process. Defaults to true; false falls back to substring matching.' },
      filter: { type: 'string', description: 'logs: keep only lines containing this text, or a /regex/ pattern. Applied on the host after capture.' },
      remote: { type: 'string', description: 'file: absolute path on the device, for example /data/local/tmp/app.log.' },
      local: { type: 'string', description: 'file: host file path. pull defaults to a temp folder; send requires it.' },
      seconds: { type: 'number', description: 'logs/run: capture window in seconds (1-60). Defaults to 6 for run, 5 for logs.' },
      op: { type: 'string', enum: ['start', 'stop', 'clear', 'uninstall', 'dump', 'find', 'wait', 'tap', 'input', 'key', 'swipe', 'pull', 'send'], description: 'app: start/stop/clear/uninstall. ui: dump the on-screen tree, find controls by text without tapping, wait for text to appear (or vanish) without burning turns, tap a control, type text, send a key, or swipe. file: pull from the device or send to the device. Defaults to start for app, dump for ui and pull for file.' },
      x: { type: 'integer', description: 'ui tap/input: x coordinate in device pixels. tap: optional when text is given; input: focus point.' },
      y: { type: 'integer', description: 'ui tap/input: y coordinate in device pixels.' },
      absent: { type: 'boolean', description: 'ui op=wait: wait until the text disappears instead of appearing.' },
      key: { type: 'string', description: 'ui key: Back, Home, Power, or a numeric keyID.' },
      fromX: { type: 'integer', description: 'ui swipe: start x.' },
      fromY: { type: 'integer', description: 'ui swipe: start y.' },
      toX: { type: 'integer', description: 'ui swipe: end x.' },
      toY: { type: 'integer', description: 'ui swipe: end y.' },
      label: { type: 'string', description: 'screenshot: filename prefix for the saved image. Defaults to the device id.' },
      query: { type: 'string', description: 'docs op=search: the text to look for in the configured offline docs.' },
      file: { type: 'string', description: 'docs op=read: path returned by a previous search.' },
      line: { type: 'integer', description: 'docs op=read: line to centre the window on (default: 1).' },
      symbol: { type: 'string', description: 'docs op=api: interface, class or function name to look up in the SDK d.ts files.' },
      dir: { type: 'string', description: 'docs op=config: add a docs root directory.' },
      sdk: { type: 'string', description: 'docs op=config: set the SDK api directory to scan (for example <SDK>/ets/api).' },
    }, ['action']),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'ok', 'summary'],
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      // Plan mode is read-only by contract: building, installing or launching
      // changes the project or the device, so refuse even when a model decides
      // to "just verify quickly". Inspecting (devices/logs) stays allowed.
      const plan = typeof ctx?.planMode?.get === 'function' ? ctx.planMode.get(exec?.agent) : undefined
      const readonlyUi = new Set(['dump', 'find', 'wait'])
      const mutatingUi = args.action === 'ui' && !readonlyUi.has(String(args.op ?? 'dump').toLowerCase())
      const mutatingFile = args.action === 'file' && String(args.op ?? 'pull').toLowerCase() === 'send'
      if (plan?.active && (['build', 'compile', 'deps', 'run', 'deploy', 'app'].includes(args.action) || mutatingUi || mutatingFile)) {
        return {
          action: args.action,
          ok: false,
          summary: `plan 模式下不能执行 ${args.action}：plan 是只读的（不构建、不安装、不启动）。\n\n要开始动手就退出 plan：让用户批准计划（exit_plan_mode），或输入 /build。只看设备或日志可以用 action=devices / action=logs。`,
          data: { stage: 'plan-guard', planActive: true },
        }
      }
      switch (args.action) {
        case 'build': {
          return { action: 'build', ...(await build(args, exec)) }
        }
        case 'compile': {
          return { action: 'compile', ...(await compile(args, exec)) }
        }
        case 'deps': {
          return { action: 'deps', ...(await deps(args, exec)) }
        }
        case 'crash': {
          const targets = await resolveTargets(exec, args.device)
          if (targets.ids.length === 0) {
            return { action: 'crash', ok: false, summary: `没有可用的设备。\n\n${targets.tail.join('\n')}`, data: { devices: [] } }
          }
          const device = targets.ids[0]
          const hdc = resolveHdc().command
          const dir = '/data/log/faultlog/faultlogger'
          const listing = await runCommand(hdc, ['-t', device, 'shell', 'ls', '-t', dir], { timeoutMs: 20_000, signal: exec?.signal })
          if (listing.exitCode !== 0) {
            return { action: 'crash', ok: false, summary: `读不到故障日志目录 ${dir}：${listing.lines.slice(-4).join('\n') || '（无输出）'}`, data: { device } }
          }
          const names = listing.lines.map((line) => line.trim()).filter((line) => /^(?:cppcrash|jscrash|appfreeze)-/.test(line))
          const wanted = args.bundleName ? names.filter((name) => name.toLowerCase().includes(String(args.bundleName).toLowerCase())) : names
          if (wanted.length === 0) {
            return {
              action: 'crash',
              ok: false,
              summary: names.length === 0
                ? `设备上没有崩溃日志（${dir} 为空）。应用没崩过，或日志已被清理。`
                : `设备上有 ${names.length} 份崩溃日志，但没有一份匹配「${args.bundleName}」。最近三份：\n${names.slice(0, 3).map((n) => `- ${n}`).join('\n')}`,
              data: { device, candidates: names.slice(0, 20) },
            }
          }
          const name = wanted[0]
          const body = await runCommand(hdc, ['-t', device, 'shell', 'cat', `${dir}/${name}`], { timeoutMs: 30_000, signal: exec?.signal })
          const text = body.lines.join('\n')
          const parsedCrash = parseFaultLog(text)
          const keep = Math.max(10, Number(args.seconds ?? 60))
          const tail = body.lines.slice(-keep)
          const summaryLines = [
            `最近的崩溃日志：${name}${wanted.length > 1 ? `（同条件共 ${wanted.length} 份）` : ''}`,
            `设备：${device}`,
          ]
          if (parsedCrash.process) summaryLines.push(`进程：${parsedCrash.process}`)
          if (parsedCrash.reason) summaryLines.push(`原因：${parsedCrash.reason}`)
          if (parsedCrash.timestamp) summaryLines.push(`时间：${parsedCrash.timestamp}`)
          summaryLines.push(`日志尾部（${tail.length} 行）：\n${tail.join('\n')}`)
          return {
            action: 'crash',
            ok: true,
            summary: summaryLines.join('\n'),
            data: { device, file: name, path: `${dir}/${name}`, ...parsedCrash, candidates: wanted.slice(0, 20), tail },
          }
        }
        case 'devices': {
          const { devices, tail } = await listDevices(exec)
          const infos = devices.length === 0 ? [] : await collectDevicesInfo(devices.map((d) => d.id))
          const preferred = getLastDevice()
          const known = typeof preferred === 'string' && devices.some((d) => d.id === preferred)
          const details = infos.map((info) => ({ ...info, preferred: known && info.id === preferred }))
          return {
            action: 'devices',
            ok: true,
            summary: devices.length === 0
              ? `没有已连接的设备。\n\n${tail.join('\n')}`
              : `已连接 ${devices.length} 个设备：\n${details.map((info) => `- ${formatDeviceLine(info)}${info.preferred ? '（上次使用）' : ''}`).join('\n')}`,
            data: { devices, details, preferred: known ? preferred : undefined, outputTail: tail },
          }
        }
        case 'logs': {
          const targets = await resolveTargets(exec, args.device)
          if (targets.ids.length === 0) {
            return {
              action: 'logs',
              ok: false,
              summary: `没有可用的设备。\n\n${targets.tail.join('\n')}`,
              data: { devices: [], unknown: targets.unknown },
            }
          }
          if (targets.ids.length === 1) {
            const logs = await captureLogs(exec, { ...args, device: targets.ids[0] })
            return {
              action: 'logs',
              ok: logs.lines.length > 0,
              summary: logs.lines.length === 0
                ? (logs.filter
                  ? (logs.pid
                    ? `这 ${logs.seconds} 秒内进程 ${logs.pid} 有 ${logs.scopeCount} 行日志，但没有匹配「${logs.filter}」的（全设备扫到 ${logs.scanned} 行，换一个关键字试试）。`
                    : `这 ${logs.seconds} 秒内没有匹配「${logs.filter}」的日志（共扫到 ${logs.scanned} 行，可能是应用没运行或换一个关键字）。`)
                  : `这 ${logs.seconds} 秒内没有日志（可能是设备未连接或应用未运行）${args.bundleName && !logs.pid ? '；也可能应用没在跑，包名解析不出进程号' : ''}。`)
                : `最近 ${logs.seconds}s 的日志${logs.pid ? `（进程 ${logs.pid}）` : ''}${logs.filter ? `（匹配「${logs.filter}」${logs.captured} 行 / 共 ${logs.scanned} 行）` : `（${logs.captured} 行 / 共 ${logs.scanned} 行）`}：\n${logs.lines.join('\n')}`,
              data: logs,
            }
          }

          const perDevice = await Promise.all(targets.ids.map(async (device) => {
            const logs = await captureLogs(exec, { ...args, device })
            return { device, ...logs }
          }))
          const sections = perDevice.map((entry) => (entry.lines.length === 0
            ? `[${entry.device}] ${entry.filter ? `无匹配「${entry.filter}」的日志（扫到 ${entry.scanned} 行）` : '无日志'}`
            : `[${entry.device}] ${entry.captured} 行${entry.filter ? ` / 共 ${entry.scanned} 行` : ''}\n${entry.lines.join('\n')}`))
          return {
            action: 'logs',
            ok: perDevice.some((entry) => entry.lines.length > 0),
            summary: `最近 ${args.seconds ?? 5}s 的日志（${perDevice.length} 个设备）：\n\n${sections.join('\n\n')}`,
            data: { devices: perDevice, unknown: targets.unknown },
          }
        }
        case 'docs': {
          const op = String(args.op ?? 'search').toLowerCase()
          const settings = readSettings()
          const knowledge = resolveKnowledge(settings)

          if (op === 'config') {
            let saved
            if (typeof args.dir === 'string' && args.dir.trim() !== '') {
              const next = [...new Set([...knowledge.dirs, resolve(args.dir.trim())])]
              saved = writeSettings({ docsDirs: next })
            }
            if (typeof args.sdk === 'string' && args.sdk.trim() !== '') {
              saved = writeSettings({ apiSdkRoot: resolve(args.sdk.trim()) })
            }
            const current = resolveKnowledge(readSettings())
            const rows = current.dirs.map((dir) => {
              const exists = existsSync(dir)
              return exists
                ? `✓ ${dir}\n    ${listMarkdown(dir, { maxFiles: 4000 }).length} 个 .md（最多数 4000）`
                : `✗ ${dir}\n    目录不存在`
            })
            const lines = [
              `配置来源：${current.source === 'env' ? '环境变量 DSH_HARMONY_DOCS_DIRS' : current.source === 'file' ? '配置文件' : '未配置'}`,
              `配置文件：${settingsPath()}`,
              rows.length > 0 ? `文档目录：\n${rows.join('\n')}` : '文档目录：未配置',
              current.sdkRoot
                ? `${existsSync(current.sdkRoot) ? '✓' : '✗'} SDK 类型定义：${current.sdkRoot}`
                : 'SDK 类型定义：未配置（api 查询不可用）',
              saved ? `已写入：${saved}` : '',
              current.dirs.length === 0 ? '设置方式：action=docs op=config dir=<你的文档目录>' : '',
            ].filter(Boolean)
            return { action: 'docs', ok: current.dirs.length > 0 || current.sdkRoot !== '', summary: lines.join('\n\n'), data: { op, ...current, configPath: settingsPath(), saved } }
          }

          if (op === 'search') {
            const query = String(args.query ?? args.text ?? '').trim()
            if (query === '') return { action: 'docs', ok: false, summary: 'search 需要 query：要搜的关键词。', data: { op } }
            if (knowledge.dirs.length === 0) {
              return { action: 'docs', ok: false, summary: `还没有配置离线文档目录。运行一次：\n  harmony action=docs op=config dir=<你的文档根目录>\n配置文件在 ${settingsPath()}。`, data: { op, query } }
            }
            const found = searchDocs({ dirs: knowledge.dirs, query })
            const scope = `扫了 ${found.scannedFiles} 个 .md（${Math.round(found.scannedBytes / 1024 / 1024)} MB）${found.stopped === 'deadline' ? '，到 10 秒预算' : found.stopped === 'budget' ? '，到扫描上限' : ''}`
            const summary = found.hits.length === 0
              ? `没有找到「${query}」。${scope}。`
              : `找到 ${found.hits.length} 处「${query}」，${scope}：\n\n${found.hits.map((hit, index) => `${index + 1}. ${hit.file}:${hit.line}\n   ${hit.heading ? `# ${hit.heading}\n   ` : ''}${hit.snippet.replace(/\n/g, '\n   ')}`).join('\n\n')}`
            return { action: 'docs', ok: found.hits.length > 0, summary, data: { op, query, ...found } }
          }

          if (op === 'read') {
            const file = String(args.file ?? '').trim()
            if (file === '') return { action: 'docs', ok: false, summary: 'read 需要 file：search 结果里的文件路径。', data: { op } }
            if (knowledge.dirs.length === 0) return { action: 'docs', ok: false, summary: '还没有配置离线文档目录，先运行 op=config。', data: { op } }
            try {
              const section = readDoc({ file: resolve(file), dirs: knowledge.dirs, line: Number(args.line), context: Number(args.seconds) > 0 ? Number(args.seconds) * 5 : 60 })
              return {
                action: 'docs',
                ok: true,
                summary: `${section.file} 第 ${section.start}–${section.end} 行${section.heading ? `（# ${section.heading}）` : ''}：\n\n${section.text}`,
                data: { op, ...section },
              }
            } catch (error) {
              return { action: 'docs', ok: false, summary: `读不了这个文件：${error instanceof Error ? error.message : String(error)}`, data: { op, file } }
            }
          }

          if (op === 'api') {
            const symbol = String(args.symbol ?? args.query ?? args.text ?? '').trim()
            if (symbol === '') return { action: 'docs', ok: false, summary: 'api 需要 symbol：接口或类名，例如 notificationManager。', data: { op } }
            if (!knowledge.sdkRoot || !existsSync(knowledge.sdkRoot)) {
              return { action: 'docs', ok: false, summary: `还没有配置 SDK 类型定义目录（apiSdkRoot），api 查询不可用。配置：${settingsPath()} 里加 "apiSdkRoot": "<SDK>/ets/api"，或 op=config sdk=<path>。`, data: { op, symbol } }
            }
            const hit = lookupApi({ sdkRoot: knowledge.sdkRoot, symbol })
            if (!hit) return { action: 'docs', ok: false, summary: `SDK 里没有找到 ${symbol} 的声明（在 ${knowledge.sdkRoot} 下逐个 d.ts 找过）。`, data: { op, symbol } }
            return {
              action: 'docs',
              ok: true,
              summary: `${symbol}：@since ${hit.since}${hit.deprecated ? '，已标记 @deprecated' : ''}\n${hit.file}:${hit.line}\n${hit.declaration}`,
              data: { op, symbol, ...hit },
            }
          }

          return { action: 'docs', ok: false, summary: `不支持的 docs 操作：${op}（可用 config / search / read / api）`, data: { op } }
        }
        case 'doctor': {
          // Everything that has to be true before a build can succeed. Each row
          // is independent: a missing device should not hide a broken signing
          // config, and both are cheaper to read here than from a failed build.
          const rows = []
          const row = (name, status, detail) => rows.push({ name, status, detail })
          let projectDir = null
          try {
            projectDir = projectRoot(ctx, exec, args.projectDir)
          } catch (error) {
            row('工程', 'fail', error.message)
          }

          const hdc = resolveHdc()
          // A wedged hdc must not swallow the whole check: each external probe
          // is time-boxed, and the pass shares a deadline so the answer arrives
          // while the user is still looking at the screen.
          const budget = createBudget(8_000, { perProbeMs: 2_000 })
          const version = await budget.probe('hdc -v', (signal) => runCommand(hdc.command, ['-v'], { timeoutMs: 2_000, signal }))
          const hdcVersion = version.status === 'ok' ? (version.value.lines.map((line) => line.trim()).find((line) => line !== '') ?? '') : ''
          row(
            'hdc',
            version.status === 'ok' && version.value.exitCode === 0 ? 'ok' : version.status === 'ok' ? 'fail' : version.status,
            version.status === 'ok'
              ? `${hdc.command}（${hdc.source}）${hdcVersion ? ` · ${hdcVersion}` : ''}`
              : `${hdc.command}（${hdc.source}）· ${version.detail}`,
          )

          const targets = await budget.probe('hdc list targets', (signal) => listDevices({ signal }, { timeoutMs: 2_000 }))
          if (targets.status !== 'ok') {
            row('设备', targets.status, `查不到设备列表：${targets.detail}`)
          } else if (targets.value.devices.length > 0) {
            row('设备', 'ok', targets.value.devices.map((device) => device.id).join('、'))
          } else {
            row('设备', 'warn', '没有已连接的设备（hdc list targets 为空）')
          }

          const sdkHome = process.env.DEVECO_SDK_HOME ?? process.env.HOS_SDK_HOME ?? ''
          row('SDK', sdkHome ? 'ok' : 'warn', sdkHome || '未设置 DEVECO_SDK_HOME，构建时只能靠 DevEco 的默认路径')

          if (projectDir) {
            const hvigorw = resolveHvigorw(projectDir)
            const hvigorExists = hvigorw.source === 'path' || existsSync(hvigorw.command)
            row('hvigorw', hvigorExists ? 'ok' : 'fail', `${hvigorw.command}（${hvigorw.source}）`)

            const signing = signingState(projectDir)
            row('签名', signing.configured ? 'ok' : 'warn', signing.configured ? 'signingConfigs 有可用配置' : '没有 signingConfigs：只会产出 unsigned HAP，真机装不上')

            const declarations = declaredSharedModules(projectDir)
            if (declarations.length > 0) {
              const built = new Set(sharedPackages(projectDir).map((path) => basename(path).replace(/-default-signed\.hsp$/i, '')))
              const missing = declarations.filter((name) => !built.has(name))
              row('shared 模块', missing.length === 0 ? 'ok' : 'warn', missing.length === 0 ? `${declarations.length} 个都有产物` : `缺产物：${missing.join('、')}`)
            }

            const ohpm = resolveOhpm()
            const ohpmExists = ohpm.source === 'path' || existsSync(ohpm.command)
            row('ohpm', ohpmExists ? 'ok' : 'warn', `${ohpm.command}（${ohpm.source}）`)
          }

          row('hvigor 隔离 home', canIsolateHvigorHome() ? 'ok' : 'warn', canIsolateHvigorHome() ? '可复用真实 ~/.hvigor 的 pnpm wrapper' : '找不到 wrapper，构建只能走 isolateHome: false')

          const icon = { ok: '✓', warn: '!', fail: '✗', timeout: '⏱', skipped: '…' }
          const failures = rows.filter((entry) => entry.status === 'fail' || entry.status === 'error').length
          const timeouts = rows.filter((entry) => entry.status === 'timeout').length
          const warnings = rows.filter((entry) => entry.status === 'warn' || entry.status === 'skipped').length
          const problems = [
            failures > 0 ? `${failures} 项不可用` : '',
            timeouts > 0 ? `${timeouts} 项超时没返回` : '',
            warnings > 0 ? `${warnings} 项需要注意` : '',
          ].filter(Boolean)
          const summary = [
            problems.length === 0 ? '环境检查全部通过' : `环境${problems.join('、')}`,
            rows.map((entry) => `${icon[entry.status] ?? '?'} ${entry.name}：${entry.detail}`).join('\n'),
            `检查耗时 ${Math.round(budget.elapsedMs / 100) / 10}s（外部探测单独限时 2s，总预算 8s）`,
          ].join('\n\n')
          return { action: 'doctor', ok: failures === 0 && timeouts === 0, summary, data: { rows, projectDir, probes: budget.probes.map((probe) => ({ name: probe.name, status: probe.status, ms: probe.ms })) } }
        }
        case 'sign': {
          // Signing trouble shows up late, as "install failed: 9568289" long
          // after a 90 second build. Answer it up front instead: which config
          // the product uses, whether the three material files are there, and
          // whether the certificate itself is still valid.
          const projectDir = projectRoot(ctx, exec, args.projectDir)
          const source = readIfExists(join(projectDir, 'build-profile.json5'))
          if (source === null) {
            return { action: 'sign', ok: false, summary: `${projectDir} 里没有 build-profile.json5，不是 HarmonyOS 工程。`, data: { stage: 'project' } }
          }
          const report = signingReport(source)
          if (!report.found) {
            return {
              action: 'sign',
              ok: false,
              summary: 'build-profile.json5 里没有 signingConfigs：只会产出 unsigned HAP，真机装不上。\n\n在 DevEco 里 File → Project Structure → Signing Configs 勾选 Automatically generate signature，或手填 material 的 cert / profile / p12 三项。',
              data: { stage: 'config', ...report },
            }
          }

          const present = report.materials.filter((material) => material.exists).length
          const lines = [`签名配置 ${report.config.name}：${present}/${report.materials.length} 个材料在位`]
          for (const material of report.materials) {
            lines.push(`${material.exists ? '✓' : '✗'} ${material.label}：${material.path || '（未填）'}${material.exists ? '' : ' — 文件不存在'}`)
          }

          const cert = report.certificate
          let certOk = true
          if (cert === null) {
            certOk = false
            lines.push('✗ 证书读不出来（certpath 缺失或不是 X.509）')
          } else if (cert.error) {
            certOk = false
            lines.push(`✗ ${cert.error}`)
          } else {
            const name = /CN=([^,]+)/.exec(cert.subject)?.[1] ?? cert.subject
            const days = cert.daysLeft === null ? '有效期未知' : cert.daysLeft < 0 ? '已过期' : `剩 ${cert.daysLeft} 天`
            certOk = !cert.expired && !cert.notYetValid
            lines.push(`${cert.expired ? '✗' : '✓'} 证书 ${name}（签发者 ${/CN=([^,]+)/.exec(cert.issuer)?.[1] ?? cert.issuer}，到期 ${cert.validTo}，${days}）`)
            if (cert.expired) lines.push('  证书过期：重新申请，或换一份有效的 p12/p7b 组合。')
            if (cert.notYetValid) lines.push('  证书还没生效：检查系统时钟。')
          }

          const refs = report.referenced
          const mismatch = refs.filter((name) => !report.configs.some((config) => config.name === name))
          if (mismatch.length > 0) {
            lines.push(`✗ products 引用了不存在的签名配置：${mismatch.join('、')}（实际有 ${report.configs.map((config) => config.name).join('、')}）`)
          } else if (refs.length > 0) {
            lines.push(`✓ products 用的就是这份配置（${refs.join('、')}）`)
          }

          if (report.devEcoEncrypted) {
            lines.push('! storePassword / keyPassword 是 DevEco 的本地加密串，只有 DevEco 自己能用；命令行签名需要明文密码（暂未支持，先把构建交给 hvigorw 的签名任务）。')
          }

          return { action: 'sign', ok: present === report.materials.length && certOk && mismatch.length === 0, summary: lines.join('\n'), data: { ...report } }
        }
        case 'ui': {
          const op = String(args.op ?? 'dump').toLowerCase()
          const { devices } = await listDevices(exec)
          const picked = parseTargets(devices.map((device) => device.id), args.device)
          if (picked.ids.length === 0) {
            return { action: 'ui', ok: false, summary: `没有可用的设备。\n\n${devices.length === 0 ? 'hdc list targets 为空，先连设备。' : `不认识的设备：${picked.unknown.join('、')}`}`, data: { op, devices: [] } }
          }
          const device = picked.ids[0]
          const hdc = resolveHdc().command
          const tap = async (x, y) => runCommand(hdc, ['-t', device, 'shell', 'uitest', 'uiInput', 'click', String(x), String(y)], { timeoutMs: 30_000, signal: exec?.signal })

          if (op === 'dump') {
            const tree = await dumpUiTree(exec, device)
            if (!tree) return { action: 'ui', ok: false, summary: `设备 ${device} 的 UI 树抓取失败（uitest dumpLayout 没返回 JSON）。`, data: { op, device } }
            const nodes = flattenUi(tree).filter((node) => node.visible)
            const clickable = nodes.filter((node) => node.clickable).length
            const shown = nodes.slice(0, 200)
            const summary = [
              `设备 ${device} 的界面：${nodes.length} 个可见节点，其中 ${clickable} 个可点（列出前 ${shown.length} 个）。`,
              shown.map(formatUiNode).join('\n'),
              nodes.length > shown.length ? `…还有 ${nodes.length - shown.length} 个节点未列出` : '',
            ].filter(Boolean).join('\n\n')
            return { action: 'ui', ok: true, summary, data: { op, device, nodeCount: nodes.length, clickable, nodes: shown.map((node) => ({ depth: node.depth, type: node.type, text: node.text, clickable: node.clickable, bounds: node.bounds })) } }
          }

          if (op === 'find') {
            const query = String(args.text ?? '').trim()
            if (!query) return { action: 'ui', ok: false, summary: 'find 需要 text：要查找的文字。', data: { op, device } }
            const tree = await dumpUiTree(exec, device)
            if (!tree) return { action: 'ui', ok: false, summary: `设备 ${device} 的 UI 树抓取失败。`, data: { op, device } }
            const matches = findUiNodes(flattenUi(tree).filter((node) => node.visible), query)
            return {
              action: 'ui',
              ok: true,
              summary: matches.length === 0
                ? `界面上没有文字包含「${query}」的控件。先跑 op=dump 看当前有哪些文字。`
                : `找到 ${matches.length} 个包含「${query}」的控件（没有点击）：\n${matches.slice(0, 20).map((node) => `${node.clickable ? '· 可点' : '· 只读'} [${node.bounds.x},${node.bounds.y}] ${node.type} "${node.text}"`).join('\n')}`,
              data: {
                op,
                device,
                matches: matches.slice(0, 20).map((node) => ({
                  type: node.type,
                  text: node.text,
                  clickable: node.clickable,
                  bounds: node.bounds,
                  center: { x: node.bounds.x, y: node.bounds.y },
                })),
              },
            }
          }

          if (op === 'wait') {
            // A tap is only half of an interaction: the interesting part is that
            // the next screen actually arrived. Polling the UI tree here keeps
            // that decision out of the model's turn budget.
            const query = String(args.text ?? '').trim()
            if (!query) return { action: 'ui', ok: false, summary: 'wait 需要 text：等它出现（或消失）的文字。', data: { op, device } }
            const absent = args.absent === true
            const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 10_000
            const started = Date.now()
            const outcome = await waitUntil(async () => {
              const tree = await dumpUiTree(exec, device)
              if (!tree) return { ok: false, value: { nodes: 0, hit: null } }
              const nodes = flattenUi(tree).filter((node) => node.visible)
              const hit = findUiNodes(nodes, query)[0] ?? null
              return { ok: absent ? hit === null : hit !== null, value: { nodes: nodes.length, hit } }
            }, { timeoutMs, intervalMs: 400 })
            const elapsed = Math.round((Date.now() - started) / 100) / 10
            const seen = outcome.value ?? { nodes: 0, hit: null }
            const where = seen.hit ? `（${seen.hit.type} "${seen.hit.text}"，中心 [${seen.hit.bounds.x},${seen.hit.bounds.y}]）` : ''
            const summary = outcome.ok
              ? absent
                ? `等了 ${elapsed}s，「${query}」已经不在界面上（探测 ${outcome.attempts} 次）。`
                : `等了 ${elapsed}s，「${query}」出现了${where}（探测 ${outcome.attempts} 次）。`
              : absent
                ? `${elapsed}s 内「${query}」一直还在界面上${where}，当前 ${seen.nodes} 个可见节点。`
                : `${elapsed}s 内没等到「${query}」，当前 ${seen.nodes} 个可见节点。先跑 op=dump 看现在显示的是什么。`
            return {
              action: 'ui',
              ok: outcome.ok,
              summary,
              data: { op, device, query, absent, elapsedMs: Date.now() - started, attempts: outcome.attempts, nodes: seen.nodes, hit: seen.hit ? { type: seen.hit.type, text: seen.hit.text, bounds: seen.hit.bounds } : null },
            }
          }

          if (op === 'tap') {
            let x = Number(args.x)
            let y = Number(args.y)
            let target = null
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              if (!args.text) return { action: 'ui', ok: false, summary: 'tap 需要 text（按文字找控件）或 x/y 坐标。', data: { op, device } }
              const tree = await dumpUiTree(exec, device)
              if (!tree) return { action: 'ui', ok: false, summary: `设备 ${device} 的 UI 树抓取失败。`, data: { op, device } }
              target = findUiNode(flattenUi(tree).filter((node) => node.visible), args.text)
              if (!target) return { action: 'ui', ok: false, summary: `界面上找不到文字包含「${args.text}」的控件。先跑 op=dump 看当前有哪些文字。`, data: { op, device } }
              x = target.bounds.x
              y = target.bounds.y
            }
            const run = await tap(x, y)
            const ok = run.exitCode === 0 && !/error|fail/i.test(uiOutput(run))
            return {
              action: 'ui',
              ok,
              summary: ok
                ? `已在设备 ${device} 点击 ${target ? `「${target.text}」` : `坐标 (${x}, ${y})`}。`
                : `点击失败：${run.lines.slice(-4).join('\n')}`,
              data: { op, device, x, y, matched: target ? { text: target.text, type: target.type, bounds: target.bounds } : null },
            }
          }

          if (op === 'input') {
            if (!args.text) return { action: 'ui', ok: false, summary: 'input 需要 text：要输入的内容。', data: { op, device } }
            const hasPoint = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
            const uiArgs = hasPoint
              ? ['uitest', 'uiInput', 'inputText', String(Number(args.x)), String(Number(args.y)), args.text]
              : ['uitest', 'uiInput', 'text', args.text]
            const run = await runCommand(hdc, ['-t', device, 'shell', ...uiArgs], { timeoutMs: 30_000, signal: exec?.signal })
            const ok = run.exitCode === 0 && !/error|fail/i.test(uiOutput(run))
            return {
              action: 'ui',
              ok,
              summary: ok ? `已输入「${args.text}」${hasPoint ? `到 (${args.x}, ${args.y})` : '（输入到当前焦点）'}。` : `输入失败：${run.lines.slice(-4).join('\n')}`,
              data: { op, device, text: args.text, focused: !hasPoint },
            }
          }

          if (op === 'key') {
            const key = String(args.key ?? '').trim()
            if (!key) return { action: 'ui', ok: false, summary: 'key 需要 key：Back / Home / Power 或数字 keyID。', data: { op, device } }
            const run = await runCommand(hdc, ['-t', device, 'shell', 'uitest', 'uiInput', 'keyEvent', key], { timeoutMs: 30_000, signal: exec?.signal })
            const ok = run.exitCode === 0 && !/error|fail/i.test(uiOutput(run))
            return { action: 'ui', ok, summary: ok ? `已向设备 ${device} 发送按键 ${key}。` : `按键失败：${run.lines.slice(-4).join('\n')}`, data: { op, device, key } }
          }

          if (op === 'swipe') {
            const [fromX, fromY, toX, toY] = [args.fromX, args.fromY, args.toX, args.toY].map(Number)
            if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
              return { action: 'ui', ok: false, summary: 'swipe 需要 fromX/fromY/toX/toY。', data: { op, device } }
            }
            const run = await runCommand(hdc, ['-t', device, 'shell', 'uitest', 'uiInput', 'swipe', String(fromX), String(fromY), String(toX), String(toY), '600'], { timeoutMs: 30_000, signal: exec?.signal })
            const ok = run.exitCode === 0 && !/error|fail/i.test(uiOutput(run))
            return { action: 'ui', ok, summary: ok ? `已滑动 (${fromX},${fromY}) → (${toX},${toY})。` : `滑动失败：${run.lines.slice(-4).join('\n')}`, data: { op, device } }
          }

          return { action: 'ui', ok: false, summary: `不支持的 ui 操作：${op}（可用 dump / tap / input / key / swipe）`, data: { op, device } }
        }
        case 'file': {
          const op = String(args.op ?? 'pull').toLowerCase()
          const { devices } = await listDevices(exec)
          const picked = parseTargets(devices.map((device) => device.id), args.device)
          if (picked.ids.length === 0) {
            return { action: 'file', ok: false, summary: `没有可用的设备。\n\n${devices.length === 0 ? 'hdc list targets 为空，先连设备。' : `不认识的设备：${picked.unknown.join('、')}`}`, data: { op, devices: [] } }
          }
          const device = picked.ids[0]
          const hdc = resolveHdc().command
          if (!args.remote) {
            return { action: 'file', ok: false, summary: `${op} 需要 remote：设备上的绝对路径，例如 /data/local/tmp/app.log。`, data: { op, device } }
          }
          const remote = String(args.remote)

          if (op === 'pull') {
            const dir = join(tmpdir(), 'dsh-harmony-files')
            mkdirSync(dir, { recursive: true })
            const name = (args.local ? basename(String(args.local)) : basename(remote)) || 'pulled.bin'
            const local = args.local ? resolve(String(args.local)) : join(dir, `${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`)
            if (args.local) mkdirSync(dirname(local), { recursive: true })
            const run = await runCommand(hdc, ['-t', device, 'file', 'recv', remote, local], { timeoutMs: 120_000, signal: exec?.signal })
            const ok = run.exitCode === 0 && existsSync(local) && !/error|fail|not exist/i.test(run.lines.join('\n'))
            const size = ok ? statSync(local).size : null
            return {
              action: 'file',
              ok,
              summary: ok
                ? `已从 ${device} 拉取 ${remote} → ${local}（${size} 字节）。`
                : `拉取失败：${run.lines.slice(-6).join('\n') || `设备上可能没有 ${remote}`}`,
              data: { op, device, remote, local, bytes: size },
            }
          }

          if (op === 'send') {
            if (!args.local) return { action: 'file', ok: false, summary: 'send 需要 local：本机文件路径。', data: { op, device, remote } }
            const local = resolve(String(args.local))
            if (!existsSync(local)) return { action: 'file', ok: false, summary: `本机没有这个文件：${local}`, data: { op, device, remote, local } }
            const run = await runCommand(hdc, ['-t', device, 'file', 'send', local, remote], { timeoutMs: 120_000, signal: exec?.signal })
            const ok = run.exitCode === 0 && !/error|fail/i.test(run.lines.join('\n'))
            return {
              action: 'file',
              ok,
              summary: ok ? `已把 ${local} 推到 ${device}:${remote}。` : `推送失败：${run.lines.slice(-6).join('\n')}`,
              data: { op, device, remote, local, bytes: statSync(local).size },
            }
          }

          return { action: 'file', ok: false, summary: `不支持的 file 操作：${op}（可用 pull / send）`, data: { op, device } }
        }
        case 'screenshot': {
          const targets = await resolveTargets(exec, args.device)
          if (targets.ids.length === 0) {
            return {
              action: 'screenshot',
              ok: false,
              summary: `没有可用的设备。\n\n${targets.tail.join('\n')}`,
              data: { unknown: targets.unknown },
            }
          }
          const shots = []
          for (const id of targets.ids) {
            shots.push({ device: id, ...(await captureScreenshot(exec, { device: id, label: args.label })) })
          }
          const ok = shots.some((shot) => shot.ok)
          const lines = [
            ok ? `截图完成（${shots.filter((s) => s.ok).length}/${shots.length} 台）` : '截图失败',
            ...shots.map((shot) => shot.ok
              ? `- ${shot.device}: ${shot.path}${shot.width ? `（${shot.width}x${shot.height}）` : ''}`
              : `- ${shot.device}: ${shot.tail.join(' ')}`),
          ]
          return { action: 'screenshot', ok, summary: lines.join('\n'), data: { shots } }
        }
        case 'app': {
          const targets = await resolveTargets(exec, args.device)
          if (targets.ids.length === 0) {
            return {
              action: 'app',
              ok: false,
              summary: `没有可用的设备。\n\n${targets.tail.join('\n')}`,
              data: { unknown: targets.unknown },
            }
          }
          const op = args.op ?? 'start'
          let bundleName = args.bundleName
          let ability = args.ability
          if (!bundleName) {
            const target = inferTarget(projectRoot(ctx, exec, args.projectDir))
            bundleName = target.bundleName
            ability = ability ?? target.ability
          }
          if (!bundleName) {
            return { action: 'app', ok: false, summary: '无法确定 bundleName：工程里没读到 AppScope/app.json5，也没有显式传入。', data: { stage: 'resolve' } }
          }
          const results = []
          for (const id of targets.ids) {
            results.push({ device: id, ...(await controlApp(exec, { device: id, op, bundleName, ability })) })
          }
          const ok = results.some((result) => result.ok)
          const label = { start: '启动', stop: '停止', clear: '清空数据', uninstall: '卸载' }[op] ?? op
          const lines = [
            ok ? `已在 ${results.filter((r) => r.ok).length}/${results.length} 台设备上${label} ${bundleName}` : `${label} ${bundleName} 失败`,
            ...results.map((result) => `- ${result.device}: ${result.ok ? '成功' : (result.tail.join(' ') || '失败')}`),
          ]
          return { action: 'app', ok, summary: lines.join('\n'), data: { op, bundleName, results } }
        }
        case 'deploy': {
          const projectDir = args.hap ? undefined : projectRoot(ctx, exec, args.projectDir)
          const hap = args.hap ?? (projectDir ? findHaps(projectDir, 1)[0]?.path : undefined)
          if (!hap) throw new Error('没有可安装的 .hap：先跑 action=build，或显式传 hap 路径。')

          const targets = await resolveTargets(exec, args.device)
          if (targets.ids.length === 0) {
            return {
              action: 'deploy',
              ok: false,
              summary: `没有可用的设备${targets.unknown.length > 0 ? `（未连接：${targets.unknown.join(', ')}）` : ''}。\n\n${targets.tail.join('\n')}`,
              data: { hap, devices: [], unknown: targets.unknown },
            }
          }

          const hdc = resolveHdc()
          const results = await Promise.all(targets.ids.map(async (device) => {
            const install = await installOnDevice(hdc, device, hap, { projectDir }, exec)
            let started = false
            if (install.installed && args.bundleName && args.ability) {
              const start = await runCommand(
                hdc.command,
                ['-t', device, 'shell', 'aa', 'start', '-a', args.ability, '-b', args.bundleName],
                { timeoutMs: 60_000, signal: exec?.signal },
              )
              started = start.exitCode === 0 && !/error/i.test(start.lines.join('\n'))
            }
            return { device, ...install, started, errors: parseOutput(install.lines).errors }
          }))

          const okCount = results.filter((entry) => entry.installed).length
          const lines = []
          if (results.length === 1) {
            const only = results[0]
            lines.push(only.installed ? `安装成功：${hap}` : `安装失败：${hap}（exit=${only.exitCode ?? 'null'}）`)
            if (only.started) lines.push('已拉起 Ability。')
            if (only.errors.length > 0) lines.push(`错误：\n${formatErrors(only.errors)}`)
            if (!only.installed && only.errors.length === 0) lines.push(`输出尾部：\n${only.lines.slice(-15).join('\n')}`)
          } else {
            lines.push(`安装到 ${results.length} 个设备：${okCount} 个成功`)
            for (const entry of results) {
              const parts = [entry.installed ? '成功' : `失败（exit=${entry.exitCode ?? 'null'}）`]
              if (entry.started) parts.push('已拉起')
              if (entry.errors.length > 0) parts.push(`首个错误：${entry.errors[0].message}`)
              lines.push(`- ${entry.device}: ${parts.join('，')}`)
            }
            const failed = results.filter((entry) => !entry.installed)
            if (failed.length > 0) {
              lines.push(`失败详情：\n${failed.map((entry) => `[${entry.device}]\n${entry.errors.length > 0 ? formatErrors(entry.errors) : entry.lines.slice(-10).join('\n')}`).join('\n\n')}`)
            }
          }

          return {
            action: 'deploy',
            ok: okCount === results.length,
            summary: lines.join('\n\n'),
            data: {
              hap,
              device: results[0].device,
              started: results[0].started,
              installExitCode: results[0].exitCode ?? -1,
              errors: results[0].errors,
              outputTail: results[0].lines.slice(-15),
              devices: results.map((entry) => ({
                device: entry.device,
                installed: entry.installed,
                started: entry.started,
                staged: entry.staged,
                exitCode: entry.exitCode,
              })),
            },
          }
        }
        case 'run': {
          const compiled = await build(args, exec)
          if (!compiled.ok) {
            return {
              action: 'run',
              ok: false,
              summary: `run 在「编译」阶段失败，后续步骤未执行。\n\n${compiled.summary}`,
              data: { stage: 'build', build: compiled.data },
            }
          }

          const target = inferTarget(compiled.data.projectDir)
          const bundleName = args.bundleName ?? target.bundleName
          const ability = args.ability ?? target.ability
          const hap = args.hap
            ?? compiled.data.artifacts.find((path) => /signed/i.test(path) && !/unsigned/i.test(path))
            ?? compiled.data.artifacts[0]
          if (!hap) {
            return {
              action: 'run',
              ok: false,
              summary: `编译成功，但没有新生成的 .hap 可安装。\n\n${compiled.summary}`,
              data: { stage: 'artifact', build: compiled.data },
            }
          }

          const targets = await resolveTargets(exec, args.device)
          if (targets.ids.length === 0) {
            return {
              action: 'run',
              ok: false,
              summary: `编译成功，但没有已连接的设备，安装未执行${targets.unknown.length > 0 ? `（未连接：${targets.unknown.join(', ')}）` : ''}。\n\n${targets.tail.join('\n')}`,
              data: { stage: 'device', build: compiled.data, hap, unknown: targets.unknown },
            }
          }

          const hdc = resolveHdc()
          const unsignedHint = !compiled.data.signed && compiled.data.signingConfigured === false
            ? '这个 HAP 未签名且工程没有 signingConfigs，真机会拒绝安装。先在 DevEco Studio 里配好自动签名。'
            : ''

          // Devices are independent: one phone failing to install must not stop
          // the others, so every step is collected per device instead of thrown.
          const results = await Promise.all(targets.ids.map(async (device) => {
            const install = await installOnDevice(hdc, device, hap, compiled.data, exec)
            const installErrors = parseOutput(install.lines).errors
            if (!install.installed) return { device, install, installErrors, run: null }
            const run = await launchAndCapture(hdc, device, { bundleName, ability, seconds: args.seconds ?? 6, exec })
            return { device, install, installErrors, run }
          }))

          const installed = results.filter((entry) => entry.install.installed)
          const failedInstall = results.filter((entry) => !entry.install.installed)
          const crashedAny = installed.some((entry) => (entry.run?.signals.length ?? 0) > 0)

          const lines = []
          if (results.length === 1) {
            const entry = results[0]
            const run = entry.run
            lines.push(`harmony run 完成（${entry.device}）`)
            lines.push(`编译：成功（${Math.round(compiled.data.durationMs / 1000)}s，${compiled.data.artifacts.length} 个产物${compiled.data.signed ? '，已签名' : '，未签名'}）`)
            lines.push(`安装：成功（${hap}）`)
            if (entry.install.staged.length > 0) lines.push(`预装：${entry.install.staged.length} 个 HSP（失败 ${entry.install.staged.filter((item) => !item.ok).length} 个）`)
            lines.push(run?.started ? `启动：成功（${ability} / ${bundleName}）` : `启动：未执行或失败${bundleName && ability ? '' : '（工程里没推断出 bundleName/ability，可显式传参）'}`)
            lines.push(run && run.signals.length > 0
              ? `运行：日志里有 ${run.signals.length} 条疑似崩溃信号`
              : `运行：最近 ${run?.logs.seconds ?? 0}s 日志没有明显崩溃信号（${run?.logs.captured ?? 0} 行${run?.logs.pid ? `，仅进程 ${run.logs.pid}` : ''}）`)
            if (run && !run.started && run.startTail.length > 0) lines.push(`启动输出：\n${run.startTail.join('\n')}`)
            if (run && run.signals.length > 0) lines.push(`崩溃信号：\n${run.signals.slice(-8).join('\n')}`)
            if (compiled.data.hints.length > 0) lines.push(`提示：\n${compiled.data.hints.map((hint) => `- ${hint}`).join('\n')}`)
            if (run && run.signals.length === 0 && run.logs.lines.length === 0) lines.push('日志为空：确认应用确实启动，且 hilog 没有被系统缓冲吞掉。')
          } else {
            lines.push(`harmony run 完成（${installed.length}/${results.length} 个设备安装成功）`)
            lines.push(`编译：成功（${Math.round(compiled.data.durationMs / 1000)}s，${compiled.data.artifacts.length} 个产物${compiled.data.signed ? '，已签名' : '，未签名'}）`)
            for (const entry of results) {
              const block = [`[${entry.device}]`]
              if (!entry.install.installed) {
                block.push(`安装：失败（exit=${entry.install.exitCode ?? 'null'}）`)
                block.push(entry.installErrors.length > 0 ? formatErrors(entry.installErrors) : entry.install.lines.slice(-10).join('\n'))
              } else {
                block.push('安装：成功')
                if (entry.install.staged.length > 0) block.push(`预装：${entry.install.staged.length} 个 HSP（失败 ${entry.install.staged.filter((item) => !item.ok).length} 个）`)
                const run = entry.run
                block.push(run.started ? `启动：成功（${ability} / ${bundleName}）` : '启动：未执行或失败')
                block.push(run.signals.length > 0
                  ? `运行：${run.signals.length} 条疑似崩溃信号`
                  : `运行：最近 ${run.logs.seconds}s 日志没有明显崩溃信号（${run.logs.captured} 行）`)
                if (run.signals.length > 0) block.push(`崩溃信号：\n${run.signals.slice(-5).join('\n')}`)
              }
              lines.push(block.join('\n'))
            }
            if (compiled.data.hints.length > 0) lines.push(`提示：\n${compiled.data.hints.map((hint) => `- ${hint}`).join('\n')}`)
          }

          if (failedInstall.length === results.length) {
            const entry = failedInstall[0]
            const attribution = attributeFailure({
              stage: 'install',
              lines: entry.install.lines,
              errors: entry.installErrors,
            })
            const staging = entry.install.staged.length > 0
              ? `\n\n已尝试预装 ${entry.install.staged.length} 个 HSP（成功 ${entry.install.staged.filter((item) => item.ok).length} 个）：\n${entry.install.staged.map((item) => `- ${item.ok ? 'ok' : 'FAIL'} ${item.hap}${item.error ? `\n    ${item.error}` : ''}`).join('\n')}`
              : /dependent module does not exist/i.test(entry.install.lines.join('\n'))
                ? '\n\n这是 HSP 拆分工程：entry 依赖的共享模块还没装到设备上。用 hsp: true 重跑一次 action=run（或先 action=build hsp:true 再 deploy），让共享模块与本 HAP 一起构建后按序安装。'
                : ''
            const hint = unsignedHint ? `\n\n提示：${unsignedHint}` : ''
            const where = results.length === 1
              ? `（${entry.device}，exit=${entry.install.exitCode ?? 'null'}）`
              : `（${failedInstall.map((item) => item.device).join(', ')} 全部失败）`
            return {
              action: 'run',
              ok: false,
              summary: `run 在「安装」阶段失败${where}。\n\n${entry.installErrors.length > 0 ? formatErrors(entry.installErrors) : entry.install.lines.slice(-15).join('\n')}${staging}${hint}\n\n接下来：${attribution.label} —— ${attribution.action}`,
              data: {
                stage: 'install',
                build: compiled.data,
                hap,
                device: entry.device,
                staged: entry.install.staged,
                errors: entry.installErrors,
                attribution,
                devices: results.map((item) => ({
                  device: item.device,
                  installed: item.install.installed,
                  staged: item.install.staged,
                })),
              },
            }
          }

          const ok = failedInstall.length === 0 && !crashedAny
          let attributionForData = null
          if (!ok) {
            const attribution = attributeFailure({
              stage: crashedAny ? 'runtime' : 'install',
              lines: results.flatMap((entry) => [
                ...entry.install.lines,
                ...(entry.run?.startTail ?? []),
                ...(entry.run?.logs.lines ?? []),
              ]),
              errors: results.flatMap((entry) => entry.installErrors),
            })
            lines.push(`接下来：${attribution.label} —— ${attribution.action}`)
            attributionForData = attribution
          }

          return {
            action: 'run',
            ok,
            summary: lines.join('\n\n'),
            data: {
              stage: crashedAny ? 'runtime' : 'done',
              attribution: attributionForData ?? null,
              build: compiled.data,
              hap,
              device: results[0].device,
              bundleName,
              ability,
              started: results[0].run?.started ?? false,
              crashed: crashedAny,
              crashSignals: installed.flatMap((entry) => entry.run?.signals.slice(-5) ?? []).slice(-10),
              logLines: installed[0]?.run?.logs.lines.slice(-40) ?? [],
              devices: results.map((entry) => ({
                device: entry.device,
                installed: entry.install.installed,
                staged: entry.install.staged,
                started: entry.run?.started ?? false,
                crashed: (entry.run?.signals.length ?? 0) > 0,
                logLines: entry.run?.logs.lines.slice(-40) ?? [],
              })),
            },
          }
        }
        default:
          throw new Error(`未知 action: ${String(args.action)}（支持 build / run / devices / deploy / logs）`)
      }
    },
  }

  return [tool]
}
