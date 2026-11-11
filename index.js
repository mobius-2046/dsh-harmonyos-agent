import { readFileSync } from 'node:fs'
import { createLogRoutes } from './lib/hilog.js'
import { harmonyPreset } from './lib/preset.js'
import { createHarmonyTools } from './lib/tools.js'

/**
 * The HarmonyOS skills shipped with this bundle.
 *
 * Each entry is registered on the Host skill registry as an in-memory
 * ("runtime") skill, so the catalog does not depend on a filesystem path that
 * would break when the checkout moves. The markdown files keep their YAML
 * frontmatter so the same directory can later be pointed at by
 * `@deepseek-ai/dsh-skill-filesystem` (customSkillDirs) without edits.
 */
export const SKILLS = [
  {
    file: './skills/harmony-project.md',
    name: 'harmony-project',
    description:
      'HarmonyOS Stage-model project layout and the configuration files to read before changing ArkTS code (app.json5, module.json5, build-profile.json5, main_pages.json).',
    whenToUse:
      'Working in an existing HarmonyOS project: locating a module, adding a page or ability, declaring permissions, or diagnosing resource and routing errors. 鸿蒙工程结构、找模块、加页面/Ability、声明权限、资源或路由报错时。',
  },
  {
    file: './skills/harmony-arkts.md',
    name: 'harmony-arkts',
    description:
      'ArkTS static-language rules and ArkUI state-management decorators, plus the fixes for the compiler errors this ruleset produces.',
    whenToUse:
      'Writing or reviewing .ets code, or fixing ArkTS type errors such as object literals without a declared type, implicit any, or decorator misuse. 写 .ets、修 ArkTS 类型错误、状态管理装饰器用错时。',
  },
  {
    file: './skills/harmony-build-deploy.md',
    name: 'harmony-build-deploy',
    description:
      'Decision table for the harmony tool (build / run / devices / deploy / logs), the hvigorw and hdc commands behind it, artifact paths, signing, and the runtime pitfalls that produce opaque failures.',
    whenToUse:
      'Building a HAP, installing to a device or emulator, wiring signing, reading hilog after a failed run, or when a build/install fails with an opaque error. 编译不过、构建失败、装不上、真机签名报错、闪退要看日志时。',
  },
  {
    file: './skills/harmony-ohpm.md',
    name: 'harmony-ohpm',
    description:
      'ohpm dependency management for HarmonyOS: registry configuration, install/lockfile behaviour, workspace and .har/.tgz dependencies, and the fixes for the failures that actually happen.',
    whenToUse:
      'Adding or upgrading a dependency, a missing @ohos/@kit import, ohpm install failures, lockfile or registry problems, or vendored .har packages. 装依赖、ohpm install 失败、找不到包、registry 或 lockfile 冲突时。',
  },
]

const SOURCE = '@local/dsh-harmony'

/** Drop a leading YAML frontmatter block; the body is what the model reads. */
function stripFrontmatter(raw) {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

// `agentPresets` is declared here, not reached through `ctx.inject`: cordis
// refuses `ctx.agentPresets` on a fiber that never declared the service, and
// this plugin's whole point is to register its preset as soon as it loads.
export const inject = ['skills', 'tools', 'agentPresets']

export function apply(ctx) {
  for (const skill of SKILLS) {
    const raw = readFileSync(new URL(skill.file, import.meta.url), 'utf8')
    const content = stripFrontmatter(raw)
    ctx.effect(() => ctx.skills.register({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      content,
      source: SOURCE,
    }))
  }

  for (const tool of createHarmonyTools(ctx)) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // Mode entry points. `/plan` (enter) and `/goal` come from their own plugins;
  // these two only make the third mode and the current state explicit, because
  // "exit plan mode" was previously a tool the model had to choose.
  ctx.inject(['commands', 'planMode', 'goals'], (modeCtx) => {
    modeCtx.effect(() => modeCtx.commands.register({
      definitionId: '@local/dsh-harmony/build',
      name: 'build',
      description: '退出 plan 模式，开始改动与构建（Leave plan mode）',
      input: { hint: '' },
      handler: (invocation) => {
        const state = modeCtx.planMode.get(invocation.agent)
        const wasActive = state.active || state.pending === true
        if (!wasActive) {
          return {
            kind: 'success',
            text: '已在 build 模式：直接描述要改什么即可。\n需要先出方案用 /plan；需要跨轮推进用 /goal <目标>。',
          }
        }
        const outcome = modeCtx.planMode.set(invocation.agent, false)
        const text = {
          committed: '已退出 plan 模式。现在进入 build：描述要改什么，或让我用 harmony run 构建 → 装机 → 抓日志。',
          queued: '已排队退出 plan 模式，下一条消息生效（当前这轮还在跑）。',
          cancelled: '已取消挂起的「进入 plan」，当前就是 build。',
          noop: '本来就不在 plan 模式。',
        }[outcome] ?? `已请求退出 plan 模式（${outcome}）。`
        return { kind: 'success', text }
      },
    }))

    modeCtx.effect(() => modeCtx.commands.register({
      definitionId: '@local/dsh-harmony/mode',
      name: 'mode',
      description: '查看当前的 plan / goal / build 状态',
      input: { hint: '' },
      handler: (invocation) => {
        const plan = modeCtx.planMode.get(invocation.agent)
        const goal = modeCtx.goals.get(invocation.agent)
        const planOn = plan.active || plan.pending === true
        const name = planOn ? 'plan（只读调研，用 exit_plan_mode 提交方案）' : goal?.phase === 'active' ? 'goal（跨轮自动推进）' : 'build（直接改代码并验证）'
        const lines = [`当前模式：${name}`, `plan: ${planOn ? 'on' : 'off'}${plan.pending === undefined ? '' : `（等待应用：${plan.pending}）`}`]
        lines.push(goal ? `goal: ${goal.phase} — ${goal.objective}${goal.activation === 'disarmed' ? '（已解除自动续跑，需 resume）' : ''}` : 'goal: 未设置')
        lines.push('', '切换：/plan 进入只读规划；/build 退出规划；/goal <目标> 开始跨轮推进；/goal clear 结束。')
        return { kind: 'success', text: lines.join('\n') }
      },
    }))
  })

  // The preset itself. It is registered through the Host `agentPresets` service
  // instead of a Loader row: the registry mounts the child plugins inside the
  // harness's own module tree, so `@deepseek-ai/*` resolves against the running
  // release. A Loader row would resolve them through the profile directory,
  // which does not carry the harness packages. See lib/preset.js.
  ctx.inject(['agentPresets'], (presetCtx) => {
    let dispose
    let disposed = false
    const warn = (error) => {
      const message = error instanceof Error ? error.message : String(error)
      presetCtx.logger?.warn?.(`harmony preset: ${message}`)
    }
    try {
      presetCtx.effect(() => () => {
        disposed = true
        const unregister = dispose
        dispose = undefined
        unregister?.()
      })
      // `register` resolves with a disposer once the preset either mounts or its
      // diagnostic settles; a broken preset stays visible in the roster instead
      // of taking this plugin down, so a reload never bricks the harness.
      presetCtx.agentPresets.register(harmonyPreset).then((unregister) => {
        if (disposed) unregister()
        else dispose = unregister
      }).catch(warn)
    } catch (error) {
      warn(error)
    }
  })

  // The hilog panel's data path. The Client half (client.js) is a page module
  // and cannot spawn hdc, so the Host exposes two exact Fetch routes on the
  // authenticated `/api` channel; the panel streams NDJSON from them. Without a
  // `connection` service (a CLI or TUI profile) the panel simply never loads,
  // so the optional injection keeps this bundle usable in those compositions.
  ctx.inject(['connection'], (webCtx) => {
    for (const route of createLogRoutes()) webCtx.connection.fetch.register(route)
  })
}
