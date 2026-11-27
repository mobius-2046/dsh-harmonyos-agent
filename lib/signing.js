import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { userInfo } from 'node:os'

const MATERIAL_KEYS = ['certpath', 'profile', 'storeFile', 'keyAlias', 'signAlg', 'keyPassword', 'storePassword']

/** Strip // and block comments without touching quoted strings. */
function stripComments(text) {
  let out = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 1
      } else if (ch === quote) {
        quote = ''
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/** Slice the top-level `{ ... }` objects out of an array body. */
function splitObjects(body) {
  const parts = []
  let depth = 0
  let start = -1
  let quote = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote !== '') {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        parts.push(body.slice(start, i + 1))
        start = -1
      }
    }
  }
  return parts
}

function stringField(object, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(object)
  return match === null ? '' : match[1]
}

/**
 * Read `signingConfigs` out of a build-profile.json5 source. Returns
 * [{ name, material: { certpath, profile, storeFile, keyAlias, signAlg, hasKeyPassword, hasStorePassword } }]
 * and the signing config names referenced by products.
 */
export function parseSigningConfigs(source) {
  const clean = stripComments(source)
  const key = clean.indexOf('"signingConfigs"')
  if (key === -1) return { configs: [], referenced: [], products: [] }

  const open = clean.indexOf('[', key)
  if (open === -1) return { configs: [], referenced: [], products: [] }
  let depth = 0
  let end = -1
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === '[') depth += 1
    else if (clean[i] === ']') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = end === -1 ? clean.slice(open + 1) : clean.slice(open + 1, end)

  const configs = splitObjects(body).map((object) => {
    const material = {}
    for (const field of MATERIAL_KEYS) material[field] = ''
    for (const field of MATERIAL_KEYS) material[field] = stringField(object, field)
    const hasKeyPassword = material.keyPassword !== ''
    const hasStorePassword = material.storePassword !== ''
    delete material.keyPassword
    delete material.storePassword
    return {
      name: stringField(object, 'name'),
      material: { ...material, hasKeyPassword, hasStorePassword },
    }
  })

  const productsPart = clean.slice(end === -1 ? 0 : end)
  const referenced = [...productsPart.matchAll(/"signingConfig"\s*:\s*"([^"]*)"/g)].map((m) => m[1])
  const products = [...productsPart.matchAll(/"name"\s*:\s*"([^"]*)"/g)].map((m) => m[1])
  return { configs, referenced, products }
}

/** Certificate facts, or { error } when the file is not a certificate. */
export function inspectCertificate(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    return { error: `读不到证书：${error instanceof Error ? error.message : String(error)}` }
  }
  let cert
  try {
    cert = new X509Certificate(buffer)
  } catch (error) {
    return { error: `不是有效的 X.509 证书：${error instanceof Error ? error.message : String(error)}` }
  }
  const now = Date.now()
  const to = Date.parse(cert.validTo)
  const from = Date.parse(cert.validFrom)
  const daysLeft = Number.isFinite(to) ? Math.floor((to - now) / 86_400_000) : null
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    daysLeft,
    expired: Number.isFinite(to) ? to < now : false,
    notYetValid: Number.isFinite(from) ? from > now : false,
    fingerprint: cert.fingerprint256,
  }
}

function sameFile(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : 0
  } catch {
    return -1
  }
}

/** Looks like DevEco's locally encrypted password blob (only DevEco can decrypt it). */
function looksEncrypted(value) {
  return /^[0-9A-F]{60,}$/i.test(value) && value.length % 2 === 0
}

/**
 * Which user profile do these material paths belong to, if not the current one?
 *
 * DevEco writes absolute paths into `build-profile.json5` (`C:/Users/mym/.ohos/...`).
 * Open the project as another Windows user — or copy it from another machine —
 * and the paths survive while the files do not: every build then fails in
 * SignHap with a bare `[00303107] Configuration Error` that names no path.
 *
 * @param {string[]} paths material paths from the signing config.
 * @param {string} [current] user name to compare against (default: this process's).
 * @returns {string | null} the foreign user name, or null when they are ours.
 */
export function foreignProfileOwner(paths, current = safeUserName()) {
  if (!current) return null
  for (const path of paths) {
    const match = /^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)[\\/]/i.exec(String(path ?? ''))
    if (!match) continue
    if (match[1].toLowerCase() !== current.toLowerCase()) return match[1]
  }
  return null
}

function safeUserName() {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/**
 * Everything `action=sign` reports: which config the product uses, whether the
 * three material files exist, and what the certificate says.
 */
export function signingReport(source, { exists = (path) => sameFile(path) >= 0 } = {}) {
  const parsed = parseSigningConfigs(source)
  const config = parsed.configs[0] ?? null
  if (config === null) {
    return { found: false, configs: [], referenced: parsed.referenced, materials: [], certificate: null, foreignOwner: null }
  }
  const materials = [
    ['证书 (certpath)', config.material.certpath],
    ['Profile (p7b)', config.material.profile],
    ['密钥库 (p12)', config.material.storeFile],
  ].map(([label, path]) => ({
    label,
    path,
    exists: path !== '' && exists(path),
    size: path !== '' ? sameFile(path) : -1,
  }))
  const certificate = config.material.certpath !== '' && exists(config.material.certpath)
    ? inspectCertificate(config.material.certpath)
    : null
  return {
    found: true,
    config,
    configs: parsed.configs,
    referenced: parsed.referenced,
    products: parsed.products,
    materials,
    certificate,
    devEcoEncrypted: looksEncryptedRaw(source),
    foreignOwner: foreignProfileOwner(materials.map((material) => material.path)),
  }
}

function looksEncryptedRaw(source) {
  const match = /"(?:storePassword|keyPassword)"\s*:\s*"([^"]*)"/.exec(source)
  return match === null ? false : looksEncrypted(match[1])
}

/**
 * Turn the parsed material paths into absolute ones.
 *
 * `build-profile.json5` stores them relative to the project root, but
 * hap-sign-tool is spawned from an arbitrary working directory, so a relative
 * path would resolve against the wrong folder and fail with `file not found`
 * that looks like a missing material.
 *
 * @param {{certpath: string, profile: string, storeFile: string}} material
 * @param {string} projectDir
 * @returns {{keystorePath: string, certPath: string, profilePath: string}}
 */
export function absoluteMaterials(material, projectDir) {
  const resolve = (value) => (isAbsolute(value) ? value : join(projectDir, value))
  return {
    keystorePath: material.storeFile === '' ? '' : resolve(material.storeFile),
    certPath: material.certpath === '' ? '' : resolve(material.certpath),
    profilePath: material.profile === '' ? '' : resolve(material.profile),
  }
}

/**
 * Pick the package to sign: an explicit path, else the newest unsigned HAP.
 *
 * Signing the *signed* artifact in place is how `02_resignHap.bat` works, but
 * for an agent tool that is a trap: a failed sign would overwrite a good HAP.
 * The unsigned artifact is the honest input, and the output always gets a
 * distinct name.
 *
 * @param {{explicit?: string, haps: {path: string, name: string, mtimeMs: number}[], prefer?: 'unsigned' | 'signed'}} input
 * @returns {string | undefined}
 */
export function pickSignInput({ explicit, haps, prefer = 'unsigned' }) {
  if (explicit) return explicit
  // findHaps reports {path, size, modifiedMs}; accept either shape so this
  // stays a pure helper that a test can feed by hand.
  const rows = haps.map((hap) => ({
    path: hap.path,
    name: hap.name ?? basename(hap.path),
    mtimeMs: hap.mtimeMs ?? hap.modifiedMs ?? 0,
  }))
  // Signing reads the unsigned artifact; verifying reads the signed one. Picking
  // the wrong half makes both verbs look broken for reasons that are not theirs.
  const wanted = prefer === 'signed' ? /-signed\.hap$/i : /-unsigned\.hap$/i
  const matching = rows.filter((hap) => wanted.test(hap.name))
  const pool = matching.length > 0 ? matching : rows
  return pool
    .slice()
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((hap) => hap.path)[0]
}

/**
 * Verify a signed package with `hap-sign-tool verify-app`.
 *
 * `verify-app` insists on writing the extracted cert chain and profile, so both
 * go to the temp directory and are removed afterwards — a verification must not
 * leave files in the project.
 *
 * @param {{java: string, tool: string, inFile: string, tmpDir: string, run: Function}} input
 */
export async function verifyApp(input) {
  const certOut = join(input.tmpDir, `verify-${Date.now()}.cer`)
  const profileOut = join(input.tmpDir, `verify-${Date.now()}.p7b`)
  const result = await input.run(input.java, [
    '-jar', input.tool, 'verify-app',
    '-inFile', input.inFile,
    '-outCertChain', certOut,
    '-outProfile', profileOut,
  ], { timeoutMs: 120000 })
  const text = result.lines.join('\n')
  const ok = result.exitCode === 0 && /verify success|success/i.test(text) && !/ERROR|fail/i.test(text)
  return { ok, lines: result.lines, exitCode: result.exitCode, certOut, profileOut }
}
