import { runCommand } from './exec.js'

/**
 * Thresholds for the hdc server, in the units the sampler reports.
 *
 * They come from one observed failure, not from a specification: a server left
 * running for two days held 5.4 GB of virtual memory and burned 17% of a core
 * in a retry loop over dead sockets, while a *freshly restarted* server on the
 * same machine already sat at 136 threads and 5.2 GB. So threads and virtual
 * memory are baseline noise; sustained CPU and growth are the real signals.
 * Nothing here can fix Huawei's server — the point is to notice before it
 * reaches 32 GB, which is what a system resource-exhaustion record showed on
 * this machine in October.
 */
export const HDC_THRESHOLDS = {
  threadsWarn: 160,
  threadsCritical: 240,
  virtualGbWarn: 6,
  virtualGbCritical: 10,
  cpuCoresWarn: 0.05,
  cpuCoresCritical: 0.3,
}

/**
 * Judge one sample of the hdc server.
 *
 * `critical` means "recycle it now", `warn` means "worth recycling when
 * convenient". Threads alone are not decisive — a healthy server with several
 * devices keeps a thread pool — so the point is the combination with CPU and
 * memory.
 *
 * @param {{ threads?: number, handles?: number, virtualGb?: number, cpuCores?: number, uptimeHours?: number }} sample
 * @returns {{ level: 'ok' | 'warn' | 'critical', reasons: string[] }} verdict.
 */
export function classifyHdcServer(sample = {}) {
  const reasons = []
  const threads = sample.threads ?? 0
  const virtualGb = sample.virtualGb ?? 0
  const cpuCores = sample.cpuCores ?? 0
  let level = 'ok'

  if (threads >= HDC_THRESHOLDS.threadsCritical) {
    level = 'critical'
    reasons.push(`${threads} 个线程`)
  } else if (threads > HDC_THRESHOLDS.threadsWarn) {
    level = 'warn'
    reasons.push(`${threads} 个线程`)
  }

  if (virtualGb >= HDC_THRESHOLDS.virtualGbCritical) {
    level = 'critical'
    reasons.push(`虚拟内存 ${virtualGb.toFixed(1)} GB`)
  } else if (virtualGb > HDC_THRESHOLDS.virtualGbWarn) {
    if (level === 'ok') level = 'warn'
    reasons.push(`虚拟内存 ${virtualGb.toFixed(1)} GB`)
  }

  if (cpuCores >= HDC_THRESHOLDS.cpuCoresCritical) {
    level = 'critical'
    reasons.push(`空转 ${cpuCores.toFixed(2)} 个核`)
  } else if (cpuCores > HDC_THRESHOLDS.cpuCoresWarn) {
    if (level === 'ok') level = 'warn'
    reasons.push(`空转 ${cpuCores.toFixed(2)} 个核`)
  }

  return { level, reasons }
}

/**
 * Render one sample as the single line the doctor row shows.
 * @param {object} sample sampler output.
 * @returns {string} human-readable summary.
 */
export function formatHdcServer(sample = {}) {
  const parts = []
  if (sample.pid) parts.push(`PID ${sample.pid}`)
  if (typeof sample.uptimeHours === 'number') parts.push(`已运行 ${sample.uptimeHours.toFixed(1)}h`)
  if (typeof sample.threads === 'number') parts.push(`${sample.threads} 线程`)
  if (typeof sample.handles === 'number') parts.push(`${sample.handles} 句柄`)
  if (typeof sample.virtualGb === 'number') parts.push(`虚拟内存 ${sample.virtualGb.toFixed(2)} GB`)
  if (typeof sample.cpuCores === 'number') parts.push(`CPU ${sample.cpuCores.toFixed(2)} 核`)
  return parts.join(' · ')
}

/**
 * Turn the two PowerShell snapshots into one sample.
 *
 * Time is read from the process counters (`UserModeTime + KernelModeTime`, in
 * 100 ns units) because those are monotonic and cheap; sampling wall-clock CPU
 * percentages would need a perf counter query that costs more than the answer.
 *
 * @param {{ first?: object[], second?: object[] }} raw two snapshots keyed by pid.
 * @param {{ now?: number }} [options] clock, for tests.
 * @returns {object|undefined} merged sample for the busiest server, if any.
 */
export function mergeHdcSnapshots(raw, options = {}) {
  // PowerShell collapses a one-element array to an object, so both shapes are
  // normal here rather than at every call site.
  const asList = (value) => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
  const first = asList(raw?.first)
  const second = asList(raw?.second)
  if (first.length === 0 && second.length === 0) return undefined
  const byPid = new Map()
  for (const entry of first) byPid.set(Number(entry.pid), { first: entry })
  for (const entry of second) {
    const key = Number(entry.pid)
    const slot = byPid.get(key) ?? {}
    slot.second = entry
    byPid.set(key, slot)
  }
  const samples = []
  for (const [pid, slot] of byPid) {
    const latest = slot.second ?? slot.first
    const startMs = Date.parse(latest.start ?? '')
    const firstCpu = Number(slot.first?.cpu ?? latest.cpu ?? 0)
    const secondCpu = Number(latest.cpu ?? firstCpu)
    const elapsedMs = typeof slot.first?.at === 'number' && typeof latest.at === 'number'
      ? latest.at - slot.first.at
      : 1000
    const seconds = elapsedMs > 0 ? elapsedMs / 1000 : 1
    samples.push({
      pid,
      threads: Number(latest.threads ?? 0),
      handles: Number(latest.handles ?? 0),
      virtualGb: Number(latest.vm ?? 0) / 1024 ** 3,
      workingSetMb: Number(latest.ws ?? 0) / 1024 ** 2,
      cpuCores: Math.max(0, (secondCpu - firstCpu) / 1e7 / seconds),
      uptimeHours: Number.isFinite(startMs) ? Math.max(0, ((options.now ?? Date.now()) - startMs) / 3_600_000) : undefined,
    })
  }
  return samples.sort((a, b) => b.cpuCores - a.cpuCores || b.virtualGb - a.virtualGb)[0]
}

/**
 * Read the hdc server processes twice, one second apart.
 *
 * Windows only by construction: the counters come from `Win32_Process`. Any
 * other platform reports "not applicable" instead of a fake healthy sample —
 * a doctor row that invents numbers is worse than a row that says nothing.
 *
 * @param {{ timeoutMs?: number, run?: typeof runCommand }} [options] injection points.
 * @returns {Promise<{ supported: boolean, sample?: object, error?: string }>} measurement.
 */
export async function sampleHdcServer(options = {}) {
  if (process.platform !== 'win32') return { supported: false }
  const run = options.run ?? runCommand
  // Get-Process is used instead of a CIM query: it answers the same counters in
  // ~50 ms, while Win32_Process costs several hundred milliseconds and needs a
  // nested scriptblock, which is easy to get wrong (it silently returned empty
  // arrays in the first version of this file).
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '$snap = { param($list) @($list | ForEach-Object { [pscustomobject]@{ pid = $_.Id; threads = @($_.Threads).Count; handles = $_.HandleCount; vm = $_.VirtualMemorySize64; ws = $_.WorkingSet64; cpu = [int64]($_.TotalProcessorTime.TotalSeconds * 10000000); start = $_.StartTime.ToString(\'o\'); at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }) }',
    '$first = @(Get-Process hdc -ErrorAction SilentlyContinue)',
    '$a = @(& $snap $first)',
    'Start-Sleep -Milliseconds 1000',
    '$second = @(Get-Process hdc -ErrorAction SilentlyContinue)',
    '$b = @(& $snap $second)',
    '[pscustomobject]@{ first = $a; second = $b } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ')
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: options.timeoutMs ?? 8_000,
  })
  if (result.spawnError) return { supported: true, error: result.spawnError }
  const text = (result.lines ?? []).join('\n').trim()
  if (text.length === 0) return { supported: true, error: '采样没有输出' }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { supported: true, error: '采样输出不是 JSON' }
  }
  const sample = mergeHdcSnapshots(raw)
  return sample ? { supported: true, sample } : { supported: true }
}

/**
 * Stop the hdc server and let the next command start a fresh one.
 *
 * `hdc kill` only ends the server; it restarts on the next client call, which is
 * why the restart is not a separate step here. Anything holding a device
 * channel (the IDE, a log stream) sees a two-second blip — the caller must say
 * so rather than perform this silently.
 *
 * @param {{ hdc?: string, run?: typeof runCommand, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, detail: string }>} what happened.
 */
export async function recycleHdcServer(options = {}) {
  const run = options.run ?? runCommand
  const hdc = options.hdc ?? 'hdc'
  const killed = await run(hdc, ['kill'], { timeoutMs: options.timeoutMs ?? 15_000 }).catch((error) => ({
    exitCode: -1,
    lines: [error instanceof Error ? error.message : String(error)],
  }))
  const restarted = await run(hdc, ['list', 'targets'], { timeoutMs: options.timeoutMs ?? 15_000 }).catch(() => ({ lines: [] }))
  const targets = (restarted.lines ?? []).filter((line) => line.trim() && !/^\s*\[Empty\]\s*$/.test(line))
  const killText = (killed.lines ?? []).join(' ').trim()
  return {
    ok: true,
    detail: targets.length === 0
      ? `已重启 hdc 服务${killText ? `（${killText}）` : ''}，当前没有连接的设备`
      : `已重启 hdc 服务${killText ? `（${killText}）` : ''}，当前 ${targets.length} 台设备`,
  }
}
