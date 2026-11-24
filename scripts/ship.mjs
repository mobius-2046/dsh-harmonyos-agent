// Ship one version in a single call: push the changed files through the REST
// API (github.com:443 is unreliable here while api.github.com works), create
// the annotated tag, and create or update the GitHub release from CHANGELOG.md.
//
//   node scripts/ship.mjs                 # auto: changed files, tag from package.json
//   node scripts/ship.mjs --tag v0.48.0   # override the tag
//   node scripts/ship.mjs --no-release    # push + tag only
//   node scripts/ship.mjs a.js b.md       # explicit file list
//
// Needs GH_TOKEN, or a working git-credential-manager entry for github.com.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = 'mobius-2046/dsh-harmonyos-agent'
const args = process.argv.slice(2)
const noRelease = args.includes('--no-release')
const tagFlag = args.indexOf('--tag')
const explicit = args.filter((a, i) => !a.startsWith('--') && i !== tagFlag + 1)

const token = process.env.GH_TOKEN || tokenFromGit()
if (!token) throw new Error('没有 GH_TOKEN，也读不到 git 凭据')

function tokenFromGit() {
  const candidates = [
    'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe',
    'git-credential-manager',
  ]
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['get'], { input: 'protocol=https\nhost=github.com\n\n' }).toString()
      const match = out.match(/^password=(.+)$/m)
      if (match) return match[1].trim()
    } catch {}
  }
  return ''
}

const api = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'dsh-harmony-ship',
      ...(init.headers || {}),
    },
  }).then(async (response) => {
    const text = await response.text()
    if (!response.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  })

function changedFiles() {
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString()
  const files = []
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    const path = line.slice(3).trim().replace(/^"|"$/g, '')
    if (line.startsWith(' D') || line.startsWith('D ')) continue
    if (path.includes('node_modules') || path.endsWith('.log')) continue
    files.push(path)
  }
  return files
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = tagFlag >= 0 ? args[tagFlag + 1] : `v${version}`
const files = explicit.length ? explicit : changedFiles()

const started = Date.now()
const ref = await api(`/repos/${repo}/git/ref/heads/main`)
const base = ref.object.sha

let sha = base
if (files.length) {
  const baseCommit = await api(`/repos/${repo}/git/commits/${base}`)
  const tree = []
  for (const file of files) {
    const content = readFileSync(join(root, file))
    const blob = await api(`/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    })
    tree.push({ path: file.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha })
  }
  const newTree = await api(`/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  })
  const message = process.env.COMMIT_MESSAGE || `release: ${tag}`
  const commit = await api(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [base] }),
  })
  await api(`/repos/${repo}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })
  sha = commit.sha
  console.log(`push  ${sha.slice(0, 8)}  ${files.length} 个文件`)
} else {
  console.log(`push  没有改动，停在 ${sha.slice(0, 8)}`)
}

// Keep the local branch pointer in step with the API commit (no network fetch,
// so a flaky github.com cannot silently rewind the working tree).
if (sha !== base) {
  try {
    execFileSync('git', ['update-ref', 'refs/heads/main', sha], { cwd: root, stdio: 'ignore' })
  } catch {}
}

let tagSha = null
try {
  const object = await api(`/repos/${repo}/git/tags`, {
    method: 'POST',
    body: JSON.stringify({ tag, message: tag, object: sha, type: 'commit' }),
  })
  await api(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: object.sha }),
  })
  tagSha = object.sha
  console.log(`tag   ${tag} -> ${sha.slice(0, 8)}`)
} catch (error) {
  // A tag from an earlier attempt: move it instead of failing.
  const object = await api(`/repos/${repo}/git/tags`, {
    method: 'POST',
    body: JSON.stringify({ tag, message: tag, object: sha, type: 'commit' }),
  })
  await api(`/repos/${repo}/git/refs/tags/${tag}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: object.sha, force: true }),
  })
  tagSha = object.sha
  console.log(`tag   ${tag} -> ${sha.slice(0, 8)}（已移动）`)
}

if (!noRelease) {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const start = changelog.indexOf(`## ${version}`)
  const end = start >= 0 ? changelog.indexOf('\n## ', start + 3) : -1
  const body =
    (start >= 0 ? changelog.slice(start, end > 0 ? end : undefined).trim() : `## ${version}`) +
    '\n\n安装：在 DSH 里装这个目录（plugin_manager 或 `dsh plugin add`），重启 Harness 后在新会话里选 HarmonyOS 预设。\n'
  let release
  try {
    release = await api(`/repos/${repo}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: tag, body }),
    })
    console.log(`rel   POST 201  ${release.html_url}`)
  } catch (error) {
    release = await api(`/repos/${repo}/releases/tags/${tag}`)
    await api(`/repos/${repo}/releases/${release.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: tag, body }),
    })
    console.log(`rel   PATCH 200 ${release.html_url}`)
  }
}

console.log(`✓ ship 完成 ${tag}（${((Date.now() - started) / 1000).toFixed(1)}s，tag ${String(tagSha).slice(0, 8)}）`)
