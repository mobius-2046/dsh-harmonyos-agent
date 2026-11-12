/**
 * Poll `predicate` until it reports ok or the deadline passes.
 *
 * The predicate is awaited before every sleep, so a wait that succeeds on the
 * first try costs one probe and no delay. `sleep` and `now` are injectable so
 * the loop can be tested without real time passing.
 */
export async function waitUntil(predicate, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 10_000
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, options.intervalMs) : 500
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const start = now()
  let attempts = 0
  for (;;) {
    attempts += 1
    const last = await predicate({ attempt: attempts, elapsedMs: now() - start })
    if (last !== null && last !== undefined && last.ok) {
      return { ok: true, attempts, elapsedMs: now() - start, value: last.value }
    }
    const elapsed = now() - start
    if (elapsed >= timeoutMs) {
      return { ok: false, attempts, elapsedMs: elapsed, value: last ? last.value : undefined }
    }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - elapsed)))
  }
}
