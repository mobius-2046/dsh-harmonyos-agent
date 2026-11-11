import { spawn } from 'node:child_process'

const KEEP_HEAD = 40
const KEEP_TAIL = 260
const MAX_BUFFERED_LINES = 20000

const utf8 = new TextDecoder('utf-8', { fatal: true })
const gbk = new TextDecoder('gbk')

/**
 * Decode one line of child output.
 *
 * Windows tools do not agree on an encoding: `hdc` and Node-based CLIs emit
 * UTF-8, while `cmd.exe`, Java-based hvigor, and most DevEco wrappers emit the
 * OEM code page (GBK on a Chinese Windows). Decoding everything as UTF-8 turned
 * hvigor's Chinese errors into `??????`, so each complete line is decoded
 * strictly as UTF-8 and falls back to GBK only when that fails.
 *
 * @param {Buffer} bytes one line without its terminator.
 * @returns {string}
 */
function decodeLine(bytes) {
  try {
    return utf8.decode(bytes)
  } catch {
    return gbk.decode(bytes)
  }
}

/**
 * Quote one argument for a `cmd.exe /c` command line.
 * @param {string} value raw argument.
 * @returns {string} the argument, quoted only when it needs it.
 */
function quoteForCmd(value) {
  if (value === '') return '""'
  if (!/[\s"&|<>^]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Split a byte chunk into complete lines, keeping a trailing partial line
 * buffered until its terminator arrives. Bytes are kept undecoded so a
 * multi-byte character split across two chunks is decoded exactly once.
 *
 * @param {Buffer} chunk new data.
 * @param {Buffer} carry partial line from the previous chunk.
 * @returns {{ lines: Buffer[], carry: Buffer }}
 */
function splitLines(chunk, carry) {
  const text = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
  const lines = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === 0x0a) {
      lines.push(text.subarray(start, index))
      start = index + 1
    }
  }
  return { lines, carry: text.subarray(start) }
}

/**
 * Strip the `\r` of a CRLF pair, drop ANSI color codes, and decode one line.
 *
 * hvigor emits SGR codes even when stdout is a pipe. They would otherwise reach
 * the error regex as a prefix, so a colored `> hvigor ERROR:` line would never
 * match and the build would fail with an empty error list.
 *
 * @param {Buffer} line raw line bytes.
 * @returns {string}
 */
export function decodeTextLine(line) {
  const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length
  return decodeLine(line.subarray(0, end)).replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * Streaming counterpart of the decode step in `runCommand`: turn raw chunks
 * into decoded lines, keeping a trailing partial line buffered until its
 * terminator arrives.
 *
 * `runCommand` collects everything before parsing, which is right for a build
 * that has to finish. A log tail cannot wait: `hilog` writes a line as it
 * happens and never exits on its own, so the panel needs each line as it
 * arrives. Both paths share the byte-level split and the UTF-8/GBK fallback.
 *
 * @param {(line: string) => void} onLine called once per complete line.
 * @returns {{ push: (chunk: Buffer) => void, flush: () => void }}
 */
export function createLineSplitter(onLine) {
  let carry = Buffer.alloc(0)
  return {
    push(chunk) {
      const joined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      let start = 0
      for (let index = 0; index < joined.length; index += 1) {
        if (joined[index] === 0x0a) {
          onLine(decodeTextLine(joined.subarray(start, index)))
          start = index + 1
        }
      }
      carry = joined.subarray(start)
    },
    flush() {
      if (carry.length === 0) return
      const rest = carry
      carry = Buffer.alloc(0)
      onLine(decodeTextLine(rest))
    },
  }
}

/**
 * Run one external command and capture its merged output as lines.
 *
 * Windows batch wrappers (`hvigorw.bat`, `ohpm.bat`) are invoked through
 * `cmd.exe /d /s /c`; everything else is spawned directly. The batch path
 * passes the command line verbatim with one extra wrapping quote pair, which is
 * what `/s` strips: without it, a `.bat` under `C:\Program Files\...` reaches
 * cmd as `\"C:\Program Files\...\"` and fails with "not recognized as an
 * internal or external command".
 *
 * @param {string} command executable path or bare name.
 * @param {string[]} args arguments.
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string, string>, signal?: AbortSignal }} options
 * @returns {Promise<{ commandLine: string, exitCode: number|null, signal: string|null, timedOut: boolean, spawnError?: string, durationMs: number, lines: string[], totalLines: number, truncated: boolean }>}
 */
export function runCommand(command, args, options = {}) {
  const { cwd, timeoutMs = 10 * 60 * 1000, env = {}, signal } = options
  const commandLine = [command, ...args].join(' ')
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const head = []
    const tail = []
    let total = 0
    let carry = Buffer.alloc(0)
    let timedOut = false
    let spawnError
    let settled = false

    const isWindows = process.platform === 'win32'
    const viaShell = isWindows && /\.(?:bat|cmd)$/i.test(command)
    // stdin is closed on purpose: an agent tool must never wait on a prompt.
    // hvigorw asks "install pnpm? [y/N]" and hap-sign-tool can block on input;
    // with a pipe nobody writes to, both hang until the timeout instead of
    // failing with a readable message.
    const stdio = ['ignore', 'pipe', 'pipe']
    const child = viaShell
      ? spawn(process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `"${[command, ...args].map(quoteForCmd).join(' ')}"`],
        {
          cwd,
          env: { ...process.env, ...env },
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio,
        })
      : spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio })

    const push = (line) => {
      total += 1
      if (head.length < KEEP_HEAD) head.push(line)
      else {
        tail.push(line)
        if (tail.length > KEEP_TAIL) tail.shift()
      }
    }

    const onData = (chunk) => {
      const split = splitLines(chunk, carry)
      carry = split.carry
      for (const line of split.lines) push(decodeTextLine(line))
      if (total > MAX_BUFFERED_LINES) {
        child.kill()
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    if (timer.unref) timer.unref()

    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (exitCode, exitSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (carry.length > 0) push(decodeTextLine(carry))
      const dropped = total > head.length + tail.length
      resolve({
        commandLine,
        exitCode,
        signal: exitSignal ?? null,
        timedOut,
        ...(spawnError === undefined ? {} : { spawnError }),
        durationMs: Date.now() - startedAt,
        lines: [...head, ...(dropped ? [`... ${total - head.length - tail.length} lines omitted ...`] : []), ...tail],
        totalLines: total,
        truncated: dropped,
      })
    }

    child.on('error', (error) => {
      spawnError = error?.message ?? String(error)
      finish(null, null)
    })
    child.on('close', (code, exitSignal) => finish(code, exitSignal))
  })
}
