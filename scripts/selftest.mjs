// Regression checks for the parts of this bundle that break silently.
//
// Run with `npm test` (node scripts/selftest.mjs). It does not need a DSH
// session: it asserts on the tool schema shapes, on the output parsers with
// real-world samples, and on the shipped skill files. The one thing it cannot
// cover is an actual hvigor build — do that once against a real project after
// changing lib/tools.js.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, SKILLS } from '../index.js'
import { harmonyPreset } from '../lib/preset.js'
import { createBudget } from '../lib/budget.js'
import { createLogRoutes } from '../lib/hilog.js'
import { parseDeviceInfo } from '../lib/deviceinfo.js'
import { locateDocs, lookupApi, readDoc, searchDocs } from '../lib/docs.js'
import { explain } from '../lib/errorcodes.js'
import { waitUntil } from '../lib/wait.js'
import { assertUi, uiFingerprint } from '../lib/uiassert.js'
import { absoluteMaterials, inspectCertificate, parseSigningConfigs, pickSignInput, signingReport } from '../lib/signing.js'
import { acquireBuildLock, lockPath, releaseBuildLock } from '../lib/lock.js'
import { attributeFailure } from '../lib/attribute.js'
import { formatMatrixRow, parseDeviceMatrix } from '../lib/devicematrix.js'
import { formatLogSummary, parseLogLine, summarizeLogs } from '../lib/logsummary.js'
import { formatBytes, formatEntry, parseDuKb, parseLsListing } from '../lib/remotefs.js'
import { checkReadOnlySql, formatRows } from '../lib/db.js'
import { formatTraceSummary, parseTraceLine, summarizeTrace } from '../lib/trace.js'
import { formatAssertRow } from '../lib/uiassert.js'
import { findSymbols, insideRoot, listTree, readSource } from '../lib/codewatch.js'
import { resolveHvigorIsolation } from '../lib/locate.js'
import { handleCodeRequest } from '../lib/coderoutes.js'
import { HDC_THRESHOLDS, classifyHdcServer, formatHdcServer, mergeHdcSnapshots } from '../lib/hdcwatch.js'
import { apiLevels, checkApiCompat, extractApiImports, formatApiCompat, listSources, moduleSince, sinceOf } from '../lib/apicheck.js'
import { createHarmonyTools, filterByPid, filterLogLines, findUiNode, findUiNodes, flattenUi, inferTarget, missingSharedModules, nativePath, parseBounds, parseBundleDump, parseFaultLog, parseHvigorOutput, parseOutput, parseTargets, signingState } from '../lib/tools.js'

const results = []
// Optional: only used to parse cordis.patch.yml. Falls back to a regex check
// when the dependency tree does not happen to ship a YAML parser.
let YAML = null
try {
  YAML = (await import('yaml')).default
} catch {
  YAML = null
}
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Walk a JSON Schema and fail on the DSL/payload mistakes that broke agents. */
function scanSchema(node, path, problems) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => scanSchema(item, `${path}[${index}]`, problems))
    return
  }
  if (typeof node.required === 'boolean') problems.push(`${path}.required is a boolean, must be an array`)
  if (node.type === undefined && (node.properties || node.items)) problems.push(`${path} has no type`)
  for (const [key, value] of Object.entries(node)) scanSchema(value, `${path}.${key}`, problems)
}

const tools = createHarmonyTools({})
const tool = tools[0]

check('registry exposes exactly one tool named harmony', () => {
  assert.equal(tools.length, 1)
  assert.equal(tool.name, 'harmony')
})

check('parameters is an object-root JSON Schema with action required', () => {
  const schema = tool.parameters
  assert.equal(schema.type, 'object')
  assert.ok(Array.isArray(schema.required), 'required must be an array')
  assert.ok(schema.required.includes('action'))
  assert.equal(schema.properties.action.type, 'string')
})

check('action enum covers every documented action', () => {
  assert.deepEqual([...tool.parameters.properties.action.enum].sort(), ['app', 'build', 'compile', 'crash', 'db', 'deploy', 'deps', 'devices', 'docs', 'doctor', 'file', 'logs', 'run', 'screenshot', 'sign', 'trace', 'ui'])
})

check('op covers the four app lifecycle operations and the five ui operations', () => {
  const values = [...tool.parameters.properties.op.enum]
  for (const value of ['start', 'stop', 'clear', 'uninstall']) assert.ok(values.includes(value), value)
  for (const value of ['dump', 'find', 'wait', 'tap', 'input', 'key', 'swipe']) assert.ok(values.includes(value), value)
})

check('output schema is object-root and requires action/ok/summary', () => {
  const schema = tool.output.schema
  assert.equal(schema.type, 'object')
  assert.ok(Array.isArray(schema.required))
  for (const key of ['action', 'ok', 'summary']) assert.ok(schema.required.includes(key), `missing required ${key}`)
})

check('no schema node carries a boolean required or an untyped node', () => {
  const problems = []
  scanSchema(tool.parameters, 'parameters', problems)
  scanSchema(tool.output.schema, 'output', problems)
  assert.deepEqual(problems, [])
})

check('description steers to action=run after edits', () => {
  assert.match(tool.description, /action=run/)
  assert.match(tool.description, /hvigor/)
})

check('description advertises multi-device work', () => {
  assert.match(tool.description, /device="all"/)
})

check('parseTargets maps default, all and explicit lists', () => {
  assert.deepEqual(parseTargets(['a', 'b'], undefined), { ids: ['a'], unknown: [], remembered: false })
  assert.deepEqual(parseTargets(['a', 'b'], 'all'), { ids: ['a', 'b'], unknown: [], remembered: false })
  assert.deepEqual(parseTargets(['a', 'b'], 'b,a'), { ids: ['b', 'a'], unknown: [], remembered: false })
  assert.deepEqual(parseTargets(['a', 'b'], 'a,c'), { ids: ['a'], unknown: ['c'], remembered: false })
  assert.deepEqual(parseTargets([], 'all'), { ids: [], unknown: [], remembered: false })
})

check('parseDeviceMatrix turns a per-device plan into actions', () => {
  const plan = parseDeviceMatrix('a=run; b=install ;c=uninstall', ['a', 'b', 'c'])
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.unknown, [])
  assert.deepEqual(plan.entries, [
    { device: 'a', action: 'run' },
    { device: 'b', action: 'install' },
    { device: 'c', action: 'uninstall' },
  ])
  // A bare id is the common case: install, launch, keep it running.
  assert.deepEqual(parseDeviceMatrix('a', ['a']).entries, [{ device: 'a', action: 'run' }])
  // ids are not a list of characters; only "=" splits the action off.
  assert.deepEqual(parseDeviceMatrix('a='.trim(), ['a']).entries, [])
  assert.match(parseDeviceMatrix('a=explode', ['a']).errors[0], /不认识/)
  assert.match(parseDeviceMatrix('a;a', ['a']).errors[0], /两次/)
  assert.deepEqual(parseDeviceMatrix('a;b', ['a']).unknown, ['b'])
  // Empty input is an error, not an empty plan that silently does nothing.
  assert.match(parseDeviceMatrix('  ', ['a']).errors[0], /matrix 为空/)
})

check('formatMatrixRow shows what each device actually did', () => {
  const line = formatMatrixRow({ device: 'a', action: 'uninstall', installed: true, started: true, logLines: 3, crashed: false, uninstalled: true })
  assert.match(line, /a · uninstall · 装机 ✓ · 启动 ✓ · 日志 3 行 · 卸载 ✓/)
  // install-only rows have no launch or logs: an em dash, not a fake zero.
  const installOnly = formatMatrixRow({ device: 'b', action: 'install', installed: true, started: null, logLines: null, crashed: false, uninstalled: null })
  assert.match(installOnly, /启动 — · 日志 —/)
  assert.match(formatMatrixRow({ device: 'c', action: 'run', installed: false, started: null, logLines: null, crashed: false, uninstalled: null }), /装机 ✗/)
  assert.match(formatMatrixRow({ device: 'd', action: 'run', installed: true, started: true, logLines: 2, crashed: true, uninstalled: null }), /崩溃信号/)
})

check('formatAssertRow names the expectation that broke on each device', () => {
  const pass = formatAssertRow({ device: 'a', ok: true, nodeCount: 12, fingerprint: 'abc123', checks: [{ name: '「设置」出现', pass: true, actual: 1, expected: 1 }] })
  assert.match(pass, /- a · ✓ · 12 个节点 · 指纹 abc123$/)
  const fail = formatAssertRow({
    device: 'b',
    ok: false,
    nodeCount: 9,
    fingerprint: 'def456',
    checks: [
      { name: '「设置」出现', pass: false, actual: 0, expected: 1 },
      { name: '界面指纹一致', pass: false, actual: 'def456', expected: 'abc123' },
    ],
  })
  assert.match(fail, /- b · ✗ · 9 个节点 · 指纹 def456 · 「设置」出现（实际 0，期望 1）；界面指纹一致（实际 def456，期望 abc123）/)
  // A device whose tree could not be read has no checks; the error is the row.
  assert.match(formatAssertRow({ device: 'c', ok: false, nodeCount: 0, fingerprint: '', checks: [], error: 'UI 树抓取失败' }), /UI 树抓取失败/)
  // No digest must not render as the string "undefined".
  assert.match(formatAssertRow({ device: 'd', ok: false, nodeCount: 0, fingerprint: '', checks: [] }), /指纹 —/)
})

check('plan mode refuses build/compile/deps/run/deploy/app before touching hvigor', async () => {
  const guarded = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })[0]
  for (const action of ['build', 'compile', 'deps', 'run', 'deploy', 'app']) {
    const result = await guarded.execute({ action }, {})
    assert.equal(result.ok, false)
    assert.equal(result.data.stage, 'plan-guard')
    assert.match(result.summary, /plan/)
  }
})

check('filterByPid keeps one process and its continuation lines', () => {
  const lines = [
    '11-11 10:00:01.000 11520 11520 I A03d00/JSAPP: app start',
    '  at com.tze.Foo(Entry.ets:12)',
    '11-11 10:00:01.100  1203 11557 I C02d13/HDC_LOG: hdc noise',
    '  at system.Frame',
    '11-11 10:00:02.000 11520 11600 E A03d00/JSAPP: boom',
  ]
  const kept = filterByPid(lines, 11520)
  assert.equal(kept.length, 3)
  assert.match(kept[0], /app start/)
  // A stack frame inherits the decision of the record above it, so the frame
  // under a dropped device line stays dropped.
  assert.match(kept[1], /at com\.tze\.Foo/)
  assert.match(kept[2], /boom/)
  assert.deepEqual(filterByPid(lines, 9999), [])
})

check('log filtering supports substrings and /regex/flags', () => {
  const lines = ['11-11 10:00 I A00000/xcommander: start', '11-11 10:01 E A00000/xcommander: boom Error 404', '11-11 10:02 I C02d13/HDC_LOG: task']
  assert.equal(filterLogLines(lines, 'hdc_log').length, 1)
  assert.equal(filterLogLines(lines, '/error/').length, 1)
  assert.equal(filterLogLines(lines, '/ERROR|start/').length, 2)
  assert.equal(filterLogLines(lines, '').length, 3)
  assert.deepEqual(filterLogLines(lines, undefined), lines)
})

check('parseFaultLog reads process, reason and frames', () => {
  const report = [
    'Generated by HiviewDFX@OpenHarmony',
    'Process name:/system/bin/hilogd',
    'Timestamp:2026-11-11 20:16:10',
    'Reason:Signal:SIGSEGV(SEGV_MAPERR)@0x00000000c31d5556',
    'Fault thread info:',
    '#00 pc 00000000000a1b2c /system/bin/hilogd(HilogDump+0x1c)',
    '#01 pc 0000000000012345 /system/lib64/libc.so(abort+0x30)',
  ].join('\n')
  const parsed = parseFaultLog(report)
  assert.equal(parsed.process, '/system/bin/hilogd')
  assert.match(parsed.reason, /SIGSEGV/)
  assert.equal(parsed.timestamp, '2026-11-11 20:16:10')
  assert.equal(parsed.frames.length, 2)
  assert.match(parsed.frames[0], /HilogDump/)
})

check('compile is refused in plan mode', async () => {
  const [guarded] = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })
  const blocked = await guarded.execute({ action: 'compile', projectDir: process.cwd() }, {})
  assert.equal(blocked.ok, false)
  assert.equal(blocked.data.stage, 'plan-guard')
  assert.match(blocked.summary, /plan/)
})

check('file action requires a remote path and guards send in plan mode', async () => {
  const [plain] = createHarmonyTools({})
  const missing = await plain.execute({ action: 'file', op: 'pull' }, {})
  assert.equal(missing.ok, false)
  assert.match(missing.summary, /remote/)
  const [guarded] = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })
  const blocked = await guarded.execute({ action: 'file', op: 'send', local: 'README.md', remote: '/data/local/tmp/x' }, {})
  assert.equal(blocked.ok, false)
  assert.equal(blocked.data.stage, 'plan-guard')
})

check('ui dump flattens a hierarchy and parses bounds', () => {
  const tree = { attributes: {}, children: [
    { attributes: { text: '登录', type: 'Button', clickable: 'true', bounds: '[100,200][300,260]', visible: 'true' }, children: [] },
    { attributes: { text: '', type: 'Column', clickable: 'false', bounds: '[0,0][10,10]' }, children: [
      { attributes: { text: '忘记密码', type: 'Text', clickable: 'false', bounds: '[10,20][110,60]' }, children: [] },
    ] },
  ] }
  const nodes = flattenUi(tree)
  assert.equal(nodes.length, 2)
  assert.deepEqual(nodes[0].bounds, { x1: 100, y1: 200, x2: 300, y2: 260, x: 200, y: 230 })
  assert.equal(nodes[1].text, '忘记密码')
  assert.equal(findUiNode(nodes, '忘记').text, '忘记密码')
})

await checkAsync('ui tap is refused while plan mode is active but dump/find/wait are allowed', async () => {
  const [guarded] = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })
  const tapped = await guarded.execute({ action: 'ui', op: 'tap', text: '登录' }, {})
  assert.equal(tapped.ok, false)
  assert.equal(tapped.data.stage, 'plan-guard')
  const waited = await guarded.execute({ action: 'ui', op: 'wait', text: '登录' }, {})
  assert.notEqual(waited.data?.stage, 'plan-guard', 'wait only reads the tree')
  const dumped = await guarded.execute({ action: 'ui', op: 'dump' }, {})
  assert.notEqual(dumped.data?.stage, 'plan-guard')
})

check('doctor is advertised and allowed while plan mode is active', async () => {
  assert.match(tool.description, /doctor/)
  const result = await tool.execute({ action: 'doctor', projectDir: process.cwd() }, { planMode: { get: () => ({ active: true }) } })
  assert.notEqual(result.data?.stage, 'plan-guard')
})

check('doctor exposes an opt-in fix switch that only repairs proven damage', () => {
  const fix = tool.parameters.properties.fix
  assert.equal(fix.type, 'boolean')
  assert.match(fix.description, /repair/)
  assert.match(fix.description, /Defaults to false/)
})

check('a stale build lock is reclaimed, a live one is left alone', () => {  const dir = mkdtempSync(join(tmpdir(), 'dsh-harmony-lock-'))
  mkdirSync(join(dir, '.hvigor'), { recursive: true })
  writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999, startedAt: Date.now() }))
  const stale = acquireBuildLock(dir)
  assert.equal(stale.ok, true, 'a dead pid must not block the build')
  assert.ok(stale.reclaimed, 'the lock explains why it was taken over')
  releaseBuildLock(stale.path)
  assert.equal(existsSync(lockPath(dir)), false)

  const live = acquireBuildLock(dir)
  assert.equal(live.ok, true)
  const second = acquireBuildLock(dir)
  assert.equal(second.ok, false, 'a live holder keeps the lock')
  assert.equal(second.holder.pid, process.pid)
  releaseBuildLock(live.path)
  rmSync(dir, { recursive: true, force: true })
})

check('the screen digest ignores traversal order but notices a changed screen', () => {
  const nodes = [
    { type: 'Text', text: '设置', clickable: true, bounds: { x: 10, y: 20, width: 100, height: 40 } },
    { type: 'Button', text: '返回', clickable: true, bounds: { x: 0, y: 0, width: 50, height: 30 } },
  ]
  assert.equal(uiFingerprint(nodes), uiFingerprint([...nodes].reverse()), 'sibling order is not part of the screen')
  const extra = [...nodes, { type: 'Text', text: '新消息', clickable: false, bounds: { x: 5, y: 90, width: 80, height: 20 } }]
  assert.notEqual(uiFingerprint(nodes), uiFingerprint(extra))
})

check('assertUi separates "missing", "too many" and "wrong screen"', () => {
  const nodes = [
    { type: 'Text', text: '设置', clickable: true, bounds: { x: 1, y: 1, width: 10, height: 10 } },
    { type: 'Text', text: '设置项', clickable: true, bounds: { x: 1, y: 20, width: 10, height: 10 } },
  ]
  assert.equal(assertUi(nodes, { text: '设置' }).ok, true, 'one match is enough when no count is given')
  assert.equal(assertUi(nodes, { text: '设置', count: 1 }).ok, false, 'two matches are not "exactly one"')
  assert.equal(assertUi(nodes, { text: '设置', count: 2 }).ok, true)
  assert.equal(assertUi(nodes, { text: '设置', absent: true }).ok, false)
  assert.equal(assertUi(nodes, { text: '登录', absent: true }).ok, true)
  const pinned = uiFingerprint(nodes)
  assert.equal(assertUi(nodes, { fingerprint: pinned }).ok, true)
  assert.equal(assertUi(nodes, { fingerprint: 'deadbeefdeadbeef' }).ok, false)
  assert.equal(assertUi(nodes, {}).ok, false, 'an empty expectation is a mistake, not a pass')
})

check('screenshot and devices stay usable in plan mode', async () => {
  const guarded = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })[0]
  const result = await guarded.execute({ action: 'devices' }, {})
  assert.notEqual(result.data?.stage, 'plan-guard')
})

check('parseBundleDump reads version fields and survives a missing bundle', () => {
  const installed = [
    'com.tze.xcommander:',
    '{',
    '    "appId": "com.tze.xcommander_BA3C",',
    '    "firstInstallTime": 1794400531658,',
    '    "installTime": 1794400531658,',
    '    "updateTime": 1794485965431,',
    '    "appDistributionType": "os_integration",',
    '    "codePath": "/data/app/el1/bundle/public/com.tze.xcommander",',
    '        "versionCode": 20260616,',
    '        "versionName": "2.1.0",',
    '}',
  ].join('\n')
  const state = parseBundleDump(installed)
  assert.equal(state.installed, true)
  assert.equal(state.versionName, '2.1.0')
  assert.equal(state.versionCode, '20260616')
  assert.equal(state.distributionType, 'os_integration')
  assert.equal(state.updateTime, 1794485965431)

  const missing = 'error: failed to get information and the parameters may be wrong.'
  assert.equal(parseBundleDump(missing).installed, false, 'a missing bundle has no codePath')

  const emptyName = installed.replace('"versionName": "2.1.0"', '"versionName": ""')
  assert.equal(parseBundleDump(emptyName).versionName, '', 'an empty versionName stays empty, not undefined')
})

check('app op=query is read-only, so plan mode lets it through', async () => {
  const guarded = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })[0]
  const query = await guarded.execute({ action: 'app', op: 'query', bundleName: 'com.tze.xcommander' }, {})
  assert.notEqual(query.data?.stage, 'plan-guard', 'querying what is installed does not change the device')
  const start = await guarded.execute({ action: 'app', op: 'start', bundleName: 'com.tze.xcommander' }, {})
  assert.equal(start.data?.stage, 'plan-guard', 'starting an app still needs build mode')
})

check('hvigor ERROR is parsed with its code, message and hints', () => {
  const parsed = parseHvigorOutput([
    '> hvigor ERROR: Failed :entry:default@CompileArkTS...',
    '> hvigor ERROR: 00304004 Not Found',
    'Error Message: Module "entry" not found in build-profile.json5.',
    '* Try the following:',
    '  > Check the module name in build-profile.json5',
  ])
  assert.ok(parsed.errors.length >= 1)
  const coded = parsed.errors.find((error) => error.code === '00304004')
  assert.ok(coded, 'expected the coded hvigor error')
  assert.match(String(coded.message), /Not Found/)
  assert.match(String(coded.detail ?? ''), /Module "entry" not found/)
  assert.ok(parsed.hints.some((hint) => /module name/.test(hint)))
})

check('ArkTS file:line:column is extracted', () => {
  const parsed = parseHvigorOutput(['ERROR: ArkTS:ERROR File: C:\\app\\entry\\src\\main\\ets\\pages\\Index.ets:42:7'])
  const arkts = parsed.errors.find((error) => error.source === 'arkts')
  assert.ok(arkts, 'expected an arkts entry')
  assert.equal(arkts.line, 42)
  assert.equal(arkts.column, 7)
})

check('ohpm failures become structured errors', () => {
  const parsed = parseOutput(['ohpm ERROR: Fetch local file failed, ENOENT: no such file, open C:\\libs\\x.har'])
  assert.ok(parsed.errors.some((error) => error.source === 'ohpm'))
})

check('hdc install failures become structured errors', () => {
  const parsed = parseOutput(['[Fail]Error: failed to install bundle, code:9568322'])
  assert.ok(parsed.errors.some((error) => error.source === 'hdc'))
})

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-harmony-selftest-'))
function writeProject({ signing }) {
  mkdirSync(join(sandbox, 'AppScope'), { recursive: true })
  mkdirSync(join(sandbox, 'entry', 'src', 'main'), { recursive: true })
  writeFileSync(join(sandbox, 'AppScope', 'app.json5'), '{ "app": { "bundleName": "com.example.demo" } }')
  writeFileSync(join(sandbox, 'build-profile.json5'), [
    '{',
    '  "app": {',
    `    ${signing ? '"signingConfigs": [ { "name": "default", "material": { "certpath": "a.cer", "profile": "a.p7b" } } ],' : '"signingConfigs": [],'}`,
    '    "products": [{ "name": "default" }]',
    '  },',
    '  "modules": [{ "name": "entry", "srcPath": "./entry" }]',
    '}',
  ].join('\n'))
  writeFileSync(join(sandbox, 'entry', 'src', 'main', 'module.json5'), '{ "module": { "mainElement": "EntryAbility", "abilities": [{ "name": "EntryAbility" }] } }')
}

check('signingState sees a configured material block', () => {
  writeProject({ signing: true })
  assert.equal(signingState(sandbox).configured, true)
})

check('signingState reports an empty signingConfigs as not configured', () => {
  writeProject({ signing: false })
  assert.equal(signingState(sandbox).configured, false)
})

check('inferTarget reads bundleName and mainElement', () => {
  writeProject({ signing: true })
  const target = inferTarget(sandbox)
  assert.equal(target.bundleName, 'com.example.demo')
  assert.equal(target.ability, 'EntryAbility')
})

check('every declared skill file exists with a non-empty body', () => {
  assert.ok(SKILLS.length >= 4)
  for (const skill of SKILLS) {
    const raw = readFileSync(new URL(skill.file, new URL('../index.js', import.meta.url)), 'utf8')
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    assert.ok(body.length > 200, `${skill.name} body too small (${body.length} chars)`)
    assert.match(raw, new RegExp(`name: ${skill.name}`), `${skill.name} frontmatter name mismatch`)
    assert.ok(skill.whenToUse.length > 30, `${skill.name} needs a whenToUse`)
  }
})

check('apply registers /build and /mode, and /build leaves plan mode', () => {
  const commands = []
  const created = []
  let planActive = true
  const ctx = {
    effect: (fn) => fn(),
    skills: { register() {} },
    tools: { register() {} },
    commands: { register: (command) => commands.push(command) },
    planMode: {
      get: () => ({ active: planActive }),
      set: (_agent, active) => {
        planActive = active
        return 'committed'
      },
    },
    goals: {
      get: () => undefined,
      create: (_agent, request) => {
        created.push(request)
        return { id: 'goal-test', revision: 1, ...request }
      },
      clear: () => ({ id: 'goal-test', revision: 2 }),
    },
    connection: { fetch: { register() {} } },
    agentPresets: { register: async () => () => {} },
    get: (name) => (name === 'connection' ? ctx.connection : undefined),
    inject: (_deps, fn) => fn(ctx),
  }
  apply(ctx)
  const build = commands.find((command) => command.name === 'build')
  const mode = commands.find((command) => command.name === 'mode')
  assert.ok(build, '/build is not registered')
  assert.ok(mode, '/mode is not registered')
  const output = build.handler({ agent: {}, rawInput: '', attachments: [] })
  assert.equal(output.kind, 'success')
  assert.equal(planActive, false, '/build must leave plan mode')
  assert.match(output.text, /已退出 plan 模式/, '/build should say plan mode was left')
  const again = build.handler({ agent: {}, rawInput: '', attachments: [] })
  assert.match(again.text, /已在 build 模式/, '/build in build mode should be a no-op message')
  assert.match(mode.handler({ agent: {}, rawInput: '', attachments: [] }).text, /当前模式/)

  const goal = commands.find((command) => command.name === 'goal')
  assert.ok(goal, '/goal is not registered')
  const vago = goal.handler({ agent: {}, rawInput: '让首页支持深色模式', attachments: [] })
  assert.equal(vago.kind, 'error')
  assert.match(vago.text, /完成判据/)
  const partial = goal.handler({ agent: {}, rawInput: '让首页支持深色模式；完成判据：切换后背景变深', attachments: [] })
  assert.equal(partial.kind, 'error')
  assert.match(partial.text, /验证方式/)
  const good = goal.handler({
    agent: {},
    rawInput: '让首页支持深色模式；完成判据：切换后背景变深；验证方式：harmony run 后截图对比；轮次：6',
    attachments: [],
  })
  assert.equal(good.kind, 'success', good.text)
  assert.equal(created.length, 1)
  assert.equal(created[0].maxGoalRounds, 6)
  assert.match(created[0].objective, /完成判据/)
})

check('preset is registered at runtime, not as a Loader row', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /preset-minimal/, 'the shipped minimal row must not be overridden')
  if (YAML) {
    const doc = YAML.parse(source)
    const inserted = doc.flatMap((row) => row.insert ?? [])
    assert.deepEqual(inserted.map((row) => row.id), ['harmony-skills'])
  }
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /agentPresets\.register\(harmonyPreset\)/)
})

check('preset definition carries a mountable plugin set', () => {
  assert.equal(harmonyPreset.id, 'harmony')
  assert.ok(harmonyPreset.name && harmonyPreset.description, 'preset needs a display name and description')
  assert.ok(harmonyPreset.plugins.length >= 15, `preset only has ${harmonyPreset.plugins.length} rows`)
  const names = []
  const walk = (rows) => {
    for (const row of rows) {
      if (row.group) walk(row.config)
      else names.push(row.name)
    }
  }
  walk(harmonyPreset.plugins)
  assert.ok(!names.some((name) => name.endsWith('/list-agents')), 'that subpath is absent from the package exports')
  for (const name of names) assert.match(name, /^(@deepseek-ai\/|@local\/|cordis:)/, `suspicious plugin name ${name}`)
  const plan = names.filter((name) => name === '@deepseek-ai/dsh-plan-mode')
  assert.equal(plan.length, 1, 'plan-mode must be mounted exactly once')
})

check('plan-mode section is non-empty', () => {
  const planning = harmonyPreset.plugins.find((row) => row.group && row.config.some((child) => child.name === '@deepseek-ai/dsh-plan-mode'))
  assert.ok(planning, 'planning group missing')
  const section = planning.config.find((child) => child.name === '@deepseek-ai/dsh-plan-mode').config.section
  assert.ok(section.length > 500, `plan-mode section too small (${section.length} chars)`)
  assert.match(section, /exit_plan_mode/)
})

check('every t() key exists in both client dictionaries', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const keys = new Set([...source.matchAll(/\bt\('([A-Za-z][\w.]*)'/g)].map((match) => match[1]))
  assert.ok(keys.size > 20, `only ${keys.size} keys found`)
  const missing = [...keys].filter((key) => {
    const pattern = new RegExp(`\\n\\s+'?${key.replace(/\./g, '\\.')}'?:\\s*'`, 'g')
    return (source.match(pattern) ?? []).length < 2
  })
  assert.deepEqual(missing, [])
})

check('client registers a footer device badge that polls and lists ids', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("ctx.slots.inject('sidebar.footer.action'"), 'footer badge slot missing')
  assert.ok(source.includes("id: 'harmony-devices'"), 'footer badge id missing')
  const closed = Number(source.match(/const DEVICE_POLL_CLOSED = (\d+)/)?.[1])
  const open = Number(source.match(/const DEVICE_POLL_OPEN = (\d+)/)?.[1])
  assert.ok(closed > open && open >= 1000, 'badge must poll slower while closed, and not spin')
  assert.ok(source.includes("className: isPreferred ? 'hd-item hd-item-default' : 'hd-item'"), 'popover must render one row per device id')
  assert.ok(source.includes("PREFERRED_API = '/api/harmony/logs/preferred'"), 'badge must be able to change the default device')
  assert.ok(source.includes('DEVICE_POLL_CLOSED = 60000'), 'closed badge polls once a minute')
  assert.ok(source.includes("t('devicesCount', { n: devices.length })"), 'popover must show the count')
})

check('parseDeviceInfo turns the device probe into fields and omits what is absent', () => {
  const sample = [
    'M=TaiHang2105',
    'S=Taihang_V3.02.00.045U',
    'A=20',
    'B=100',
    'T=330',
    'V=4300000',
    'C=Charging',
    'U=53626.16',
    'MT=MemTotal:        7590740 kB',
    'MA=MemAvailable:    5121564 kB',
    'D=/dev/block/sda87 241076224 17909688 223166536 8% /data',
  ].join('\n')
  const info = parseDeviceInfo('009180680c438f8f', sample)
  assert.equal(info.id, '009180680c438f8f')
  assert.equal(info.model, 'TaiHang2105')
  assert.equal(info.osVersion, 'Taihang_V3.02.00.045U')
  assert.equal(info.apiVersion, 20)
  assert.equal(info.batteryLevel, 100)
  assert.equal(info.batteryTempC, 33)
  assert.equal(info.batteryVoltageMv, 4300)
  assert.equal(info.chargingStatus, 'Charging')
  assert.equal(info.uptimeSeconds, 53626)
  assert.equal(info.memoryTotalMb, 7413)
  assert.equal(info.storageUsedPercent, 8)
  assert.deepEqual(parseDeviceInfo('x', 'M=\nA='), { id: 'x' })
  assert.deepEqual(parseDeviceInfo('y', 'garbage'), { id: 'y' })
})

check('devices route attaches details and the badge renders them as chips', () => {
  const base = new URL('../', import.meta.url)
  const route = readFileSync(new URL('lib/hilog.js', base), 'utf8')
  assert.match(route, /collectDevicesInfo\(result\.devices\)/)
  assert.match(route, /details,/)
  const client = readFileSync(new URL('client.js', base), 'utf8')
  assert.match(client, /hd-chip/)
  assert.match(client, /devicesMemory/)
  assert.match(client, /STYLE_ID/)
  assert.ok(!/h\('style', null, CSS\)/.test(client), 'badge styles must not live inside the log panel')
})

check('error codes map to one concrete next action each', () => {
  const missing = explain("Failure[INSTALL_FAILED_VERIFY_APP_PKCS7_FAIL] code:9568305 entry's dependent module: common does not exist")
  assert.equal(missing.length, 1)
  assert.match(missing[0], /hsp=true/)

  const full = explain('error: install failed due to insufficient space, code:9568305')
  assert.equal(full.length, 1)
  assert.match(full[0], /空间/)
  assert.notEqual(full[0], missing[0], 'the two 9568305 cases must not share one hint')

  assert.match(explain('code:9568332 verify signature failed')[0], /AGC/)
  assert.deepEqual(explain('hvigor task finished with no code at all'), [])
  assert.ok(explain('9568332 and 1300002 and 401 and 202').length <= 3, 'hints must stay bounded')
})

check('parseTargets remembers the last device but never a disconnected one', () => {
  const connected = ['A', 'B']
  assert.deepEqual(parseTargets(connected, undefined, 'B'), { ids: ['B'], unknown: [], remembered: true })
  assert.deepEqual(parseTargets(connected, undefined, 'gone'), { ids: ['A'], unknown: [], remembered: false })
  assert.deepEqual(parseTargets(connected, undefined, undefined), { ids: ['A'], unknown: [], remembered: false })
  assert.deepEqual(parseTargets(connected, 'all', 'B'), { ids: ['A', 'B'], unknown: [], remembered: false })
})

check('findUiNodes returns matches best-first without touching the device', () => {
  const nodes = [
    { type: 'Button', text: '取消同步', clickable: false, bounds: { x: 1, y: 1 } },
    { type: 'Button', text: '取消', clickable: true, bounds: { x: 2, y: 2 } },
    { type: 'Text', text: '确定', clickable: true, bounds: { x: 3, y: 3 } },
  ]
  const hits = findUiNodes(nodes, '取消')
  assert.equal(hits.length, 2)
  assert.equal(hits[0].text, '取消')
  assert.deepEqual(findUiNodes(nodes, '不存在'), [])
})

check('docs search finds headings, snippets and caps hits per file', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-docs-'))
  try {
    mkdirSync(join(root, 'reference'))
    writeFileSync(join(root, 'reference', 'a.md'), '# Alpha\n\nfirst Needle here\n\nsecond needle here\n\nthird NEEDLE here\n')
    writeFileSync(join(root, 'b.md'), 'plain\n\none needle\n')
    writeFileSync(join(root, 'skip.txt'), 'needle in a non-markdown file\n')

    const found = searchDocs({ dirs: [root], query: 'needle' })
    assert.equal(found.stopped, 'done')
    assert.equal(found.hits.length, 3, 'two mentions in a.md plus one in b.md')
    const alpha = found.hits.filter((hit) => hit.file.endsWith('a.md'))
    assert.equal(alpha.length, 2, 'a single file must not flood the list')
    assert.equal(alpha[0].heading, 'Alpha')
    assert.match(alpha[0].snippet, /first Needle here/)
    assert.ok(found.scannedFiles >= 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('docs search reports when it stopped before finishing', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-docs-'))
  try {
    writeFileSync(join(root, 'a.md'), 'needle\n')
    const early = searchDocs({ dirs: [root], query: 'needle', deadlineMs: -1 })
    assert.equal(early.stopped, 'deadline')
    assert.deepEqual(early.hits, [])

    const capped = searchDocs({ dirs: [root], query: 'needle', maxBytes: 0 })
    assert.equal(capped.stopped, 'budget')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('docs read stays inside the configured roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-docs-'))
  const outside = mkdtempSync(join(tmpdir(), 'harmony-elsewhere-'))
  try {
    const file = join(root, 'a.md')
    writeFileSync(file, 'line1\nline2\nline3\nline4\n')
    const section = readDoc({ file, dirs: [root], line: 2, context: 4 })
    assert.equal(section.start, 1)
    assert.match(section.text, /line1/)
    assert.throws(() => readDoc({ file: join(outside, 'x.md'), dirs: [root] }), /不在已配置的文档目录/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

check('docs api lookup reads @since and @deprecated from d.ts', () => {
  const sdk = mkdtempSync(join(tmpdir(), 'harmony-sdk-'))
  try {
    writeFileSync(join(sdk, '@ohos.demo.d.ts'), [
      '/**',
      ' * Demo manager.',
      ' * @since 11',
      ' */',
      'declare namespace demoManager {',
      '  function publish(): void;',
      '}',
      '',
      '/**',
      ' * @since 9',
      ' * @deprecated since 12',
      ' */',
      'declare function oldApi(): void;',
    ].join('\n'))

    const hit = lookupApi({ sdkRoot: sdk, symbol: 'demoManager' })
    assert.equal(hit.since, '11')
    assert.equal(hit.deprecated, false)
    assert.match(hit.declaration, /declare namespace demoManager/)

    const old = lookupApi({ sdkRoot: sdk, symbol: 'oldApi' })
    assert.equal(old.since, '9')
    assert.equal(old.deprecated, true)

    assert.equal(lookupApi({ sdkRoot: sdk, symbol: 'notHere' }), null)
  } finally {
    rmSync(sdk, { recursive: true, force: true })
  }
})

check('package.json declares engines.dsh and a semver version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.ok(pkg.engines?.dsh, 'engines.dsh missing — an incompatible DSH would load this silently')
  assert.equal(pkg.scripts?.test, 'node scripts/selftest.mjs')
})

rmSync(sandbox, { recursive: true, force: true })

async function checkAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

await checkAsync('preferred route refuses a payload without a usable id', async () => {
  const route = createLogRoutes().find((entry) => entry.path === '/api/harmony/logs/preferred')
  assert.ok(route, 'preferred route must exist')
  const url = 'http://local/api/harmony/logs/preferred'
  assert.equal((await route.fetch(new Request(url, { method: 'POST', body: 'not json' }))).status, 400)
  assert.equal((await route.fetch(new Request(url, { method: 'POST', body: '{}' }))).status, 400)
})

await checkAsync('diagnostic budget separates ok, timeout, skipped and error', async () => {
  const budget = createBudget(10_000, { perProbeMs: 80 })
  const fast = await budget.probe('fast', async () => 42)
  assert.equal(fast.status, 'ok')
  assert.equal(fast.value, 42)

  const slow = await budget.probe('slow', () => new Promise(() => {}))
  assert.equal(slow.status, 'timeout')
  assert.match(slow.detail, /80ms/)

  const boom = await budget.probe('boom', async () => {
    throw new Error('nope')
  })
  assert.equal(boom.status, 'error')
  assert.match(boom.detail, /nope/)

  const spent = createBudget(0, { perProbeMs: 80 })
  assert.equal((await spent.probe('never', async () => 1)).status, 'skipped')
  assert.equal(budget.probes.length, 3)
})

await checkAsync('waitUntil stops at the first success and reports the deadline', async () => {
  let fakeNow = 0
  const sleep = async (ms) => { fakeNow += ms }
  let calls = 0
  const first = await waitUntil(async () => { calls += 1; return { ok: calls >= 3, value: calls } }, { timeoutMs: 10_000, intervalMs: 400, now: () => fakeNow, sleep })
  assert.equal(first.ok, true)
  assert.equal(first.attempts, 3)
  assert.equal(first.value, 3)

  fakeNow = 0
  let probes = 0
  const never = await waitUntil(async () => { probes += 1; return { ok: false, value: 'still there' } }, { timeoutMs: 1_000, intervalMs: 400, now: () => fakeNow, sleep })
  assert.equal(never.ok, false)
  assert.equal(never.value, 'still there')
  assert.equal(probes, 4)
  assert.equal(fakeNow, 1_000)
})

check('signing report reads the config, the materials and the product reference', () => {
  const source = `{
    // comment before the array
    "app": {
      "signingConfigs": [
        {
          "name": "release",
          "material": {
            "certpath": "/nowhere/app.cer",
            "profile": "/nowhere/app.p7b",
            "storeFile": "/nowhere/app.p12",
            "keyAlias": "debugKey",
            "signAlg": "SHA256withECDSA",
            "storePassword": "${'A'.repeat(72)}",
          },
        },
      ],
      "products": [{ "name": "default", "signingConfig": "release" }],
    },
  }`
  const report = signingReport(source, { exists: () => false })
  assert.equal(report.found, true)
  assert.equal(report.config.name, 'release')
  assert.equal(report.materials.length, 3)
  assert.ok(report.materials.every((material) => material.exists === false))
  assert.deepEqual(report.referenced, ['release'])
  assert.equal(report.certificate, null)
  assert.equal(report.devEcoEncrypted, true)
  const parsed = parseSigningConfigs(source)
  assert.equal(parsed.configs[0].material.keyAlias, 'debugKey')
  assert.equal(parsed.configs[0].material.hasStorePassword, true)
})

check('signing report admits a project without signingConfigs', () => {
  const report = signingReport('{ "app": { "products": [] } }', { exists: () => false })
  assert.equal(report.found, false)
  assert.equal(inspectCertificate('/nowhere/app.cer').error !== undefined, true)
})

await checkAsync('diagnostic budget ends the pass on the shared deadline', async () => {
  const tight = createBudget(400, { perProbeMs: 60 })
  assert.equal((await tight.probe('fast', async () => 1)).status, 'ok')
  assert.equal((await tight.probe('slow', () => new Promise(() => {}))).status, 'timeout')
  assert.equal((await tight.probe('again', async () => 3)).status, 'ok')
  assert.ok(tight.remaining() < 400)
  assert.ok(tight.elapsedMs >= 60, 'the timed-out probe still spends its time')
})

check('build lock refuses a live holder and reclaims a dead one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  try {
    const first = acquireBuildLock(dir)
    assert.equal(first.ok, true)
    const second = acquireBuildLock(dir, { pid: 4242 })
    assert.equal(second.ok, false)
    assert.equal(second.holder.pid, process.pid)
    assert.equal(releaseBuildLock(second.path, { pid: 4242 }), false, 'another pid cannot release our lock')
    assert.equal(releaseBuildLock(first.path), true)
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999, startedAt: Date.now() - 60_000 }))
    const third = acquireBuildLock(dir)
    assert.equal(third.ok, true)
    assert.match(String(third.reclaimed), /已退出/)
    assert.equal(releaseBuildLock(third.path), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a failed run names the next command, not just the failing stage', () => {
  assert.equal(attributeFailure({ lines: ['ERROR: ArkTS:ERROR File: C:/p/entry/src/main/ets/pages/Index.ets:42:9'] }).kind, 'compile')
  assert.equal(attributeFailure({ lines: ["code:9568305 error: ... entry's dependent module: nextMap does not exist"] }).kind, 'dependent')
  assert.equal(attributeFailure({ lines: ['error: 9568289 The signature of the profile does not match'] }).kind, 'signing')
  assert.equal(attributeFailure({ lines: ['FATAL EXCEPTION: main'] }).kind, 'crash')
  assert.equal(attributeFailure({ lines: ['没有已连接的设备'] }).kind, 'device')
  const unknown = attributeFailure({ lines: ['something odd'] })
  assert.equal(unknown.kind, 'unknown')
  assert.match(unknown.action, /doctor/)
})

check('a matrix is checked against every device, not the default target', () => {
  // Regression: the plan was validated against the single default device, so a
  // correctly written two-device matrix failed with "没有连接：<second id>".
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(
    source.includes("resolveTargets(exec, args.matrix ? 'all' : args.device)"),
    'run must resolve all devices when a matrix is given',
  )
})

check('a missing SDK location is explained in terms of the file to create', () => {
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  // hvigor stops on 00303208 within a second; the error names a file that does
  // not exist yet, so the hint has to say what belongs in it.
  assert.ok(source.includes('00303208'), 'build must recognise the SDK-location error')
  assert.ok(source.includes("join(projectDir, 'local.properties')"), 'and name the file, not just the variable')
  // Only OHOS_BASE_SDK_HOME satisfies hvigor; DEVECO_SDK_HOME does not, so the
  // doctor row must not promise it as a fallback.
  const doctor = source.slice(source.indexOf("row('local.properties'"), source.indexOf("row('hvigorw'"))
  assert.ok(doctor.includes('OHOS_BASE_SDK_HOME'), 'the row must check the variable hvigor actually reads')
  assert.ok(!/兜底[^\n]*DEVECO_SDK_HOME/.test(doctor), 'DEVECO_SDK_HOME is not a valid fallback for hvigor')
})

check('a forward-slash drive path is handed to hdc with backslashes', () => {
  // hdc resolved "D:/x/y.hap" under the current directory and said "no such file".
  assert.equal(nativePath('D:/workspace_6/app.hap'), 'D:\\workspace_6\\app.hap')
  assert.equal(nativePath('D:\\workspace_6\\app.hap'), 'D:\\workspace_6\\app.hap')
  assert.equal(nativePath('/data/local/tmp/a.txt'), '/data/local/tmp/a.txt')
  assert.equal(nativePath(undefined), undefined)
})

check('sign keeps report/verify/rebuild and no password path at all', () => {
  const toolsSource = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.match(toolsSource, /可用 report.*verify.*rebuild/, 'the tool advertises the three ops')
  assert.ok(!/keystorePwd|keyPwd|signCredentials|stage: 'credentials'/.test(toolsSource), 'the tool must not touch passwords')
  assert.ok(!toolsSource.includes('DSH_HARMONY_KEYSTORE_PASSWORD'), 'no password environment variables either')
  const signingSource = readFileSync(new URL('../lib/signing.js', import.meta.url), 'utf8')
  assert.ok(!/export async function signApp/.test(signingSource), 'signApp was the only path that put a password on a command line')
  const settingsSource = readFileSync(new URL('../lib/settings.js', import.meta.url), 'utf8')
  assert.ok(!/signCredentials/.test(settingsSource), 'the credential reader is gone')
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!clientSource.includes('/api/harmony/sign'), 'no signing route left in the client')
  assert.ok(!clientSource.includes('harmony-sign'), 'no signing settings section either')
})

check('plan mode refuses sign rebuild but lets verify through', async () => {
  const [guarded] = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })
  const rebuild = await guarded.execute({ action: 'sign', op: 'rebuild', projectDir: sandbox }, {})
  assert.equal(rebuild.ok, false)
  assert.equal(rebuild.data.stage, 'plan-guard')
  const verify = await guarded.execute({ action: 'sign', op: 'verify', projectDir: sandbox }, {})
  assert.notEqual(verify.data && verify.data.stage, 'plan-guard')
})

check('every fetch route declares methods and requestBody', () => {
  const routes = createLogRoutes()
  assert.ok(routes.length >= 4, `expected the log routes, got ${routes.length}`)
  for (const route of routes) {
    assert.ok(Array.isArray(route.methods) && route.methods.length > 0, `${route.path} has no methods`)
    assert.ok(route.requestBody === 'buffered' || route.requestBody === 'streaming', `${route.path} has no requestBody`)
    assert.equal(typeof route.fetch, 'function', `${route.path} has no fetch`)
  }
})

check('routes are registered inside ctx.effect on the bound service', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(source.includes('connection.fetch.register.bind(connection.fetch)'), 'register must be bound to the service')
  assert.ok(source.includes('webCtx.effect(() => register(route)'), 'a bare register() call does not reach the /api mux')
  assert.ok(!/webCtx\.connection\.fetch\.register\(/.test(source), 'no bare registration left behind')
})

check('device badge checks the status code before parsing JSON', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const start = source.indexOf('function useDeviceList')
  const end = source.indexOf('function DeviceIndicator', start)
  const block = source.slice(start, end === -1 ? undefined : end)
  assert.ok(start > -1, 'useDeviceList must exist')
  assert.ok(block.includes('if (!response.ok)'), 'the badge must check response.ok')
  assert.ok(block.includes('await response.json()'), 'and still read the body when the status is fine')
})

check('summarizeLogs folds repeats and keeps errors first', () => {
  const lines = [
    '11-17 20:00:00.100 100 100 I A03d00/JSAPP: boot',
    '11-17 20:00:00.200 100 101 E A03d00/JSAPP: ServiceClient_request failed',
    '  at com.tze.Foo(Entry.ets:12)',
    '11-17 20:00:00.300 100 101 E A03d00/JSAPP: ServiceClient_request failed',
    '11-17 20:00:00.400 200 200 I C015b0/NETSTACK: dns 0.073',
    '11-17 20:00:00.500 200 200 I C015b0/NETSTACK: dns 0.073',
    '11-17 20:00:00.600 200 200 I C015b0/NETSTACK: dns 0.073',
  ]
  const summary = summarizeLogs(lines)
  assert.equal(summary.parsed, 6)
  assert.equal(summary.ignored, 1)
  assert.equal(summary.pids, 2)
  assert.equal(summary.levels.E, 2)
  assert.equal(summary.errors[0].count, 2)
  assert.match(summary.errors[0].text, /ServiceClient_request failed/)
  assert.equal(summary.duplicates[0].count, 3)
  assert.equal(summary.firstAt, '11-17 20:00:00.100')
  assert.equal(summary.lastAt, '11-17 20:00:00.600')

  const text = formatLogSummary(summary)
  assert.match(text, /6 条记录/)
  assert.match(text, /2 个进程/)
  assert.match(text, /错误（按次数）：/)
  assert.match(text, /×2/)
  assert.match(text, /×3/)
  assert.ok(text.split('\n').length <= 12, 'the digest has to stay short')
})

check('formatLogSummary says so when the window is empty', () => {
  assert.match(formatLogSummary(summarizeLogs([])), /一行日志都没有/)
  assert.match(formatLogSummary(summarizeLogs(['not hilog at all'])), /都不像 hilog 记录/)
})

check('parseLogLine keeps level, tag and message', () => {
  const record = parseLogLine('11-17 20:00:00.200 100 101 E A03d00/JSAPP: boom')
  assert.equal(record.level, 'E')
  assert.equal(record.pid, '100')
  assert.equal(record.tag, 'A03d00/JSAPP')
  assert.equal(record.message, 'boom')
  assert.equal(parseLogLine('  at com.tze.Foo(Entry.ets:12)'), null)
})

check('logs exposes a view switch and summarises by default', () => {
  const schema = tools[0].parameters.properties
  assert.deepEqual([...schema.view.enum], ['summary', 'raw'])
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(source.includes("String(args.view ?? 'summary')"), 'summary is the default view')
  assert.ok(source.includes('formatLogSummary(digest)'), 'the default branch renders the digest')
})

check('parseLsListing keeps names with spaces and sorts directories first', () => {
  const listing = [
    'total 12',
    'drwxrwx--x 2 shell shell 4096 2025-11-10 20:11 .',
    'drwxrwx--x 2 shell shell 4096 2025-11-10 20:11 .cache',
    '-rw-r--r-- 1 shell shell   44 2025-11-10 20:05 dsh-file-test.txt',
    '-rw-r--r-- 1 shell shell  128 2025-11-10 20:07 my log file.txt',
  ].join('\n')
  const entries = parseLsListing(listing)
  assert.equal(entries.length, 3, 'dot rows are dropped')
  assert.equal(entries[0].name, '.cache')
  assert.equal(entries[0].dir, true)
  assert.equal(entries[1].name, 'dsh-file-test.txt')
  assert.equal(entries[1].size, 44)
  assert.equal(entries[1].mtime, '2025-11-10 20:05')
  assert.equal(entries[2].name, 'my log file.txt', 'a space in the name is not a column')
})

check('parseDuKb and formatBytes answer in units a person reads', () => {
  assert.equal(parseDuKb('1234\t/data/local/tmp'), 1234)
  assert.equal(parseDuKb('du: /nope: No such file or directory'), undefined)
  assert.equal(formatBytes(812), '812 B')
  assert.equal(formatBytes(1433), '1.4 KB')
  assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB')
  assert.equal(formatEntry({ name: 'a.txt', dir: false, link: false, size: 44, mtime: '2025-11-10 20:05' }), '- ' + formatBytes(44).padStart(7) + '  2025-11-10 20:05  a.txt')
})

check('file action exposes the read-only ops and still guards send', () => {
  const schema = tools[0].parameters.properties
  for (const op of ['ls', 'cat', 'du']) assert.ok(schema.op.enum.includes(op), `${op} is offered`)
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(source.includes("if (op === 'ls' || op === 'cat' || op === 'du')"), 'the three ops share one branch')
  assert.ok(/next === 'send'/.test(source) || source.includes("op === 'send'"), 'send keeps its own permission shape')
})

check('checkReadOnlySql allows reads and refuses anything that writes', () => {
  for (const sql of ['select * from USER', '  WITH x AS (select 1) select * from x', 'pragma table_info(USER)', 'EXPLAIN select 1']) {
    assert.equal(checkReadOnlySql(sql).ok, true, sql)
  }
  for (const sql of ['', 'delete from USER', 'update USER set a=1', 'drop table USER', "attach database '/tmp/x' as y"]) {
    assert.equal(checkReadOnlySql(sql).ok, false, sql)
  }
  assert.equal(checkReadOnlySql("select * from USER where note = 'delete me'").ok, true, 'quoted text is not a write')
})

check('formatRows clips wide cells and marks truncation', () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({ id: index, blob: 'x'.repeat(80) }))
  const table = formatRows(rows, { maxRows: 2, maxCell: 20 })
  assert.equal(table.truncated, true)
  assert.equal(table.shown, 2)
  assert.match(table.lines[0], /id/)
  assert.ok(table.lines[2].includes('…'), 'long values are clipped')
  assert.deepEqual(formatRows([]).lines, ['（0 行）'])
})

check('db action lists and queries with a sql parameter', () => {
  const schema = tools[0].parameters.properties
  assert.ok(schema.action.enum.includes('db'), 'db is an action')
  assert.ok(schema.op.enum.includes('list'), 'op=list exists')
  assert.equal(schema.sql.type, 'string')
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  const dbSource = readFileSync(new URL('../lib/db.js', import.meta.url), 'utf8')
  assert.ok(dbSource.includes('readOnly: true'), 'sqlite is opened read-only')
  assert.ok(source.includes("import { checkReadOnlySql, formatRows, queryDatabase } from './db.js'"))
})

check('parseTraceLine reads comm, pid, cpu, timestamp and event', () => {
  const record = parseTraceLine('  xcommander-1234  ( 1234) [003] d..1 1234.567890: sched_switch: prev_comm=idle')
  assert.equal(record.comm, 'xcommander')
  assert.equal(record.pid, 1234)
  assert.equal(record.cpu, 3)
  assert.equal(record.ts, 1234.56789)
  assert.equal(record.event, 'sched_switch')
  assert.equal(parseTraceLine('# tracer: nop'), null)
})

check('summarizeTrace ranks events and processes and flags a full buffer', () => {
  const lines = [
    '# entries-in-buffer/entries-written: 100/100   #P:8',
    '  a-1  ( 1) [000] d..1 10.000000: sched_switch: prev_comm=a',
    '  a-1  ( 1) [000] d..1 10.500000: sched_switch: prev_comm=a',
    '  b-2  ( 2) [001] d..1 10.750000: sched_wakeup: comm=b',
  ]
  const summary = summarizeTrace(lines)
  assert.equal(summary.parsed, 3)
  assert.equal(summary.durationMs, 750)
  assert.deepEqual(summary.byEvent[0], ['sched_switch', 2])
  assert.deepEqual(summary.byComm[0], ['a', 2])
  assert.deepEqual(summary.cpus, [0, 1])
  assert.equal(summary.bufferFull, true)
  const text = formatTraceSummary(summary)
  assert.match(text, /3 条事件 · 750 ms · 2 个 CPU · 缓冲区已写满/)
  assert.match(text, /sched_switch/)
  assert.match(formatTraceSummary(summarizeTrace(['# only a header'])), /没有可解析的 trace 记录/)
})

check('trace action takes a category list and refuses a busy tracing service loudly', () => {
  const schema = tools[0].parameters.properties
  assert.ok(schema.action.enum.includes('trace'), 'trace is an action')
  assert.equal(schema.categories.type, 'string')
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(source.includes('OpenRecording failed'), 'the 1103 message is recognised')
  assert.ok(source.includes('hitrace --stop_bgsrv'), 'the snapshot server is restarted once')
  assert.ok(source.includes('perfetto'), 'the raw file is handed over instead of a fake flame graph')
})

// Read-only code page: the guard matters most, because this route reads files.
const codeFixture = mkdtempSync(join(tmpdir(), 'harmony-code-'))
mkdirSync(join(codeFixture, 'AppScope'), { recursive: true })
mkdirSync(join(codeFixture, 'entry/src/main/ets/pages'), { recursive: true })
mkdirSync(join(codeFixture, 'node_modules/skipme'), { recursive: true })
writeFileSync(join(codeFixture, 'build-profile.json5'), '{}\n')
writeFileSync(join(codeFixture, 'entry/src/main/ets/pages/Index.ets'), [
  'import { router } from "@kit.ArkUI"',
  '',
  '@Entry',
  '@Component',
  'struct Index {',
  '  build() {}',
  '}',
  '',
  'function tapCounter(): void {}',
].join('\n'))
writeFileSync(join(codeFixture, 'node_modules/skipme/hidden.ts'), 'struct Hidden {}\n')

check('code page refuses paths outside the project root', () => {
  assert.equal(insideRoot(codeFixture, '../escape.txt'), null)
  assert.equal(insideRoot(codeFixture, '/etc/passwd'), null)
  assert.ok(insideRoot(codeFixture, 'entry/src/main/ets/pages/Index.ets') !== null)
})

check('code tree lists project files and skips node_modules', () => {
  const tree = listTree(codeFixture)
  const paths = tree.entries.map((entry) => entry.path)
  assert.ok(paths.includes('entry/src/main/ets/pages/Index.ets'))
  assert.ok(!paths.some((item) => item.startsWith('node_modules')))
  assert.ok(tree.entries.some((entry) => entry.path === 'entry' && entry.dir === true))
})

check('code file reader caps size and refuses binary extensions', () => {
  const read = readSource(codeFixture, 'entry/src/main/ets/pages/Index.ets')
  assert.equal(read.ok, true)
  assert.ok(read.text.includes('struct Index'))
  const capped = readSource(codeFixture, 'entry/src/main/ets/pages/Index.ets', { maxBytes: 10 })
  assert.equal(capped.truncated, true)
  assert.equal(capped.text.length, 10)
  writeFileSync(join(codeFixture, 'app.bin'), Buffer.from([0, 1, 2]))
  assert.equal(readSource(codeFixture, 'app.bin').ok, false)
})

check('code symbol search finds declarations by name', () => {
  const found = findSymbols(codeFixture, 'index')
  assert.ok(found.results.some((item) => item.name === 'Index' && item.kind === 'struct' && item.line === 5))
  const fn = findSymbols(codeFixture, 'tapCounter')
  assert.ok(fn.results.some((item) => item.kind === 'function' && item.name === 'tapCounter'))
  assert.equal(findSymbols(codeFixture, '').results.length, 0)
})

check('code route answers tree/file/find and rejects non-project roots', () => {
  const ask = (query) => handleCodeRequest(new URL(`http://x/api/harmony/code?${query}`))
  const root = encodeURIComponent(codeFixture)
  const tree = ask(`op=tree&root=${root}`)
  assert.equal(tree.status, 200)
  const file = ask(`op=file&root=${root}&path=${encodeURIComponent('entry/src/main/ets/pages/Index.ets')}`)
  assert.equal(file.status, 200)
  const find = ask(`op=find&root=${root}&q=Index`)
  assert.equal(find.status, 200)
  const outside = ask(`op=file&root=${root}&path=${encodeURIComponent('../../etc/passwd')}`)
  assert.equal(outside.status, 404)
  const notProject = ask(`op=tree&root=${encodeURIComponent(tmpdir())}`)
  assert.equal(notProject.status, 400)
})

check('code page is registered as a panel and a page, and its route is hosted', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(client.includes("key: 'harmony-code'"), 'the page is registered on the main slot')
  assert.ok(client.includes("id: 'harmony-code'"), 'the sidebar entries point at it')
  assert.ok(client.includes('CODES_API'), 'the page talks to the code route')
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(index.includes('createCodeRoutes()'), 'the host registers the code route')
  assert.ok(index.includes('createLogRoutes(), ...createCodeRoutes()'), 'both route sets are mounted in one loop')
})

rmSync(codeFixture, { recursive: true, force: true })


// Cache strategy: isolating while the IDE is open avoids a cache fight, sharing
// while it is closed is ~40 s faster on a multi-module project.
check('isolation policy shares the warm cache and isolates only when it must', () => {
  const shared = resolveHvigorIsolation({ writable: true, canIsolate: true })
  assert.equal(shared.isolated, false)
  assert.ok(shared.reason.includes('缓存'), 'the faster path is named')
  const readOnly = resolveHvigorIsolation({ writable: false, canIsolate: true })
  assert.equal(readOnly.isolated, true)
  assert.ok(readOnly.reason.includes('不可写'), 'the reason names the actual blocker')
  const noWrapper = resolveHvigorIsolation({ writable: false, canIsolate: false })
  assert.equal(noWrapper.isolated, false)
  assert.ok(noWrapper.reason.includes('wrapper'))
  assert.equal(resolveHvigorIsolation({ requested: true, writable: true, canIsolate: true }).isolated, true)
  assert.equal(resolveHvigorIsolation({ requested: false, writable: false, canIsolate: true }).isolated, false)
})

check('build reports which cache strategy ran', () => {
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(source.includes('hvigor 缓存：'), 'the summary names the strategy')
  assert.ok(source.includes('resolveHvigorIsolation({ requested: args.isolateHome })'), 'the flag reaches the policy')
  assert.ok(source.includes('data.isolation') || source.includes('isolation: { isolated:'), 'the decision is in data')
})

check('hdc server sampling merges two snapshots into one line', () => {
  const raw = {
    first: { pid: 9796, threads: 136, handles: 398, vm: 5561610240, ws: 23269376, cpu: 62212812500, start: '2026-11-18T10:40:28.000Z', at: 1000 },
    second: { pid: 9796, threads: 136, handles: 398, vm: 5561610240, ws: 23269376, cpu: 62212968750, start: '2026-11-18T10:40:28.000Z', at: 2000 },
  }
  const sample = mergeHdcSnapshots(raw, { now: Date.parse('2026-11-18T12:40:28.000Z') })
  // 156250 * 100ns = 0.0156 s of CPU over 1 s -> 0.016 cores.
  assert.ok(Math.abs(sample.cpuCores - 0.0156) < 0.001, `cpu delta math: ${sample.cpuCores}`)
  assert.equal(sample.pid, 9796)
  assert.ok(Math.abs(sample.virtualGb - 5.18) < 0.01)
  assert.ok(Math.abs(sample.uptimeHours - 2) < 0.01)
  const line = formatHdcServer(sample)
  assert.ok(line.includes('136 线程') && line.includes('CPU 0.02 核'), line)
  // PowerShell collapses one-element arrays to objects; that shape must work.
  assert.ok(mergeHdcSnapshots({ first: raw.first, second: raw.second }), 'single-object snapshots are accepted')
  assert.equal(mergeHdcSnapshots({ first: [], second: [] }), undefined)
})

check('hdc server classifier stays quiet on a fresh server and loud on a leaking one', () => {
  const fresh = classifyHdcServer({ threads: 136, virtualGb: 5.18, cpuCores: 0.014 })
  assert.equal(fresh.level, 'ok')
  assert.deepEqual(fresh.reasons, [])
  const leaking = classifyHdcServer({ threads: 138, virtualGb: 5.46, cpuCores: 0.17 })
  assert.equal(leaking.level, 'warn')
  assert.ok(leaking.reasons.some((reason) => reason.includes('个核')), leaking.reasons.join('，'))
  const worse = classifyHdcServer({ threads: 300, virtualGb: 11, cpuCores: 0.4 })
  assert.equal(worse.level, 'critical')
  assert.equal(worse.reasons.length, 3)
  assert.ok(HDC_THRESHOLDS.cpuCoresWarn > 0, 'thresholds are exported for documentation')
})

check('device details are opt-in and cached, not collected on every poll', () => {
  const source = readFileSync(new URL('../lib/hilog.js', import.meta.url), 'utf8')
  assert.ok(source.includes("searchParams.get('details') === '1'"), 'details need an explicit flag')
  assert.ok(/detailsCache\.at < detailsTtlMs/.test(source), 'a cache hit skips the shell probe')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('?details=1'), 'the badge asks for details only when open')
  assert.ok(/openRef\.current === true && Date\.now\(\) - detailsAt\.current > 15_000/.test(client), 'details refresh is throttled to 15 s')
})

check('doctor reports the hdc server and can recycle it', () => {
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(source.includes("row('hdc 服务'"), 'doctor has a row for the server')
  assert.ok(source.includes('classifyHdcServer(hdcServer.sample)'), 'the row uses the classifier')
  assert.ok(source.includes('recycleHdcServer({ hdc: hdc.command })'), 'fix can recycle the server')
  assert.ok(source.includes('DevEco 的连接会闪断'), 'the repair states the side effect')
})

check('tools survive a context whose services are not injected', async () => {
  // Cordis throws on property access for services the plugin did not declare,
  // and the tests' plain object could never reproduce that — the real host did,
  // on the very first `harmony doctor` call after this guard was added.
  const strict = new Proxy({}, {
    get(_target, name) {
      throw new Error(`cannot get property "${String(name)}" without inject`)
    },
  })
  const [tool] = createHarmonyTools(strict)
  const result = await tool.execute({ action: 'devices' }, { agent: { session: {} } })
  assert.equal(typeof result.ok, 'boolean', 'the call answers instead of throwing')
  const planish = await tool.execute({ action: 'build' }, { agent: { session: {} } })
  assert.equal(typeof planish.ok, 'boolean', 'the plan guard does not explode')
})

check('api levels are read from either JSON5 form', () => {
  assert.deepEqual(apiLevels('"compileSdkVersion": 20, "compatibleSdkVersion": 12'), { compile: 20, compatible: 12 })
  assert.deepEqual(apiLevels('{"compileSdkVersion": "5.0.0(22)", "compatibleSdkVersion": "5.0.0(18)"}'), { compile: 22, compatible: 18 })
  assert.equal(apiLevels('{}').compile, null)
})

check('only @ohos and @kit imports are collected, with their line numbers', () => {
  const source = [
    "import { notificationManager } from '@ohos.notificationManager'",
    "import { UIAbility } from '@kit.AbilityKit'",
    "import { join } from 'node:path'",
    "export * from './local'",
  ].join('\n')
  const found = extractApiImports(source)
  assert.equal(found.length, 2)
  assert.equal(found[0].specifier, '@ohos.notificationManager')
  assert.equal(found[0].line, 1)
  assert.equal(found[1].specifier, '@kit.AbilityKit')
  assert.equal(found[1].line, 2)
})

check('module @since is read past the licence header', () => {
  const text = ['/*', ' * Copyright', ' */', '/**', ' * @file', ' * @since 9', ' */', 'declare namespace x {}'].join('\n')
  assert.equal(moduleSince(text), '9')
  assert.equal(moduleSince('no version here'), 'unknown')
})

check('compat scan names imports newer than the target API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harmony-compat-'))
  const sdk = join(root, 'ets', 'api')
  const kits = join(root, 'ets', 'kits')
  mkdirSync(sdk, { recursive: true })
  mkdirSync(kits, { recursive: true })
  const project = join(root, 'project')
  mkdirSync(join(project, 'entry', 'src', 'main', 'ets'), { recursive: true })
  writeFileSync(join(sdk, '@ohos.old.d.ts'), '/**\n * @since 8\n */\ndeclare namespace old {}')
  writeFileSync(join(sdk, '@ohos.new.d.ts'), '/**\n * @since 22\n */\ndeclare namespace newer {}')
  writeFileSync(join(kits, '@kit.Mixed.d.ts'), "export { x } from '@ohos.old'\nexport { y } from '@ohos.new'")
  writeFileSync(join(project, 'entry', 'src', 'main', 'ets', 'Page.ets'), [
    "import { a } from '@ohos.old'",
    "import { b } from '@ohos.new'",
    "import { c } from '@kit.Mixed'",
  ].join('\n'))
  assert.equal(sinceOf('@kit.Mixed', { sdkRoot: sdk, kitsRoot: kits }), '22')
  const files = listSources(project)
  assert.equal(files.length, 1)
  const report = checkApiCompat({ sdkRoot: sdk, kitsRoot: kits, target: 20, files, root: project })
  assert.equal(report.over.length, 2, 'the API 22 module and the kit that exposes it')
  assert.ok(report.over.every((entry) => entry.since === '22'))
  const lines = formatApiCompat(report).join('\n')
  assert.ok(lines.includes('@ohos.new') && lines.includes('目标 API 20'), lines)
})
check('shared modules without a signed hsp are named, and only those', () => {
  const declared = [{ name: 'mapFunction' }, { name: 'mapCommon' }, { name: 'nextMap' }]
  const produced = [
    { file: 'D:/p/newMap/nextMap/build/default/outputs/default/nextMap-default-signed.hsp' },
    { file: 'D:/p/newMap/mapCommon/build/default/outputs/default/mapCommon-default-signed.hsp' },
    { file: 'D:/p/newMap/nextMap/build/default/outputs/default/nextMap-default-unsigned.hsp' },
  ]
  assert.deepEqual(missingSharedModules(declared, produced), ['mapFunction'])
  assert.deepEqual(missingSharedModules(declared, []), ['mapFunction', 'mapCommon', 'nextMap'])
  assert.deepEqual(missingSharedModules([], produced), [])
})

check('run repairs missing shared modules once instead of only advising', async () => {
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(source.includes('missingSharedModules(declaredShared, producedShared)'), 'run compares declared with produced')
  assert.ok(source.includes('await build({ ...args, hsp: true }, exec)'), 'run rebuilds hsp when artifacts are missing')
  assert.ok(source.includes('已修：'), 'the repair is reported, not silent')
})
check('arkui components declared in .d.ets are resolved too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-dets-'))
  const api = join(dir, 'api')
  mkdirSync(api, { recursive: true })
  writeFileSync(join(api, '@ohos.arkui.advanced.DemoCard.d.ets'), '/**' + '\n' + ' * @kit ArkUI' + '\n' + ' */' + '\n' + '/**' + '\n' + ' * @since 10' + '\n' + ' */' + '\n' + 'export declare struct DemoCard {}')
  assert.equal(sinceOf('@ohos.arkui.advanced.DemoCard', { sdkRoot: api }), '10')
  const hit = lookupApi({ sdkRoot: api, symbol: 'DemoCard' })
  assert.ok(hit, 'lookupApi finds declarations in .d.ets')
  assert.equal(hit.since, '10')
})
check('doc search hits carry a path relative to their root, and locate matches names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-docs-'))
  const root = join(dir, 'docs')
  mkdirSync(join(root, 'reference', 'kit'), { recursive: true })
  mkdirSync(join(root, 'guide'), { recursive: true })
  writeFileSync(join(root, 'reference', 'kit', 'js-apis-notificationManager.md'), '# NotificationManager\n\nnotificationManager.subscribe 用来订阅。')
  writeFileSync(join(root, 'guide', 'notification-overview.md'), '# 通知概览\n\n这里也提到 notificationManager。')
  const found = searchDocs({ dirs: [root], query: 'notificationManager' })
  assert.ok(found.hits.length >= 2)
  for (const hit of found.hits) {
    assert.ok(hit.rel && !hit.rel.includes(':' ) && !hit.rel.startsWith('\\'), `rel should be relative: ${hit.rel}`)
    assert.ok(existsSync(hit.file))
  }
  const located = locateDocs({ dirs: [root], name: 'notificationManager' })
  assert.equal(located.hits.length, 1)
  assert.equal(located.hits[0].rel, 'reference/kit/js-apis-notificationManager.md')
  const none = locateDocs({ dirs: [root], name: 'nothing-like-this' })
  assert.equal(none.hits.length, 0)
})
const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
