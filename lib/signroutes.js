/**
 * Settings routes for the signing credentials.
 *
 * The password arrives from a form in the settings page and must never travel
 * back: the GET route reports only whether a password exists, and the POST
 * route answers with the same shape. That is what makes it safe to keep the
 * password in the local config file — nothing on the wire, nothing in a tool
 * result, nothing in a log line.
 */

import { readSettings, settingsPath, writeSettings } from './settings.js'

const TEXT_FIELDS = ['keystorePath', 'keyAlias', 'certPath', 'profilePath']
const PASSWORD_FIELDS = ['keystorePassword', 'keyPassword']

/**
 * The public view of the stored settings: paths and booleans only.
 * @returns {{configured: object, source: string, path: string}}
 */
export function signView() {
  const sign = readSettings().sign ?? {}
  const configured = {}
  for (const field of TEXT_FIELDS) configured[field] = typeof sign[field] === 'string' ? sign[field] : ''
  configured.hasKeystorePassword = typeof sign.keystorePassword === 'string' && sign.keystorePassword !== ''
  configured.hasKeyPassword = typeof sign.keyPassword === 'string' && sign.keyPassword !== ''
  const env = Boolean(process.env.DSH_HARMONY_KEYSTORE_PASSWORD || process.env.DSH_HARMONY_KEY_PASSWORD)
  return {
    configured,
    source: env ? 'env' : configured.hasKeystorePassword ? 'file' : 'none',
    path: settingsPath(),
  }
}

/**
 * Merge one payload from the settings form.
 *
 * An empty password field means "leave what is stored alone": the form cannot
 * pre-fill the value (it is not readable), so an empty box is the normal state
 * even when a password is saved. Clearing is the explicit `clearPassword` flag.
 *
 * @param {object} payload request body.
 * @returns {{ok: true, configured: object} | {ok: false, error: string}}
 */
export function saveSignSettings(payload) {
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '请求体不是对象' }
  const stored = readSettings().sign ?? {}
  const next = { ...stored }
  for (const field of TEXT_FIELDS) {
    if (typeof payload[field] === 'string') next[field] = payload[field].trim()
  }
  for (const field of PASSWORD_FIELDS) {
    if (typeof payload[field] === 'string' && payload[field] !== '') next[field] = payload[field]
  }
  if (payload.clearPassword === true) {
    delete next.keystorePassword
    delete next.keyPassword
  }
  if (next.keyAlias === '') return { ok: false, error: 'keyAlias 不能为空' }
  writeSettings({ sign: next })
  return { ok: true, configured: signView().configured }
}

/**
 * Build the two Fetch routes.
 * @returns {object[]}
 */
export function createSignRoutes() {
  return [
    {
      path: '/api/harmony/sign',
      methods: ['GET'],
      fetch: async () => Response.json({ ok: true, ...signView() }),
    },
    {
      path: '/api/harmony/sign',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json({ ok: false, error: '请求体不是 JSON' }, { status: 400 })
        }
        const saved = saveSignSettings(body)
        if (!saved.ok) return Response.json(saved, { status: 400 })
        return Response.json({ ok: true, ...signView() })
      },
    },
  ]
}
