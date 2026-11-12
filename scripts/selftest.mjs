// Regression checks for the parts of this bundle that break silently.
//
// Run with `npm test` (node scripts/selftest.mjs). It does not need a DSH
// session: it asserts on the tool schema shapes, on the output parsers with
// real-world samples, and on the shipped skill files. The one thing it cannot
// cover is an actual hvigor build — do that once against a real project after
// changing lib/tools.js.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, SKILLS } from '../index.js'
import { harmonyPreset } from '../lib/preset.js'
import { parseDeviceInfo } from '../lib/deviceinfo.js'
import {
  createHarmonyTools,
  parseFaultLog,
  filterLogLines,
  filterByPid,
  findUiNode,
  flattenUi,
  inferTarget,
  parseBounds,
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

check('action enum covers build/run/devices/deploy/logs/screenshot/app/doctor/ui', () => {
  assert.deepEqual([...tool.parameters.properties.action.enum].sort(), ['app', 'build', 'compile', 'crash', 'deploy', 'deps', 'devices', 'doctor', 'file', 'logs', 'run', 'screenshot', 'ui'])
})

check('op covers the four app lifecycle operations and the five ui operations', () => {
  const values = [...tool.parameters.properties.op.enum]
  for (const value of ['start', 'stop', 'clear', 'uninstall']) assert.ok(values.includes(value), value)
  for (const value of ['dump', 'tap', 'input', 'key', 'swipe']) assert.ok(values.includes(value), value)
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
  assert.deepEqual(parseTargets(['a', 'b'], undefined), { ids: ['a'], unknown: [] })
  assert.deepEqual(parseTargets(['a', 'b'], 'all'), { ids: ['a', 'b'], unknown: [] })
  assert.deepEqual(parseTargets(['a', 'b'], 'b,a'), { ids: ['b', 'a'], unknown: [] })
  assert.deepEqual(parseTargets(['a', 'b'], 'a,c'), { ids: ['a'], unknown: ['c'] })
  assert.deepEqual(parseTargets([], 'all'), { ids: [], unknown: [] })
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

check('ui tap is refused while plan mode is active but dump is allowed', async () => {
  const planCtx = { planMode: { get: () => ({ active: true }) } }
  const tapped = await tool.execute({ action: 'ui', op: 'tap', text: '登录' }, planCtx)
  assert.equal(tapped.ok, false)
  assert.equal(tapped.data.stage, 'plan-guard')
  const dumped = await tool.execute({ action: 'ui', op: 'dump' }, planCtx)
  assert.notEqual(dumped.data?.stage, 'plan-guard')
})

check('doctor is advertised and allowed while plan mode is active', async () => {
  assert.match(tool.description, /doctor/)
  const result = await tool.execute({ action: 'doctor', projectDir: process.cwd() }, { planMode: { get: () => ({ active: true }) } })
  assert.notEqual(result.data?.stage, 'plan-guard')
})

check('screenshot and devices stay usable in plan mode', async () => {
  const guarded = createHarmonyTools({ planMode: { get: () => ({ active: true }) } })[0]
  const result = await guarded.execute({ action: 'devices' }, {})
  assert.notEqual(result.data?.stage, 'plan-guard')
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
  assert.ok(source.includes("className: 'hd-item'"), 'popover must render one row per device id')
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

check('package.json declares engines.dsh and a semver version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.ok(pkg.engines?.dsh, 'engines.dsh missing — an incompatible DSH would load this silently')
  assert.equal(pkg.scripts?.test, 'node scripts/selftest.mjs')
})

rmSync(sandbox, { recursive: true, force: true })

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
