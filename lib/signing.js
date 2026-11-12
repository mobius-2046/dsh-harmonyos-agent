import { readFileSync, statSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'

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
 * Everything `action=sign` reports: which config the product uses, whether the
 * three material files exist, and what the certificate says.
 */
export function signingReport(source, { exists = (path) => sameFile(path) >= 0 } = {}) {
  const parsed = parseSigningConfigs(source)
  const config = parsed.configs[0] ?? null
  if (config === null) {
    return { found: false, configs: [], referenced: parsed.referenced, materials: [], certificate: null }
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
  }
}

function looksEncryptedRaw(source) {
  const match = /"(?:storePassword|keyPassword)"\s*:\s*"([^"]*)"/.exec(source)
  return match === null ? false : looksEncrypted(match[1])
}
