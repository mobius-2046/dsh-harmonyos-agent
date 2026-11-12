import { runCommand } from './exec.js'
import { resolveHdc } from './locate.js'

/**
 * One round trip per device. Every value is printed as `KEY=value`, so the
 * parser never depends on command order and a failing `param get` only blanks
 * one field instead of shifting the rest.
 *
 * Sources, all readable without root on a normal HarmonyOS device:
 *   const.product.model              → 机型
 *   const.product.software.version   → 系统版本
 *   const.ohos.apiversion            → API 版本
 *   /sys/class/power_supply/battery  → 电量 / 温度 / 电压 / 充电状态
 *   /proc/uptime, /proc/meminfo      → 已开机时长 / 内存
 *   df -k /data                      → 用户数据分区占用
 */
const SCRIPT = [
  'echo M=$(param get const.product.model)',
  'echo S=$(param get const.product.software.version)',
  'echo A=$(param get const.ohos.apiversion)',
  'echo B=$(cat /sys/class/power_supply/battery/capacity)',
  'echo T=$(cat /sys/class/power_supply/battery/temp)',
  'echo V=$(cat /sys/class/power_supply/battery/voltage_now)',
  'echo C=$(cat /sys/class/power_supply/battery/status)',
  'echo U=$(cut -d" " -f1 /proc/uptime)',
  'echo MT=$(grep MemTotal /proc/meminfo)',
  'echo MA=$(grep MemAvailable /proc/meminfo)',
  'echo D=$(df -k /data | tail -1)',
].join('; ')

function num(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function text(value) {
  return String(value ?? '').trim().replace(/^"/, '').replace(/"$/, '').trim()
}

/**
 * Parse the `KEY=value` block printed by SCRIPT.
 *
 * Every field is optional: an old device may not expose a battery node, a
 * non-HarmonyOS target may not answer `param get` at all, and the badge still
 * has to render the id. Absent fields are omitted instead of guessed.
 *
 * @param {string} id device id from `hdc list targets`.
 * @param {string} output raw shell output.
 * @returns {object} device info, always carrying `id`.
 */
export function parseDeviceInfo(id, output) {
  const raw = {}
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^([A-Z]{1,2})=(.*)$/.exec(line.trim())
    if (match !== null) raw[match[1]] = match[2]
  }

  const info = { id }

  const model = text(raw.M)
  if (model !== '' && model !== 'null') info.model = model

  const osVersion = text(raw.S)
  if (osVersion !== '' && osVersion !== 'null') info.osVersion = osVersion

  const apiVersion = num(raw.A)
  if (apiVersion !== undefined) info.apiVersion = apiVersion

  const level = num(raw.B)
  if (level !== undefined && level >= 0 && level <= 100) info.batteryLevel = level

  // The kernel reports tenths of a degree; 330 means 33.0 °C.
  const temp = num(raw.T)
  if (temp !== undefined && temp > 100) info.batteryTempC = Math.round(temp / 10)

  const voltage = num(raw.V)
  if (voltage !== undefined && voltage > 0) info.batteryVoltageMv = Math.round(voltage / 1000)

  const status = text(raw.C)
  if (status !== '') info.chargingStatus = status

  const uptime = num(raw.U)
  if (uptime !== undefined) info.uptimeSeconds = Math.round(uptime)

  const memTotalKb = num(/MemTotal:\s*(\d+)/.exec(raw.MT ?? '')?.[1])
  const memFreeKb = num(/MemAvailable:\s*(\d+)/.exec(raw.MA ?? '')?.[1])
  if (memTotalKb !== undefined) {
    info.memoryTotalMb = Math.round(memTotalKb / 1024)
    if (memFreeKb !== undefined) info.memoryAvailableMb = Math.round(memFreeKb / 1024)
  }

  const df = String(raw.D ?? '').trim().split(/\s+/)
  if (df.length >= 5) {
    const totalKb = num(df[1])
    const usedKb = num(df[2])
    const percent = num(String(df[4]).replace('%', ''))
    if (totalKb !== undefined && totalKb > 0) {
      info.storageTotalMb = Math.round(totalKb / 1024)
      if (usedKb !== undefined) info.storageUsedMb = Math.round(usedKb / 1024)
      if (percent !== undefined) info.storageUsedPercent = percent
    }
  }

  return info
}

/**
 * Read one device's info. Never throws: a timeout or a disconnect degrades to
 * `{ id }` so the device still appears in the list.
 *
 * @param {string} device device id.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>}
 */
export async function collectDeviceInfo(device, options = {}) {
  try {
    const hdc = resolveHdc().command
    const result = await runCommand(hdc, ['-t', device, 'shell', SCRIPT], {
      timeoutMs: options.timeoutMs ?? 20_000,
    })
    if (result.spawnError !== undefined || result.exitCode !== 0) return { id: device }
    return parseDeviceInfo(device, result.lines.join('\n'))
  } catch {
    return { id: device }
  }
}

/**
 * Read every connected device in parallel.
 * @param {string[]} devices device ids.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object[]>}
 */
export async function collectDevicesInfo(devices, options = {}) {
  return Promise.all(devices.map((id) => collectDeviceInfo(id, options)))
}
