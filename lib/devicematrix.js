/**
 * Per-device plans for one `run`: instead of installing the same HAP on every
 * connected device the same way, each line says what that device is for.
 *
 *   "009180680c438f8f=run;03516892320539=install"
 *
 * Actions:
 *   run       install, launch, capture logs (the default when only an id is given)
 *   install   install only — leaves the device untouched afterwards
 *   uninstall install, launch, capture logs, then remove the app again
 *
 * Parsing is pure so the tool and the tests share one interpretation of the
 * syntax; the caller validates the ids against `hdc list targets` because only
 * it knows what is actually connected.
 */

export const MATRIX_ACTIONS = ['run', 'install', 'uninstall']

/**
 * @param {string} spec e.g. "id=run;id=install" (action optional).
 * @param {string[]} connected ids currently attached; empty means "do not check".
 * @returns {{ entries: { device: string, action: string }[], errors: string[], unknown: string[] }}
 */
export function parseDeviceMatrix(spec, connected = []) {
  const entries = []
  const errors = []
  const unknown = []

  if (typeof spec !== 'string' || spec.trim() === '') {
    return {
      entries,
      errors: ['matrix 为空：写成 "设备id=动作;设备id=动作"，动作可选 run / install / uninstall'],
      unknown,
    }
  }

  const seen = new Set()
  for (const raw of spec.split(';')) {
    const item = raw.trim()
    if (!item) continue
    const eq = item.lastIndexOf('=')
    const device = (eq === -1 ? item : item.slice(0, eq)).trim()
    const action = (eq === -1 ? 'run' : item.slice(eq + 1)).trim().toLowerCase()
    if (!device) {
      errors.push(`「${item}」缺少设备 id`)
      continue
    }
    if (!MATRIX_ACTIONS.includes(action)) {
      errors.push(`「${item}」的动作 ${action} 不认识（可用 ${MATRIX_ACTIONS.join(' / ')}）`)
      continue
    }
    if (seen.has(device)) {
      errors.push(`设备 ${device} 在 matrix 里出现了两次`)
      continue
    }
    seen.add(device)
    entries.push({ device, action })
  }

  if (entries.length === 0 && errors.length === 0) errors.push('matrix 里没有任何设备')

  const known = new Set(connected)
  if (connected.length > 0) {
    for (const entry of entries) if (!known.has(entry.device)) unknown.push(entry.device)
  }

  return { entries, errors, unknown }
}

/**
 * One line per device for the summary table. Kept next to the parser so both
 * stay in sync when an action is added.
 *
 * @param {{ device: string, action: string, installed: boolean, started: boolean|null, logLines: number|null, crashed: boolean, uninstalled: boolean|null }} row
 */
export function formatMatrixRow(row) {
  const mark = (value) => (value === null ? '—' : value ? '✓' : '✗')
  const logs = row.logLines === null ? '—' : `${row.logLines} 行`
  const parts = [
    row.device,
    row.action,
    `装机 ${mark(row.installed)}`,
    `启动 ${row.started === null ? '—' : mark(row.started)}`,
    `日志 ${logs}`,
  ]
  if (row.crashed) parts.push('崩溃信号')
  if (row.action === 'uninstall') parts.push(`卸载 ${row.uninstalled === null ? '—' : mark(row.uninstalled)}`)
  return `- ${parts.join(' · ')}`
}
