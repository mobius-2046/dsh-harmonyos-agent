/**
 * Reading the device's filesystem through `hdc shell`, without pretending it is
 * a full shell.
 *
 * The three questions worth answering without a UI are: what is in this
 * directory, what does this small file say, and how big is that directory. All
 * three are read-only and all three are cheap, which is why they exist; anything
 * that needs a real terminal is out of scope on purpose.
 *
 * @module dsh-harmony/lib/remotefs
 */

/**
 * Parse the `ls -la` output toybox prints on device.
 *
 * The format is stable (`perms links owner group size date time name`), but
 * names may contain spaces, so the separator has to be the date column rather
 * than a split on whitespace.
 *
 * @param {string} text raw output of `ls -la`.
 * @returns {{name: string, dir: boolean, link: boolean, size: number, mtime: string, perms: string}[]}
 *   entries without the `.` / `..` rows, directories first then files, each group by name.
 */
export function parseLsListing(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([bcdlps-][rwxStTs-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/.exec(line)
    if (match === null) continue
    const name = match[5].trim()
    if (name === '.' || name === '..' || name === '') continue
    rows.push({
      name,
      dir: match[1].startsWith('d'),
      link: match[1].startsWith('l'),
      size: Number(match[2]),
      mtime: `${match[3]} ${match[4]}`,
      perms: match[1],
    })
  }
  return rows.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * `du -sk` prints `1234\t/path`; we only need the number.
 * @param {string} text raw output of `du -sk`.
 * @returns {number | undefined} kilobytes, or undefined when the tool complained.
 */
export function parseDuKb(text) {
  const match = /^(\d+)\s/m.exec(String(text ?? ''))
  return match === null ? undefined : Number(match[1])
}

/**
 * Render a byte count the way a person reads it.
 * @param {number} bytes value.
 * @returns {string} `812 B`, `1.4 KB`, `2.3 MB`.
 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * One line per entry: `d` or `-`, size, mtime, name.
 * @param {ReturnType<typeof parseLsListing>[number]} entry one row.
 * @returns {string} a fixed-width line that stays readable in a terminal or a chat.
 */
export function formatEntry(entry) {
  const kind = entry.dir ? 'd' : entry.link ? 'l' : '-'
  const size = entry.dir ? '     —' : formatBytes(entry.size).padStart(7)
  return `${kind} ${size}  ${entry.mtime}  ${entry.name}`
}
