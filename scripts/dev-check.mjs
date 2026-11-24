// One command for the fast loop: syntax-check every entry that ships, then run
// the self-test. Prints one line per stage so a failure is obvious without a
// second call.
//
//   node scripts/dev-check.mjs            # syntax + selftest
//   node scripts/dev-check.mjs --quiet    # only the final verdict
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const quiet = process.argv.includes('--quiet')
const started = Date.now()

function listSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (['node_modules', 'oh_modules', 'build', '.git', '.hvigor'].includes(name)) continue
      listSources(full, out)
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      out.push(full)
    }
  }
  return out
}

const files = [
  join(root, 'index.js'),
  ...listSources(join(root, 'lib')),
  ...listSources(join(root, 'scripts')),
  join(root, 'client.js'),
]

let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed += 1
    const text = String(error.stderr || error.message).split('\n').slice(0, 4).join(' ')
    console.log(`✗ ${relative(root, file)}: ${text}`)
  }
}
const syntaxMs = Date.now() - started
if (!quiet) console.log(`语法检查：${files.length} 个文件，${failed === 0 ? '通过' : `${failed} 个失败`}（${(syntaxMs / 1000).toFixed(1)}s）`)

const testStart = Date.now()
let testOut = ''
let testsOk = false
try {
  testOut = execFileSync(process.execPath, [join(root, 'scripts', 'selftest.mjs')], { stdio: 'pipe' }).toString()
  testsOk = /0 个失败|全部通过|\b\d+\/\d+ passed/.test(testOut) || testOut.toLowerCase().includes('ok')
} catch (error) {
  testOut = `${error.stdout || ''}${error.stderr || ''}`
}
const testMs = Date.now() - testStart
const summary = (testOut.trim().split('\n').filter(Boolean).pop() || '(no output)').slice(0, 160)
if (!quiet) console.log(`自测：${summary}（${(testMs / 1000).toFixed(1)}s）`)

const ok = failed === 0 && testsOk
console.log(ok ? `✓ dev-check 通过（${((Date.now() - started) / 1000).toFixed(1)}s）` : '✗ dev-check 失败：先看上面第一行错误')
process.exit(ok ? 0 : 1)
