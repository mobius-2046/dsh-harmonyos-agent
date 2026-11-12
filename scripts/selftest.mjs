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
import { lookupApi, readDoc, searchDocs } from '../lib/docs.js'
import { explain } from '../lib/errorcodes.js'
import { waitUntil } from '../lib/wait.js'
import { assertUi, uiFingerprint } from '../lib/uiassert.js'
import { inspectCertificate, parseSigningConfigs, signingReport } from '../lib/signing.js'
import { acquireBuildLock, lockPath, releaseBuildLock } from '../lib/lock.js'
import { attributeFailure } from '../lib/attribute.js'
import {
  createHarmonyTools,
  parseFaultLog,
  filterLogLines,
  filterByPid,
  findUiNode,
  findUiNodes,
  flattenUi,
  inferTarget,
  parseBounds,
  parseBundleDump,
  parseHvigorOutput,
  parseOutput,
  parseTargets,
  signingState,
} from '../lib/tools.js'

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
  assert.deepEqual([...tool.parameters.properties.action.enum].sort(), ['app', 'build', 'compile', 'crash', 'deploy', 'deps', 'devices', 'docs', 'doctor', 'file', 'logs', 'run', 'screenshot', 'sign', 'ui'])
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

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
