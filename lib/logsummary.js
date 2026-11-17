/**
 * Compress a hilog tail into the few lines a person actually needs.
 *
 * The panel exists for browsing; this exists for the conversation, where the
 * question is almost always "did anything break, and what is it". Reading 200
 * raw lines costs the model a lot of tokens and answers neither part quickly,
 * so the shape here is: one header line, one counts line, then the errors and
 * the repeated noise that dominates the window.
 *
 * @module dsh-harmony/lib/logsummary
 */

/** `MM-DD HH:MM:SS.mmm pid tid L tag: message` — the shape hilog writes. */
const LINE = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([EWIDFA])\s+(\S+?):\s?(.*)$/

/**
 * Split one hilog line into its fields.
 * @param {string} line raw line.
 * @returns {{at: string, pid: string, tid: string, level: string, tag: string, message: string} | null}
 *   `null` when the line is not a hilog record (continuation lines, banners).
 */
export function parseLogLine(line) {
  const match = LINE.exec(String(line ?? ''))
  if (match === null) return null
  return { at: match[1], pid: match[2], tid: match[3], level: match[4], tag: match[5], message: match[6] }
}

/**
 * Count what is in a window instead of repeating it.
 *
 * Identical messages are keyed by `tag: message` so "same text from a different
 * subsystem" stays two entries. Continuation lines (stack traces) are attached
 * to nothing on purpose: they belong to the record above them, and folding them
 * into a count would invent records that do not exist.
 *
 * @param {string[]} lines raw hilog lines, oldest first.
 * @param {{maxExamples?: number}} [options] how many errors and duplicates to keep.
 * @returns {{total: number, parsed: number, firstAt?: string, lastAt?: string,
 *   levels: Record<string, number>, pids: number, errors: {text: string, count: number, at: string}[],
 *   duplicates: {text: string, count: number}[], ignored: number}}
 */
export function summarizeLogs(lines, { maxExamples = 4 } = {}) {
  const list = Array.isArray(lines) ? lines : []
  const levels = { E: 0, W: 0, I: 0, D: 0, F: 0, A: 0 }
  const pids = new Set()
  const counts = new Map()
  const errors = []
  let parsed = 0
  let firstAt
  let lastAt

  for (const line of list) {
    const record = parseLogLine(line)
    if (record === null) continue
    parsed += 1
    if (firstAt === undefined) firstAt = record.at
    lastAt = record.at
    pids.add(record.pid)
    levels[record.level] = (levels[record.level] ?? 0) + 1

    const key = `${record.tag}: ${record.message}`
    const seen = counts.get(key)
    if (seen === undefined) counts.set(key, { text: key, count: 1, at: record.at, level: record.level })
    else seen.count += 1

    if (record.level === 'E' || record.level === 'F') {
      const existing = errors.find((item) => item.text === key)
      if (existing === undefined) errors.push({ text: key, count: 1, at: record.at })
      else existing.count += 1
    }
  }

  const duplicates = [...counts.values()]
    .filter((item) => item.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxExamples)
    .map(({ text, count }) => ({ text, count }))

  const topErrors = errors
    .sort((a, b) => b.count - a.count)
    .slice(0, maxExamples)
    .map(({ text, count, at }) => ({ text: truncate(text, 120), count, at }))

  return {
    total: list.length,
    parsed,
    ...(firstAt === undefined ? {} : { firstAt }),
    ...(lastAt === undefined ? {} : { lastAt }),
    levels,
    pids: pids.size,
    errors: topErrors,
    duplicates,
    ignored: list.length - parsed,
  }
}

/**
 * Render a summary as a short block: the caller decides how to wrap it.
 * @param {ReturnType<typeof summarizeLogs>} summary output of {@link summarizeLogs}.
 * @returns {string} at most about twelve lines.
 */
export function formatLogSummary(summary) {
  const { total, parsed, firstAt, lastAt, levels, pids, errors, duplicates, ignored } = summary
  if (parsed === 0) {
    return total === 0
      ? '窗口里一行日志都没有。'
      : `窗口里 ${total} 行都不像 hilog 记录（没有时间戳与级别），没有可归类的部分。`
  }
  const span = firstAt === lastAt ? firstAt : `${firstAt} → ${lastAt}`
  const lines = [
    `日志摘要：${parsed} 条记录 · ${span}${pids > 1 ? ` · ${pids} 个进程` : ''}`,
    `级别 错误 ${levels.E + levels.F} · 警告 ${levels.W} · 信息 ${levels.I} · 调试 ${levels.D}`,
  ]
  if (errors.length > 0) {
    lines.push('错误（按次数）：')
    for (const item of errors) lines.push(`  ×${item.count}  ${item.at}  ${item.text}`)
  } else {
    lines.push('错误：没有。')
  }
  if (duplicates.length > 0) {
    lines.push('重复最多：')
    for (const item of duplicates) lines.push(`  ×${item.count}  ${truncate(item.text, 100)}`)
  }
  if (ignored > 0) lines.push(`（另有 ${ignored} 行续行，已归属到上一条记录，未单独计数）`)
  return lines.join('\n')
}

/** @param {string} text input. @param {number} max characters to keep. @returns {string} */
function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
