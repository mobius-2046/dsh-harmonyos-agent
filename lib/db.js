/**
 * Looking at an app's SQLite databases without copying them to a GUI.
 *
 * The device is rooted or the caller can read the sandbox, so the file can be
 * pulled with `hdc file recv`; from there the read-only opening is done by
 * `node:sqlite`, which means no `sqlite3.exe` needs to exist on this machine.
 *
 * Everything here is deliberately read-only: the tool refuses anything that is
 * not SELECT / WITH / PRAGMA / EXPLAIN, so a typo cannot delete a row on a test
 * device full of somebody's data.
 *
 * @module dsh-harmony/lib/db
 */

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|truncate)\b/i
const READ_ONLY = /^\s*(select|with|pragma|explain)\b/i

/**
 * Decide whether a statement may run against a pulled database.
 * @param {string} sql the statement the model wrote.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkReadOnlySql(sql) {
  const text = String(sql ?? '').trim()
  if (text === '') return { ok: false, reason: 'sql 不能为空' }
  if (!READ_ONLY.test(text)) return { ok: false, reason: '只允许 SELECT / WITH / PRAGMA / EXPLAIN' }
  if (FORBIDDEN.test(text.replace(/'[^']*'/g, "''"))) {
    return { ok: false, reason: '语句里出现了写操作关键字（即使写在注释或子查询里也不放行）' }
  }
  return { ok: true }
}

/**
 * Render rows as a compact aligned table.
 *
 * Wide JSON blobs are the norm in app databases, so every cell is clipped;
 * the caller can ask for the raw value of one row with `raw: true` if needed.
 *
 * @param {Record<string, unknown>[]} rows query result.
 * @param {{maxRows?: number, maxCell?: number}} [options] clipping limits.
 * @returns {{lines: string[], shown: number, truncated: boolean}}
 */
export function formatRows(rows, options = {}) {
  const maxRows = options.maxRows ?? 50
  const maxCell = options.maxCell ?? 60
  const shown = rows.slice(0, maxRows)
  const truncated = rows.length > shown.length
  if (rows.length === 0) return { lines: ['（0 行）'], shown: 0, truncated: false }

  const columns = Object.keys(rows[0])
  const cell = (value) => {
    if (value === null) return 'NULL'
    if (value instanceof Uint8Array) return `<blob ${value.length} B>`
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return text.length > maxCell ? `${text.slice(0, maxCell)}…` : text
  }
  const widths = columns.map((column) =>
    Math.min(maxCell, Math.max(column.length, ...shown.map((row) => cell(row[column]).length))))

  const line = (values) => values.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd()
  const lines = [line(columns), line(widths.map((width) => '-'.repeat(width)))]
  for (const row of shown) lines.push(line(columns.map((column) => cell(row[column]))))
  return { lines, shown: shown.length, truncated }
}

/**
 * Run one read-only statement against a local copy of a database.
 *
 * Kept separate from the tool so it can be tested without a device: give it a
 * path to any .db file.
 *
 * @param {{file: string, sql: string, maxRows?: number}} input query request.
 * @returns {Promise<{ok: boolean, columns?: string[], rows?: Record<string, unknown>[], summary: string}>}
 */
export async function queryDatabase(input) {
  const verdict = checkReadOnlySql(input.sql)
  if (!verdict.ok) return { ok: false, summary: `拒绝执行：${verdict.reason}` }

  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(input.file, { readOnly: true })
  try {
    const statement = database.prepare(input.sql)
    const rows = statement.all()
    // node:sqlite returns plain objects; BigInt would break JSON downstream.
    const normalised = rows.map((row) => {
      const copy = {}
      for (const [key, value] of Object.entries(row)) copy[key] = typeof value === 'bigint' ? Number(value) : value
      return copy
    })
    const columns = normalised.length > 0 ? Object.keys(normalised[0]) : []
    const table = formatRows(normalised, { maxRows: input.maxRows ?? 50 })
    return {
      ok: true,
      columns,
      rows: normalised.slice(0, input.maxRows ?? 50),
      summary: table.lines.join('\n'),
      truncated: table.truncated,
    }
  } finally {
    database.close()
  }
}
