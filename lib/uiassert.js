import { createHash } from 'node:crypto'

/**
 * A short digest of the visible tree.
 *
 * The point is not cryptographic strength but "same screen or not": after a
 * navigation the tree changes wholesale, while a spinner blinking inside it
 * usually does not touch the set of nodes we keep. Sorting before hashing makes
 * the digest independent of traversal order, so a re-dump of the same screen
 * matches even when the framework returns siblings in a different order.
 */
export function uiFingerprint(nodes) {
  const lines = nodes
    .filter((node) => node && node.bounds)
    .map((node) => [
      node.type ?? '',
      String(node.text ?? '').trim(),
      node.clickable ? 1 : 0,
      node.bounds.x,
      node.bounds.y,
      node.bounds.width ?? node.bounds.x2 - node.bounds.x1 ?? 0,
      node.bounds.height ?? node.bounds.y2 - node.bounds.y1 ?? 0,
    ].join('|'))
    .sort()
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Checks a screen against what the caller expects, without touching the device.
 *
 * `absent` and `count` are separate on purpose: "the dialog is gone" and "there
 * are exactly two results" fail for different reasons, and the message has to
 * say which one it was.
 */
export function assertUi(nodes, { text = '', absent = false, count, fingerprint = '' } = {}) {
  const checks = []
  const needle = String(text ?? '').trim().toLowerCase()

  if (needle) {
    const matches = nodes.filter((node) => node.text && String(node.text).toLowerCase().includes(needle))
    const wanted = Number.isFinite(Number(count)) ? Number(count) : absent ? 0 : 1
    const pass = Number.isFinite(Number(count))
      ? matches.length === wanted
      : absent
        ? matches.length === 0
        : matches.length >= 1
    const label = absent
      ? `「${text}」不出现`
      : Number.isFinite(Number(count))
        ? `「${text}」恰好 ${wanted} 个`
        : `「${text}」出现`
    checks.push({ name: label, pass, actual: matches.length, expected: wanted })
  }

  if (fingerprint) {
    const actual = uiFingerprint(nodes)
    checks.push({ name: '界面指纹一致', pass: actual === fingerprint, actual, expected: String(fingerprint) })
  }

  if (checks.length === 0) {
    return { ok: false, error: 'assert 至少要 text 或 fingerprint：一个说「这个界面该有什么」，一个说「还是不是这个界面」。', checks }
  }
  return { ok: checks.every((check) => check.pass), checks }
}
