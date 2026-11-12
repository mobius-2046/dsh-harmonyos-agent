/**
 * Why this file exists.
 *
 * hvigor and hdc surface numeric codes with almost no context: `code:9568305`
 * can mean "a shared package is missing" or "the device is full", and the two
 * need opposite fixes. The model sees the raw line and tends to guess. These
 * rules turn the code plus its surrounding text into one concrete next action.
 *
 * Rules are matched against the whole captured output, not just the code, so
 * the two 9568305 cases stay distinguishable. Unknown codes fall through and
 * `explain()` returns an empty array — never invent an explanation.
 */

const AGC = 'https://developer.huawei.com/consumer/cn/service/josp/agc/index.html'

/** @type {Array<{ code: string, test: RegExp, hint: string }>} */
export const RULES = [
  {
    code: '9568332',
    test: /9568332|signature info is inconsistent|verify signature failed/i,
    hint: `设备没有进签名 profile 的调试设备列表（9568332）。去 AGC 把设备 UDID 加进调试 Profile 并重新下载 .p7b，或在 DevEco 里重新自动签名：${AGC}`,
  },
  {
    code: '9568289',
    test: /9568289|old signature|signature.*(?:mismatch|conflict)/i,
    hint: '设备上已有同名应用但签名不同（9568289）。先卸掉旧包（action=app op=uninstall），或用同一套证书重签后再装。',
  },
  {
    code: '9568344',
    test: /9568344|hap.*not signed|unsigned hap/i,
    hint: '产物没有签名（9568344）。build-profile.json5 里配好 signingConfigs，或用 DevEco 的自动签名生成一份，再 action=build hsp=true 重建。',
  },
  {
    code: '9568305',
    test: /dependent module[\s\S]{0,200}does not exist/i,
    hint: '设备缺 entry 依赖的 HSP（9568305）。用 action=build hsp=true 重建出全部 shared 模块的 -signed.hsp；若某个 shared 模块始终没有产物，说明上次 assembleHsp 被打断。',
  },
  {
    code: '9568305',
    test: /insufficient (?:space|storage)|not enough (?:space|storage)|ENOSPC/i,
    hint: '设备存储空间不足（9568305）。清掉旧包或日志（action=app op=clear）后重试；HSP 分包工程一次要装二十多个包，占用比单 HAP 大。',
  },
  {
    code: '1300002',
    test: /1300002|install failed.*(?:bundle|package)|bundle.*not (?:found|exist)/i,
    hint: 'bundle 名对不上或应用没装（1300002）。确认 AppScope/app.json5 的 bundleName 与设备上已装的一致；拉起前先 action=deploy。',
  },
  {
    code: '201',
    test: /(?:\bcode:?\s*201\b|permission denied|verify permission)/i,
    hint: '权限不足（201）。检查 module.json5 的 requestPermissions 是否声明、是否需要 ACL 级权限（需在 AGC 申请）。',
  },
  {
    code: '202',
    test: /(?:\bcode:?\s*202\b|not a system application)/i,
    hint: '调用了系统应用才允许的接口（202）。换成公开 API，或确认目标设备是 debug 版本。',
  },
  {
    code: '401',
    test: /(?:\bcode:?\s*401\b|parameter (?:error|invalid|check failed))/i,
    hint: '参数不合法（401）。看堆栈里报错的那一行，核对传入的参数类型与取值范围。',
  },
  {
    code: '801',
    test: /(?:\bcode:?\s*801\b|capability not supported)/i,
    hint: '设备不支持该能力（801）。用 action=devices 看 API 版本，并按 API 版本降级实现。',
  },
  {
    code: '10002',
    test: /(?:\bcode:?\s*10002\b|certificate.*(?:verify|invalid)|ssl.*verify)/i,
    hint: '证书校验失败（10002）。检查 ohpm/hvigor 的 registry 证书，或企业代理是否替换了 TLS 证书。',
  },
  {
    code: '140112',
    test: /140112/,
    hint: '调试 profile 校验失败（140112）。常见于 profile 过期或设备不在 profile 里：在 AGC 重新生成调试 Profile，重新签名。',
  },
]

const MAX_HINTS = 3

/**
 * @param {string|string[]} input captured output, or its lines.
 * @returns {string[]} at most three de-duplicated hints, in rule order.
 */
export function explain(input) {
  const text = Array.isArray(input) ? input.join('\n') : String(input ?? '')
  if (text === '') return []
  const hints = []
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue
    if (hints.includes(rule.hint)) continue
    hints.push(rule.hint)
    if (hints.length === MAX_HINTS) break
  }
  return hints
}
