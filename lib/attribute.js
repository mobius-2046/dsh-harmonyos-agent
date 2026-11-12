/**
 * Turn the first real failure into one sentence that names the next command.
 *
 * The tool already prints four sections (compile / install / start / logs) and
 * a bag of hints; what was missing is the single "so what do I do now" line.
 * Rules are ordered by what the user can act on fastest: a compile error beats
 * everything else, because nothing downstream ran on real code.
 */

const COMPILE = /(?:ArkTS|ERROR)[^\n]*?((?:[A-Za-z]:)?[^\s:()]+\.(?:ets|ts|json5?|d\.ts)):(\d+):(\d+)/i
const SIGNING = /9568289|9568332|9568344|signature verification failed|parse profile prop check error|no signing config|unsigned/i
const DEPENDENT = /9568305|dependent module[\s\S]{0,120}does not exist/i
const NO_DEVICE = /no devices?|device (?:not found|offline)|\[Empty\]|目标为空|没有(?:已连接|可用)的设备/i
const LAUNCH = /error: failed to start|start ability failed|ability not found|bundle.*not (?:found|installed)/i
const CRASH = /FATAL EXCEPTION|jscrash|SIGSEGV|JS ERROR|Unhandled exception|Cannot find module/i

export const KINDS = {
  compile: { label: '编译错误', action: '按上面的文件与行号改代码，然后 `harmony action=compile` 快速复查（约是整包构建的一半时间）。' },
  signing: { label: '签名问题', action: '先跑 `harmony action=sign` 看配置与三个材料是否在位；确认 bundleName 与 .p7b 里的包名一致。' },
  dependent: { label: '缺少 HSP', action: '带 `hsp: true` 重新构建并安装：shared 模块的产物不全会让 entry 找不到依赖。' },
  device: { label: '设备问题', action: '`hdc list targets` 确认在线；多设备时用 `device: "<id>"` 指定，别让它落到空的默认值上。' },
  launch: { label: '启动失败', action: '确认 ability 名与 `module.json5` 的 `mainElement` 一致；应用装上了但起不来时用 `action=crash` 看故障日志。' },
  crash: { label: '运行崩溃', action: '`harmony action=crash bundleName=<包名>` 取最近一份 jscrash/cppcrash，读 Reason 与栈顶。' },
  unknown: { label: '未归类失败', action: '把上面第一段错误贴出来；或先跑 `action=doctor` 排除环境问题。' },
}

/**
 * @param {{stage?: string, lines?: string[], errors?: {message: string, file?: string, line?: number}[]}} input
 * @returns {{kind: keyof KINDS, label: string, action: string, evidence: string}}
 */
export function attributeFailure({ stage = 'build', lines = [], errors = [] } = {}) {
  const text = lines.join('\n')
  const first = errors[0]

  const compile = text.match(COMPILE)
  if (compile || (first?.file && first?.line)) {
    const where = compile ? `${compile[1]}:${compile[2]}` : `${first.file}:${first.line}`
    return { kind: 'compile', ...KINDS.compile, evidence: where }
  }
  if (DEPENDENT.test(text)) {
    return { kind: 'dependent', ...KINDS.dependent, evidence: '9568305' }
  }
  if (SIGNING.test(text)) {
    return { kind: 'signing', ...KINDS.signing, evidence: first?.message?.slice(0, 80) || '签名相关' }
  }
  if (CRASH.test(text)) {
    return { kind: 'crash', ...KINDS.crash, evidence: (text.match(CRASH) || [''])[0] }
  }
  if (NO_DEVICE.test(text)) {
    return { kind: 'device', ...KINDS.device, evidence: '未发现设备' }
  }
  if (LAUNCH.test(text)) {
    return { kind: 'launch', ...KINDS.launch, evidence: first?.message?.slice(0, 80) || '启动失败' }
  }
  if (stage === 'start') {
    return { kind: 'launch', ...KINDS.launch, evidence: '启动阶段' }
  }
  return { kind: 'unknown', ...KINDS.unknown, evidence: first?.message?.slice(0, 80) || '' }
}
