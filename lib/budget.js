/**
 * Time boxes for a diagnostic pass.
 *
 * A health check is only useful if it comes back. One wedged `hdc` can hold the
 * whole `doctor` call for minutes, so every probe gets its own limit and the
 * pass as a whole shares a deadline. "Took too long" and "never got a chance to
 * run" are reported apart: they need different fixes.
 */

export const MIN_PROBE_MS = 60

/**
 * @param {number} totalMs shared deadline for the whole pass.
 * @param {{ perProbeMs?: number, now?: () => number }} [options]
 */
export function createBudget(totalMs, options = {}) {
  const now = options.now ?? Date.now
  const perProbeMs = options.perProbeMs ?? 2000
  const deadline = now() + totalMs
  const probes = []

  function remaining() {
    return Math.max(0, deadline - now())
  }

  return {
    remaining,
    get elapsedMs() {
      return probes.reduce((sum, probe) => sum + probe.ms, 0)
    },
    /** Record every probe so the caller can report what it actually spent. */
    probes,

    /**
     * Run one probe under the smaller of its own and the pass's remaining time.
     *
     * @param {string} name probe label, echoed in `probes`.
     * @param {(signal: AbortSignal) => Promise<any>} fn
     * @returns {Promise<{ status: 'ok'|'timeout'|'skipped'|'error', value?: any, detail?: string, ms: number }>}
     */
    async probe(name, fn) {
      const left = remaining()
      if (left < MIN_PROBE_MS) {
        const result = { name, status: 'skipped', detail: '总预算用完，没来得及开始', ms: 0 }
        probes.push(result)
        return result
      }
      const limit = Math.min(perProbeMs, left)
      const started = now()
      const controller = new AbortController()
      let timer
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => fn(controller.signal)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(Object.assign(new Error(`超过 ${limit}ms 没有返回`), { timedOut: true }))
            }, limit)
          }),
        ])
        const result = { name, status: 'ok', value, ms: now() - started }
        probes.push(result)
        return result
      } catch (error) {
        const timedOut = error instanceof Error && error.timedOut === true
        const result = {
          name,
          status: timedOut ? 'timeout' : 'error',
          detail: timedOut ? `超过 ${limit}ms 没有返回` : error instanceof Error ? error.message : String(error),
          ms: now() - started,
        }
        probes.push(result)
        return result
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
