/**
 * Turning a hitrace text dump into numbers a person can act on.
 *
 * The raw text is thousands of lines of `comm-pid [cpu] flags ts: event: args`.
 * Nobody reads that in a chat; they read "in 2 s, 34 812 events, 62 % of them
 * sched_switch, top process xcommander". The file itself is kept for perfetto or
 * a proper flame graph, which is the part this plugin deliberately does not do.
 *
 * @module dsh-harmony/lib/trace
 */

const LINE = /^\s*(.+?)-(\d+)\s+\(\s*(\d+|-+)\s*\)\s+\[(\d+)\]\s+\S+\s+(\d+\.\d+):\s+([\w:]+):\s*(.*)$/

/**
 * Parse one ftrace text line.
 * @param {string} line one line of `hitrace` text output.
 * @returns {{comm: string, pid: number, cpu: number, ts: number, event: string, args: string} | null}
 *   null for headers, comments and continuation lines.
 */
export function parseTraceLine(line) {
  const match = LINE.exec(line ?? '')
  if (match === null) return null
  return {
    comm: match[1].trim(),
    pid: Number(match[2]),
    cpu: Number(match[4]),
    ts: Number(match[5]),
    event: match[6],
    args: match[7],
  }
}

/**
 * Summarise a captured trace.
 * @param {string[]} lines raw text lines.
 * @param {{topN?: number}} [options] how many entries to keep per ranking.
 * @returns {{total: number, parsed: number, firstTs: number|null, lastTs: number|null, durationMs: number|null,
 *   byEvent: [string, number][], byComm: [string, number][], cpus: number[], bufferFull: boolean}}
 */
export function summarizeTrace(lines, options = {}) {
  const topN = options.topN ?? 8
  const events = new Map()
  const comms = new Map()
  const cpus = new Set()
  let total = 0
  let parsed = 0
  let firstTs = null
  let lastTs = null
  let bufferFull = false

  for (const line of lines ?? []) {
    total += 1
    const buffer = /entries-in-buffer\/entries-written:\s*(\d+)\/(\d+)/.exec(line)
    if (buffer !== null && Number(buffer[1]) >= Number(buffer[2])) bufferFull = true
    const record = parseTraceLine(line)
    if (record === null) continue
    parsed += 1
    events.set(record.event, (events.get(record.event) ?? 0) + 1)
    comms.set(record.comm, (comms.get(record.comm) ?? 0) + 1)
    cpus.add(record.cpu)
    if (firstTs === null || record.ts < firstTs) firstTs = record.ts
    if (lastTs === null || record.ts > lastTs) lastTs = record.ts
  }

  const rank = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  return {
    total,
    parsed,
    firstTs,
    lastTs,
    durationMs: firstTs === null || lastTs === null ? null : Math.round((lastTs - firstTs) * 1000),
    byEvent: rank(events),
    byComm: rank(comms),
    cpus: [...cpus].sort((a, b) => a - b),
    bufferFull,
  }
}

/**
 * Render the summary as the few lines a chat can hold.
 * @param {ReturnType<typeof summarizeTrace>} summary result of {@link summarizeTrace}.
 * @returns {string} five to eight lines, no raw trace content.
 */
export function formatTraceSummary(summary) {
  if (summary.parsed === 0) {
    return `这段输出里没有可解析的 trace 记录（共 ${summary.total} 行），可能是 hitrace 报错或类别没产生事件。`
  }
  const percent = (count) => `${Math.round((count / summary.parsed) * 100)}%`
  const lines = [
    `trace 摘要：${summary.parsed} 条事件 · ${summary.durationMs ?? '?'} ms · ${summary.cpus.length} 个 CPU${summary.bufferFull ? ' · 缓冲区已写满（可能截断）' : ''}`,
  ]
  if (summary.byEvent.length > 0) {
    lines.push('事件类型（按次数）：')
    for (const [event, count] of summary.byEvent) lines.push(`  ${String(count).padStart(7)}  ${percent(count).padStart(4)}  ${event}`)
  }
  if (summary.byComm.length > 0) {
    lines.push('进程（按事件数）：')
    for (const [comm, count] of summary.byComm) lines.push(`  ${String(count).padStart(7)}  ${comm}`)
  }
  return lines.join('\n')
}
