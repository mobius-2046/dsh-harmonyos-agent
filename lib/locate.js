import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

export const isWindows = process.platform === 'win32'

/**
 * The isolated `HVIGOR_USER_HOME` used when the real profile may be read-only.
 * @returns {string}
 */
export function hvigorHome() {
  return join(tmpdir(), 'dsh-harmony-hvigor-home')
}

/**
 * Whether an isolated hvigor home can work at all.
 *
 * hvigor refuses to run without `<HVIGOR_USER_HOME>/wrapper/tools` and cannot
 * install it on Windows (its bootstrap spawns `npm.cmd` without a shell). So
 * isolation is only safe when a wrapper can be seeded from the real profile.
 *
 * @returns {boolean}
 */
export function canIsolateHvigorHome() {
  const shim = join('wrapper', 'tools', 'node_modules', '.bin', 'pnpm')
  try {
    if (existsSync(join(hvigorHome(), shim))) return true
    return existsSync(join(process.env.USERPROFILE ?? homedir(), '.hvigor', shim))
  } catch {
    return false
  }
}

/**
 * Whether the real `~/.hvigor` can be written this session.
 *
 * The decision is "writable?" rather than "which cache is warmer?" because the
 * user-facing trade is speed: sharing is faster (70 s vs 87 s on a 23-module
 * project, since the open IDE keeps that cache warm), and it only has to be
 * abandoned when the directory cannot be written at all — a sandboxed session
 * may not be able to.
 *
 * The probe performs a real write. `access(W_OK)` is not enough on Windows:
 * directory ACLs can report writable and still deny creating a file.
 *
 * @returns {boolean}
 */
export function canWriteHvigorHome() {
  const home = join(process.env.USERPROFILE ?? homedir(), '.hvigor')
  const probe = join(home, `.dsh-harmony-probe-${process.pid}`)
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Decide whether this build should isolate its hvigor home.
 *
 * Sharing `~/.hvigor` is the default because it is faster: the IDE that is
 * usually open keeps that cache warm, and a second cold copy cost ~40 s per
 * switch. Isolation is the fallback for sessions that cannot write there
 * (sandboxed or read-only profile), not a precaution against concurrent
 * writers — those are tolerated, and the worst case is a rebuild.
 *
 * @param {{ requested?: boolean, writable?: boolean, canIsolate?: boolean }} input
 *   explicit flag, writability of `~/.hvigor`, wrapper availability.
 * @returns {{ isolated: boolean, reason: string }} decision.
 */
export function resolveHvigorIsolation(input = {}) {
  const writable = input.writable ?? canWriteHvigorHome()
  const canIsolate = input.canIsolate ?? canIsolateHvigorHome()
  if (input.requested === true) {
    return { isolated: true, reason: '按你的要求使用隔离的 hvigor home' }
  }
  if (input.requested === false) {
    return { isolated: false, reason: '按你的要求共用 ~/.hvigor' }
  }
  if (writable) {
    return { isolated: false, reason: 'DevEco 暖着的缓存可以直接用；隔离要冷启动，多花 15–40 秒' }
  }
  if (canIsolate) {
    return { isolated: true, reason: '~/.hvigor 不可写（沙箱或只读配置），改用隔离目录' }
  }
  return { isolated: false, reason: '~/.hvigor 不可写，也没有可复用的 wrapper，只能用真实目录（构建可能失败）' }
}
/**
 * Seed an isolated hvigor home with the pnpm wrapper hvigor would otherwise
 * install itself.
 *
 * `hvigorw.js` decides pnpm is ready by checking
 * `<HVIGOR_USER_HOME>/wrapper/tools/node_modules/.bin/pnpm`, and only then runs
 * `npm.cmd install pnpm` — a call that fails immediately on Windows because it
 * spawns the `.cmd` without a shell ("No stdout output", error 00308002). The
 * real profile already holds a working wrapper, so copying it (about 13 MB,
 * once) lets the isolated home skip the broken bootstrap entirely.
 *
 * @returns {string} the isolated home, ready to hand to `HVIGOR_USER_HOME`.
 */
export function prepareHvigorHome() {
  const dest = hvigorHome()
  try {
    mkdirSync(dest, { recursive: true })
    const shim = join(dest, 'wrapper', 'tools', 'node_modules', '.bin', 'pnpm')
    const source = join(process.env.USERPROFILE ?? homedir(), '.hvigor', 'wrapper', 'tools')
    if (!existsSync(shim) && existsSync(source)) {
      cpSync(source, join(dest, 'wrapper', 'tools'), { recursive: true, force: false, errorOnExist: false })
    }
  } catch {}
  return dest
}

/**
 * Environment overrides for toolchain children.
 *
 * Redirects hvigor's *own* home through `HVIGOR_USER_HOME` rather than the
 * process `USERPROFILE`/`HOME`: the latter also hides `~/.npmrc` from the npm
 * runs inside hvigor, which broke package resolution for reasons unrelated to
 * caching. `HVIGOR_USER_HOME` is an absolute directory hvigor creates itself.
 *
 * @param {boolean} isolateHome whether to use an isolated hvigor home.
 * @returns {Record<string, string>}
 */
export function toolchainEnv(isolateHome) {
  if (!isolateHome) return {}
  return { HVIGOR_USER_HOME: prepareHvigorHome() }
}

/**
 * The version declared by a DevEco Studio installation, when readable.
 * @param {string} root installation directory.
 * @returns {string} dotted version, or an empty string.
 */
function devecoVersion(root) {
  try {
    const info = JSON.parse(readFileSync(join(root, 'product-info.json'), 'utf8'))
    return typeof info.version === 'string' ? info.version : ''
  } catch {
    return ''
  }
}

/**
 * Compare dotted numeric versions, newest first.
 * @param {string} a left version.
 * @param {string} b right version.
 * @returns {number}
 */
function compareVersions(a, b) {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10)).filter(Number.isFinite)
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10)).filter(Number.isFinite)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Candidate DevEco Studio installations, newest first.
 *
 * Directory names alone are not orderable: `DevEco Studio602` sorts after
 * `DevEco Studio 611` because a digit beats a space, so a lexical sort selected
 * a 6.0.2 install over 6.1.1 on this machine. Each candidate's own
 * `product-info.json` carries the real version, which is what the sort uses.
 *
 * @returns {string[]}
 */
export function devecoRoots() {
  const entries = []
  const add = (root, priority) => {
    if (root) entries.push({ root, priority, version: devecoVersion(root) })
  }
  add(process.env.DEVECO_STUDIO_HOME, 1)
  const bases = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Huawei'),
    join(process.env.LOCALAPPDATA ?? '', 'Huawei'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DevEco Studio'),
  ]
  for (const base of bases) {
    let names = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const name of names) {
      if (/deveco/i.test(name)) add(join(base, name), 0)
    }
  }
  const seen = new Set()
  return entries
    .filter((entry) => (seen.has(entry.root) ? false : seen.add(entry.root)))
    .sort((a, b) => b.priority - a.priority || compareVersions(a.version, b.version))
    .map((entry) => entry.root)
}

/**
 * Resolve the first existing candidate path.
 * @param {string[]} candidates absolute paths, best first.
 * @returns {string | undefined}
 */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return undefined
}

/**
 * Locate the hvigor wrapper for a project: the project's own wrapper wins,
 * then the DevEco Studio bundle, then PATH.
 * @param {string} projectDir project root.
 * @returns {{ command: string, source: string }}
 */
export function resolveHvigorw(projectDir) {
  const local = firstExisting(isWindows
    ? [join(projectDir, 'hvigorw.bat'), join(projectDir, 'hvigorw.cmd')]
    : [join(projectDir, 'hvigorw')])
  if (local) return { command: local, source: 'project' }

  const fromDeveco = []
  for (const root of devecoRoots()) {
    fromDeveco.push(
      join(root, 'tools', 'hvigor', 'bin', isWindows ? 'hvigorw.bat' : 'hvigorw'),
      join(root, 'tools', 'hvigor', 'bin', 'hvigorw'),
    )
  }
  const found = firstExisting(fromDeveco)
  if (found) return { command: found, source: 'deveco' }

  return { command: isWindows ? 'hvigorw.bat' : 'hvigorw', source: 'path' }
}

/**
 * Locate the ohpm CLI.
 * @returns {{ command: string, source: string }}
 */
export function resolveOhpm() {
  const candidates = []
  for (const root of devecoRoots()) {
    candidates.push(
      join(root, 'tools', 'ohpm', 'bin', isWindows ? 'ohpm.bat' : 'ohpm'),
      join(root, 'tools', 'ohpm', 'bin', 'ohpm'),
    )
  }
  const found = firstExisting(candidates)
  if (found) return { command: found, source: 'deveco' }
  return { command: isWindows ? 'ohpm.bat' : 'ohpm', source: 'path' }
}

/**
 * Locate hdc, preferring PATH (a PATH hdc is what the user's shell sees).
 * @returns {{ command: string, source: string }}
 */
export function resolveHdc() {
  const candidates = []
  const sdkHome = process.env.DEVECO_SDK_HOME ?? process.env.HOS_SDK_HOME
  if (sdkHome) {
    candidates.push(
      join(sdkHome, 'default', 'openharmony', 'toolchains', isWindows ? 'hdc.exe' : 'hdc'),
      join(sdkHome, 'openharmony', 'toolchains', isWindows ? 'hdc.exe' : 'hdc'),
    )
  }
  for (const root of devecoRoots()) {
    candidates.push(
      join(root, 'sdk', 'default', 'openharmony', 'toolchains', isWindows ? 'hdc.exe' : 'hdc'),
    )
  }
  const found = firstExisting(candidates)
  if (found) return { command: found, source: 'sdk' }
  return { command: 'hdc', source: 'path' }
}

/**
 * Locate `hap-sign-tool.jar` (sign-app / verify-app live inside it).
 *
 * It ships with the SDK under `toolchains/lib`, so it is found through
 * `DEVECO_SDK_HOME` first and the DevEco install second. A project that carries
 * its own copy (many teams vendor the tool next to their signing material)
 * wins only when the SDK cannot supply one — the SDK copy is the version the
 * installed hvigor already uses, and signing with a mismatched tool produces
 * HAPs the device rejects with an unhelpful code.
 *
 * @param {string} [projectDir] project that may vendor a copy.
 * @returns {{ path: string, source: 'sdk' | 'deveco' | 'project' } | undefined}
 */
export function resolveSignTool(projectDir) {
  const relative = ['toolchains', 'lib', 'hap-sign-tool.jar']
  const candidates = []
  const sdkHome = process.env.DEVECO_SDK_HOME ?? process.env.HOS_SDK_HOME
  if (sdkHome) {
    candidates.push([join(sdkHome, 'default', 'openharmony', ...relative), 'sdk'])
    candidates.push([join(sdkHome, 'openharmony', ...relative), 'sdk'])
  }
  for (const root of devecoRoots()) {
    candidates.push([join(root, 'sdk', 'default', 'openharmony', ...relative), 'deveco'])
  }
  if (projectDir) candidates.push([join(projectDir, 'signature', 'hap-sign-tool.jar'), 'project'])
  for (const [path, source] of candidates) {
    try {
      if (existsSync(path)) return { path, source }
    } catch {}
  }
  return undefined
}

/**
 * Locate a Java runtime for `hap-sign-tool.jar`.
 *
 * DevEco bundles a JBR under `<root>/jbr`, which is the runtime its own build
 * uses; a PATH `java` is the fallback. Java is *not* required for building, so
 * a missing runtime must read as "signing unavailable, here is why" rather
 * than as a crash.
 *
 * @returns {{ command: string, source: 'jbr' | 'path', version?: string }}
 */
export function resolveJava() {
  const candidates = []
  for (const root of devecoRoots()) {
    candidates.push([join(root, 'jbr', 'bin', isWindows ? 'java.exe' : 'java'), 'jbr'])
  }
  for (const [path, source] of candidates) {
    try {
      if (existsSync(path)) return { command: path, source }
    } catch {}
  }
  return { command: 'java', source: 'path' }
}

/**
 * Walk up from a directory to the nearest HarmonyOS project root.
 *
 * A module directory also carries `build-profile.json5` and `hvigorfile.ts`, so
 * neither identifies a project. `AppScope/` is the app-level directory and only
 * exists at the root, which makes it the reliable marker.
 *
 * @param {string} startDir starting directory.
 * @param {number} maxDepth how many ancestors to inspect.
 * @returns {string | undefined}
 */
export function findProject(startDir, maxDepth = 12) {
  let dir = startDir
  for (let i = 0; i <= maxDepth; i += 1) {
    try {
      if (existsSync(join(dir, 'build-profile.json5')) && existsSync(join(dir, 'AppScope'))) return dir
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

// `build` is deliberately absent: it is where hvigor writes the `.hap` this
// search exists to find. Skipping it made a successful build report no
// artifacts at all.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hvigor', '.idea', 'oh_modules'])

/**
 * Collect `.hap` artifacts under a project, newest first.
 * @param {string} projectDir project root.
 * @param {number} limit maximum entries.
 * @returns {Array<{ path: string, size: number, modifiedMs: number }>}
 */
export function findHaps(projectDir, limit = 8) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        walk(full, depth + 1)
      } else if (name.toLowerCase().endsWith('.hap')) {
        found.push({ path: full, size: info.size, modifiedMs: info.mtimeMs })
      }
    }
  }
  walk(projectDir, 0)
  return found.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, limit)
}
