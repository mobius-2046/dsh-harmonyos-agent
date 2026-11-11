import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCommand } from './exec.js'
import {
  canIsolateHvigorHome,
  findHaps,
  findProject,
  resolveHdc,
  resolveHvigorw,
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
async function listDevices(exec) {
  const hdc = resolveHdc()
  const result = await runCommand(hdc.command, ['list', 'targets'], { timeoutMs: 30_000, signal: exec?.signal })
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
async function captureLogs(exec, args) {
  const hdc = resolveHdc()
  const target = args.device ? ['-t', args.device] : []
  const seconds = Math.min(Math.max(args.seconds ?? 6, 1), 60)
  const result = await runCommand(hdc.command, [...target, 'shell', 'hilog'], {
    timeoutMs: seconds * 1000,
    signal: exec?.signal,
  })
  const all = result.lines.filter((line) => line.trim() !== '')
  const filtered = args.bundleName
    ? all.filter((line) => line.toLowerCase().includes(args.bundleName.toLowerCase()))
    : all
  return { lines: filtered.slice(-200), captured: filtered.length, seconds }
}

/** Log lines that usually mean the app died or never came up. */
const CRASH_SIGNAL = /(?:FATAL|JS ERROR|jscrash|SIGSEGV|Unhandled|Error message:|cannot find module|Exception:)/i

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
    const startedAt = Date.now()
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
        outputTail: result.lines.slice(-40),
      },
    }
  }

  const tool = {
    name: 'harmony',
    description: 'The single entry point for HarmonyOS app work. action=build compiles a HAP with hvigorw and returns hvigor/ArkTS diagnostics plus produced .hap paths; action=run does build → install → launch → capture logs in one call and reports which stage failed; action=devices lists hdc targets; action=deploy installs (and optionally starts) a HAP; action=logs captures a bounded hilog window. Prefer action=run after editing .ets files.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['build', 'run', 'devices', 'deploy', 'logs'], description: 'build | run | devices | deploy | logs' },
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
      device: { type: 'string', description: 'deploy/run/logs: target device id from action=devices. Defaults to the only connected device.' },
      seconds: { type: 'number', description: 'logs/run: capture window in seconds (1-60). Defaults to 6 for run, 5 for logs.' },
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
      switch (args.action) {
        case 'build': {
          return { action: 'build', ...(await build(args, exec)) }
        }
        case 'devices': {
          const { devices, tail } = await listDevices(exec)
          return {
            action: 'devices',
            ok: true,
            summary: devices.length === 0
              ? `没有已连接的设备。\n\n${tail.join('\n')}`
              : `已连接 ${devices.length} 个设备：\n${devices.map((d) => `- ${d.id}`).join('\n')}`,
            data: { devices, outputTail: tail },
          }
        }
        case 'logs': {
          const logs = await captureLogs(exec, args)
          return {
            action: 'logs',
            ok: logs.lines.length > 0,
            summary: logs.lines.length === 0
              ? `这 ${logs.seconds} 秒内没有匹配的日志（可能是设备未连接或应用未运行）。`
              : `最近 ${logs.seconds}s 的日志（${logs.captured} 行）：\n${logs.lines.join('\n')}`,
            data: logs,
          }
        }
        case 'deploy': {
          const projectDir = args.hap ? undefined : projectRoot(ctx, exec, args.projectDir)
          const hap = args.hap ?? (projectDir ? findHaps(projectDir, 1)[0]?.path : undefined)
          if (!hap) throw new Error('没有可安装的 .hap：先跑 action=build，或显式传 hap 路径。')

          const hdc = resolveHdc()
          const target = args.device ? ['-t', args.device] : []
          const install = await runCommand(hdc.command, [...target, 'install', '-r', hap], { timeoutMs: 180_000, signal: exec?.signal })
          const installed = install.exitCode === 0 && install.lines.some((line) => /success/i.test(line))
          const parsed = parseOutput(install.lines)

          let started = false
          if (installed && args.bundleName && args.ability) {
            const start = await runCommand(
              hdc.command,
              [...target, 'shell', 'aa', 'start', '-a', args.ability, '-b', args.bundleName],
              { timeoutMs: 60_000, signal: exec?.signal },
            )
            started = start.exitCode === 0
          }

          const lines = [installed ? `安装成功：${hap}` : `安装失败：${hap}（exit=${install.exitCode ?? 'null'}）`]
          if (started) lines.push('已拉起 Ability。')
          if (parsed.errors.length > 0) lines.push(`错误：\n${formatErrors(parsed.errors)}`)
          if (!installed && parsed.errors.length === 0) lines.push(`输出尾部：\n${install.lines.slice(-15).join('\n')}`)

          return {
            action: 'deploy',
            ok: installed,
            summary: lines.join('\n\n'),
            data: { hap, installExitCode: install.exitCode ?? -1, started, errors: parsed.errors, outputTail: install.lines.slice(-15) },
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

          const { devices, tail } = await listDevices(exec)
          const device = args.device ?? devices[0]?.id
          if (!device) {
            return {
              action: 'run',
              ok: false,
              summary: `编译成功，但没有已连接的设备，安装未执行。\n\n${tail.join('\n')}`,
              data: { stage: 'device', build: compiled.data, hap },
            }
          }

          const hdc = resolveHdc()
          const installArgs = ['-t', device, 'install', '-r', hap]
          let install = await runCommand(hdc.command, installArgs, { timeoutMs: 180_000, signal: exec?.signal })
          let installed = install.exitCode === 0 && install.lines.some((line) => /success/i.test(line))

          // HSP-split projects: entry alone fails with 9568305 "dependent
          // module does not exist". Stage the signed HSPs and retry the entry
          // HAP until it installs. The device reports one missing module per
          // attempt, and an HSP can depend on another HSP, so this needs
          // several rounds and an "already installed" set.
          const staged = []
          const stagedOk = new Set()
          if (!installed && /dependent module does not exist/i.test(install.lines.join('\n'))) {
            const hsps = sharedPackages(compiled.data.projectDir)
            for (let attempt = 0; attempt < 4 && !installed; attempt += 1) {
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
              if (!progress && staged.every((item) => !item.ok || stagedOk.has(item.hap))) break
            }
          }
          const installErrors = parseOutput(install.lines).errors
          if (!installed) {
            const hint = !compiled.data.signed && compiled.data.signingConfigured === false
              ? '\n\n提示：这个 HAP 未签名且工程没有 signingConfigs，真机会拒绝安装。先在 DevEco Studio 里配好自动签名。'
              : ''
            const staging = staged.length > 0
              ? `\n\n已尝试预装 ${staged.length} 个 HSP（成功 ${staged.filter((s) => s.ok).length} 个）：\n${staged.map((s) => `- ${s.ok ? 'ok' : 'FAIL'} ${s.hap}${s.error ? `\n    ${s.error}` : ''}`).join('\n')}`
              : /dependent module does not exist/i.test(install.lines.join('\n'))
                ? '\n\n这是 HSP 拆分工程：entry 依赖的共享模块还没装到设备上。用 hsp: true 重跑一次 action=run（或先 action=build hsp:true 再 deploy），让共享模块与本 HAP 一起构建后按序安装。'
                : ''
            return {
              action: 'run',
              ok: false,
              summary: `run 在「安装」阶段失败（${device}，exit=${install.exitCode ?? 'null'}）。\n\n${installErrors.length > 0 ? formatErrors(installErrors) : install.lines.slice(-15).join('\n')}${staging}${hint}`,
              data: { stage: 'install', build: compiled.data, hap, device, staged, errors: installErrors },
            }
          }

          let started = false
          let startTail = []
          if (bundleName && ability) {
            const start = await runCommand(hdc.command, ['-t', device, 'shell', 'aa', 'start', '-a', ability, '-b', bundleName], {
              timeoutMs: 60_000,
              signal: exec?.signal,
            })
            started = start.exitCode === 0 && !/error/i.test(start.lines.join('\n'))
            startTail = start.lines.slice(-8)
          }

          const logs = await captureLogs(exec, { device, bundleName, seconds: args.seconds ?? 6 })
          const signals = logs.lines.filter((line) => CRASH_SIGNAL.test(line) && (!bundleName || line.includes(bundleName) || true))
          const crashed = signals.length > 0

          const lines = [
            `harmony run 完成（${device}）`,
            `编译：成功（${Math.round(compiled.data.durationMs / 1000)}s，${compiled.data.artifacts.length} 个产物${compiled.data.signed ? '，已签名' : '，未签名'}）`,
            `安装：成功（${hap}）`,
            ...(staged.length > 0 ? [`预装：${staged.length} 个 HSP（失败 ${staged.filter((s) => !s.ok).length} 个）`] : []),
            started ? `启动：成功（${ability} / ${bundleName}）` : `启动：未执行或失败${bundleName && ability ? '' : '（工程里没推断出 bundleName/ability，可显式传参）'}`,
            crashed ? `运行：日志里有 ${signals.length} 条疑似崩溃信号` : `运行：最近 ${logs.seconds}s 日志没有明显崩溃信号（${logs.captured} 行）`,
          ]
          if (!started && startTail.length > 0) lines.push(`启动输出：\n${startTail.join('\n')}`)
          if (crashed) lines.push(`崩溃信号：\n${signals.slice(-8).join('\n')}`)
          if (compiled.data.hints.length > 0) lines.push(`提示：\n${compiled.data.hints.map((h) => `- ${h}`).join('\n')}`)
          if (!crashed && logs.lines.length === 0) lines.push('日志为空：确认应用确实启动，且 hilog 没有被系统缓冲吞掉。')

          return {
            action: 'run',
            ok: install.exitCode === 0,
            summary: lines.join('\n\n'),
            data: {
              stage: crashed ? 'runtime' : 'done',
              build: compiled.data,
              hap,
              device,
              bundleName,
              ability,
              started,
              crashed,
              crashSignals: signals.slice(-8),
              logLines: logs.lines.slice(-40),
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
