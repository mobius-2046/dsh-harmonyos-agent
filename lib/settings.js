/**
 * Where the offline knowledge lives.
 *
 * The docs checkout is a property of the machine, not of the plugin, so it
 * must never be baked into the package: one user keeps a 6 GB OpenHarmony docs
 * clone on D:, another has nothing. Resolution order is env → config file →
 * built-in defaults, and everything is reported back by `harmony action=docs
 * op=config` so "why is search empty" is answerable without reading code.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** JSON file, next to the DSH profile but owned by this plugin. */
export function settingsPath() {
  if (process.env.DSH_HARMONY_CONFIG) return process.env.DSH_HARMONY_CONFIG
  const home = process.env.USERPROFILE || homedir()
  return join(home, '.dsh', 'dsh-harmony.json')
}

/** @returns {{ docsDirs?: string[], apiSdkRoot?: string }} never throws */
export function readSettings() {
  const path = settingsPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge `patch` into the config file, replacing it atomically.
 *
 * A half-written settings file would break every later run, so the JSON is
 * serialized first and moved into place with a rename.
 *
 * @param {object} patch keys to set.
 * @returns {string} the path written.
 */
export function writeSettings(patch) {
  const path = settingsPath()
  const merged = { ...readSettings(), ...patch }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
  return path
}

/**
 * @param {{ docsDirs?: string[], apiSdkRoot?: string }} settings
 * @returns {{ dirs: string[], sdkRoot: string, source: 'env'|'file'|'none' }}
 */
export function resolveKnowledge(settings) {
  const envDirs = (process.env.DSH_HARMONY_DOCS_DIRS ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (envDirs.length > 0) {
    return { dirs: envDirs, sdkRoot: settings.apiSdkRoot ?? '', source: 'env' }
  }
  const dirs = Array.isArray(settings.docsDirs) ? settings.docsDirs.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : []
  if (dirs.length > 0) {
    return { dirs, sdkRoot: settings.apiSdkRoot ?? '', source: 'file' }
  }
  return { dirs: [], sdkRoot: settings.apiSdkRoot ?? '', source: 'none' }
}
