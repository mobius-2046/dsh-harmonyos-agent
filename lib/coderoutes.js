/**
 * Read-only browsing routes for the code page.
 *
 * One route with an `op` switch keeps the surface small: the page needs a tree,
 * one file, and a symbol search — nothing that writes.
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { findSymbols, listTree, readSource } from './codewatch.js'

const PREFIX = '/api/harmony/code'

/** Answer with JSON and no caching. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Accept only directories that look like a HarmonyOS project.
 * The page is read-only, but pointing it at `C:\` would still walk the disk.
 * @param {string} value candidate root.
 * @returns {{ ok: boolean, root?: string, error?: string }} verdict.
 */
export function projectRoot(value) {
  const root = resolve(String(value ?? ''))
  if (!existsSync(root)) return { ok: false, error: `没有这个目录：${root}` }
  if (!statSync(root).isDirectory()) return { ok: false, error: '不是目录' }
  if (!existsSync(`${root}/AppScope`) && !existsSync(`${root}/build-profile.json5`)) {
    return { ok: false, error: '这个目录不像 HarmonyOS 工程（缺 AppScope/ 与 build-profile.json5）' }
  }
  return { ok: true, root }
}

/**
 * Serve one code-page request.
 * @param {URL} url request url with query parameters.
 * @returns {Response} JSON response.
 */
export function handleCodeRequest(url) {
  const op = (url.searchParams.get('op') ?? 'tree').toLowerCase()
  const root = projectRoot(url.searchParams.get('root'))
  if (!root.ok) return json({ ok: false, error: root.error }, 400)

  if (op === 'tree') {
    const tree = listTree(root.root)
    return json({ ok: true, root: root.root, entries: tree.entries, truncated: tree.truncated })
  }

  if (op === 'file') {
    const file = readSource(root.root, url.searchParams.get('path') ?? '')
    return json(file.ok ? { ok: true, ...file } : { ok: false, error: file.error }, file.ok ? 200 : 404)
  }

  if (op === 'find') {
    const found = findSymbols(root.root, url.searchParams.get('q') ?? '')
    return json({ ok: true, ...found })
  }

  return json({ ok: false, error: `不支持的 op：${op}（可用 tree / file / find）` }, 400)
}

/**
 * Route descriptors for the host fetch registry.
 * @returns {Array<object>} one route.
 */
export function createCodeRoutes() {
  return [
    {
      path: PREFIX,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        try {
          return handleCodeRequest(new URL(request.url))
        } catch (error) {
          return json({ ok: false, error: `代码页接口出错：${error instanceof Error ? error.message : String(error)}` }, 500)
        }
      },
    },
  ]
}
