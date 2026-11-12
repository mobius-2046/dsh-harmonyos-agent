/**
 * Last device the agent actually used.
 *
 * Why: on a two-device desk, every deploy/run/logs call had to repeat the
 * device id, or silently land on whichever device `hdc list targets` printed
 * first. Remembering the last successful target makes the common case the
 * default one, while an explicit `device` still wins.
 *
 * Scope is deliberately the process: persisting it would add a second kind of
 * state to keep consistent with `hdc list targets`, and a stale id resurrected
 * across restarts is worse than falling back to the first connected device.
 */

/** @type {string|undefined} */
let lastDevice

/** @returns {string|undefined} */
export function getLastDevice() {
  return lastDevice
}

/**
 * @param {string} id device that just accepted an install or a launch.
 */
export function setLastDevice(id) {
  if (typeof id === 'string' && id.trim() !== '') lastDevice = id.trim()
}

/** Test helper: forget the remembered device. */
export function clearLastDevice() {
  lastDevice = undefined
}
