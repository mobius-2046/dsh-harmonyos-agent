import { spawn } from 'node:child_process'
import { createLineSplitter, runCommand } from './exec.js'
import { resolveHdc } from './locate.js'
import { collectDevicesInfo } from './deviceinfo.js'
import { getLastDevice, setLastDevice } from './selection.js'

/** Log levels hilog prints, strongest last. */
export const LOG_LEVELS = ['D', 'I', 'W', 'E', 'F']

/** How many lines the panel preloads from the device ring buffer. */
export const DEFAULT_PREFILL = 120

/** Concurrent `/api/harmony/logs` streams one Host will keep open. */
export const MAX_LOG_STREAMS = 4

/**
 * One `hilog` line, as printed by the device in its default format:
 *
 *   10-27 05:49:29.251  3036  3036 I A00000/xcommander__CommunicationHelper: "收到的是..."
 *
 * The tag may contain spaces (`A00000/test14 inner:`), so it ends at the first
 * colon after `domain/`. Wrapped continuation lines carry no prefix and are
 * reported as continuations so the panel can keep one logical entry.
 */
const HILOG_LINE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([0-9A-Fa-f]+)\/([^:]*):\s?([\s\S]*)$/

/**
 * Parse one hilog line.
 * @param {string} line raw line.
 * @returns {{time: string, pid: number, tid: number, level: string, domain: string, tag: string, message: string} | undefined}
 */
export function parseHilogLine(line) {
  const match = HILOG_LINE.exec(line)
  if (!match) return undefined
  return {
    time: match[1],
    pid: Number(match[2]),
    tid: Number(match[3]),
    level: match[4],
    domain: match[5],
    tag: match[6].trim(),
    message: match[7],
  }
}

/**
 * One protocol frame for a raw line: parsed fields, or a continuation carrying
 * only text. Unknown lines (hilog notices, wrapped stack frames) stay visible.
 * @param {string} line raw line.
 * @returns {object}
 */
export function lineFrame(line) {
  const parsed = parseHilogLine(line)
  if (parsed) return { type: 'line', ...parsed }
  return { type: 'line', continuation: true, message: line }
}

/**
 * Device ids from `hdc list targets`, dropping the empty-list placeholder.
 * @param {string[]} lines command output.
 * @returns {string[]}
 */
export function parseHdcTargets(lines) {
  const devices = []
  for (const raw of lines) {
    const id = raw.trim()
    if (id === '') continue
    if (/^\[?empty\]?$/i.test(id)) continue
    if (/^list of/i.test(id)) continue
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) continue
    if (devices.includes(id)) continue
    devices.push(id)
  }
  return devices
}

/**
 * Read the connected device list once.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, devices: string[], error?: string }>}
 */
export async function listDevices(options = {}) {
  const hdc = resolveHdc().command
  const result = await runCommand(hdc, ['list', 'targets'], { timeoutMs: options.timeoutMs ?? 15_000 })
  if (result.spawnError) return { ok: false, devices: [], error: result.spawnError }
  return { ok: result.exitCode === 0, devices: parseHdcTargets(result.lines) }
}

/**
 * Running application processes from `ps -ef`.
 *
 * The device prints `UID PID PPID C STIME TTY TIME CMD`; the CMD column is the
 * bundle name (extension processes keep their `:suffix`). Kernel threads are
 * bracketed and system services carry no dot, so a dot filter leaves the app
 * processes DevEco Studio's process selector lists.
 *
 * @param {string[]} lines command output.
 * @returns {Array<{ pid: number, name: string }>}
 */
export function parsePsOutput(lines) {
  const byPid = new Map()
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || /^UID\s+PID\b/i.test(line)) continue
    const fields = line.split(/\s+/)
    if (fields.length < 8) continue
    const pid = Number.parseInt(fields[1], 10)
    if (!Number.isFinite(pid) || pid <= 0) continue
    const name = fields[7]
    if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(name) || !name.includes('.')) continue
    if (byPid.has(pid)) continue
    byPid.set(pid, { pid, name })
  }
  return [...byPid.values()].sort((left, right) => left.name.localeCompare(right.name) || left.pid - right.pid)
}

/**
 * Read the running application processes of one device.
 * @param {string} [device] target device id; omitted uses the only device.
 * @returns {Promise<{ ok: boolean, processes: Array<{ pid: number, name: string }>, error?: string }>}
 */
export async function listProcesses(device = '') {
  const hdc = resolveHdc().command
  const target = device === '' ? [] : ['-t', device]
  const result = await runCommand(hdc, [...target, 'shell', 'ps', '-ef'], { timeoutMs: 15_000 })
  if (result.spawnError) return { ok: false, processes: [], error: result.spawnError }
  return { ok: result.exitCode === 0, processes: parsePsOutput(result.lines) }
}

/**
 * Capture the live log stream: the recent ring-buffer tail first, then a
 * blocking `hilog` follow. Frames go to `emit` until the stream ends or the
 * signal aborts.
 *
 * @param {{ device?: string, prefill?: number, signal: AbortSignal, emit: (frame: object) => void, command?: string }} options
 * @returns {Promise<void>}
 */
export async function streamHilog(options) {
  const { device = '', signal, emit } = options
  const prefill = Math.min(Math.max(options.prefill ?? DEFAULT_PREFILL, 0), 500)
  const hdc = options.command ?? resolveHdc().command
  const target = device === '' ? [] : ['-t', device]

  emit({ type: 'start', device, prefill })

  if (prefill > 0 && !signal.aborted) {
    const snapshot = await runCommand(hdc, [...target, 'shell', 'hilog', '-x', '-z', String(prefill)], {
      timeoutMs: 20_000,
      signal,
    })
    if (snapshot.spawnError) {
      emit({ type: 'error', message: `无法执行 ${hdc}：${snapshot.spawnError}` })
      return
    }
    for (const line of snapshot.lines) {
      if (line.trim() !== '') emit(lineFrame(line))
    }
  }

  if (signal.aborted) {
    emit({ type: 'end', reason: 'aborted' })
    return
  }

  await follow(hdc, target, signal, emit)
}

/**
 * Spawn the blocking `hilog` follow and relay its lines.
 * @param {string} command hdc executable.
 * @param {string[]} target `-t <id>` prefix, possibly empty.
 * @param {AbortSignal} signal cancels the follow.
 * @param {(frame: object) => void} emit frame sink.
 * @returns {Promise<void>}
 */
function follow(command, target, signal, emit) {
  return new Promise((resolve) => {
    const splitter = createLineSplitter((line) => {
      if (line.trim() !== '') emit(lineFrame(line))
    })
    const stderrTail = []
    const stderrSplitter = createLineSplitter((line) => {
      if (line.trim() === '') return
      stderrTail.push(line)
      if (stderrTail.length > 8) stderrTail.shift()
    })
    let settled = false

    const child = spawn(command, [...target, 'shell', 'hilog'], { windowsHide: true })

    const finish = (reason) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      splitter.flush()
      emit({ type: 'end', reason })
      resolve()
    }

    const onAbort = () => {
      try {
        child.kill()
      } catch {}
      // Windows hdc occasionally outlives the kill (the shell channel stays
      // half-open). Resolve anyway so the page's request and the Host's
      // concurrency slot are released; a lingering child exits on its own.
      const escape = setTimeout(() => finish('aborted-timeout'), 3000)
      if (escape.unref) escape.unref()
    }

    child.stdout?.on('data', splitter.push)
    child.stderr?.on('data', (chunk) => {
      stderrSplitter.push(chunk)
    })

    child.on('error', (error) => {
      emit({ type: 'error', message: `无法启动 hilog：${error?.message ?? String(error)}` })
      finish('spawn-error')
    })
    child.on('close', (code) => {
      stderrSplitter.flush()
      if (signal.aborted) {
        finish('aborted')
        return
      }
      if (code !== 0 && stderrTail.length > 0) {
        emit({ type: 'error', message: stderrTail.join('\n') })
        finish(`exit ${code}`)
        return
      }
      finish(code === 0 ? 'closed' : `exit ${code}`)
    })

    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Clamp a query parameter to an integer range.
 * @param {string | null} raw query value.
 * @param {number} fallback used when absent or unparsable.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number}
 */
function intParam(raw, fallback, min, max) {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/**
 * The authenticated `/api` Fetch routes this bundle owns.
 *
 * Both routes sit behind the browser-token fence of the Host's `/api` channel,
 * so only the owner page can read devices or start a capture. Responses are
 * NDJSON frames; the stream ends when the device disconnects, the page aborts
 * the request (panel unmount, pause, device switch), or the process cap is hit.
 *
 * @param {{ maxStreams?: number }} [options]
 * @returns {Array<object>} connection.fetch route definitions.
 */
export function createLogRoutes(options = {}) {
  const state = { active: 0, max: options.maxStreams ?? MAX_LOG_STREAMS }

  return [
    {
      path: '/api/harmony/logs/devices',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const result = await listDevices()
        // `devices` stays a string list (the log panel selects by id); the badge
        // reads `details`, which is best-effort and may hold `{ id }` only.
        const details = result.devices.length === 0 ? [] : await collectDevicesInfo(result.devices)
        // `preferred` is the device the tool would pick when `device` is
        // omitted; the badge marks it so the default is visible, not guessed.
        const preferred = getLastDevice()
        return Response.json({
          ok: result.ok,
          devices: result.devices,
          details,
          preferred: preferred && result.devices.includes(preferred) ? preferred : (result.devices[0] ?? null),
          ...(result.error === undefined ? {} : { error: result.error }),
        })
      },
    },
    {
      // Clicking a device in the badge makes it the default for later calls.
      // Only an already-connected id is accepted: remembering a stale one would
      // send every following command to a device that is not there.
      path: '/api/harmony/logs/preferred',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let payload
        try {
          payload = await request.json()
        } catch {
          return Response.json({ ok: false, error: '请求体不是 JSON' }, { status: 400 })
        }
        const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
        if (id === '') return Response.json({ ok: false, error: '缺少 id' }, { status: 400 })
        const connected = await listDevices()
        if (!connected.devices.includes(id)) {
          return Response.json({ ok: false, error: `设备 ${id} 不在线` }, { status: 409 })
        }
        setLastDevice(id)
        return Response.json({ ok: true, preferred: getLastDevice() })
      },
    },
    {
      path: '/api/harmony/logs/processes',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const device = (new URL(request.url).searchParams.get('device') ?? '').trim()
        const result = await listProcesses(device)
        return Response.json({
          ok: result.ok,
          processes: result.processes,
          ...(result.error === undefined ? {} : { error: result.error }),
        })
      },
    },
    {
      path: '/api/harmony/logs',
      methods: ['GET'],
      requestBody: 'buffered',
      // `ConnectionFetchRoute.fetch` must return a Promise. `openLogStream`
      // builds the Response synchronously, so an unwrapped arrow returned a
      // bare Response and the dispatcher's `.then` threw — the panel's stream
      // request failed with an HTTP 500 before any frame arrived. Keep the
      // async wrapper, and turn a construction failure into a readable frame.
      fetch: async (request) => {
        try {
          return openLogStream(request, state)
        } catch (error) {
          return Response.json(
            { ok: false, error: error?.message ?? String(error) },
            { status: 500 },
          )
        }
      },
    },
  ]
}

/**
 * One streaming capture response.
 * @param {Request} request incoming Fetch request.
 * @param {{ active: number, max: number }} state concurrency counter.
 * @returns {Response}
 */
function openLogStream(request, state) {
  const url = new URL(request.url)
  const device = (url.searchParams.get('device') ?? '').trim()
  const prefill = intParam(url.searchParams.get('prefill'), DEFAULT_PREFILL, 0, 500)

  if (state.active >= state.max) {
    return Response.json(
      { ok: false, error: `同时最多 ${state.max} 路日志流，请先关闭其他标签页。` },
      { status: 429 },
    )
  }

  const abort = new AbortController()
  const onAbort = () => abort.abort()
  if (request.signal.aborted) abort.abort()
  else request.signal.addEventListener('abort', onAbort, { once: true })

  const encoder = new TextEncoder()
  let closed = false

  const enqueue = (controller, frame) => {
    if (closed) return
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
    } catch {
      closed = true
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      state.active += 1
      streamHilog({
        device,
        prefill,
        signal: abort.signal,
        emit: (frame) => enqueue(controller, frame),
      })
        .catch((error) => {
          enqueue(controller, { type: 'error', message: error?.message ?? String(error) })
        })
        .finally(() => {
          state.active -= 1
          request.signal.removeEventListener('abort', onAbort)
          if (closed) return
          closed = true
          try {
            controller.close()
          } catch {}
        })
    },
    cancel() {
      closed = true
      abort.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
