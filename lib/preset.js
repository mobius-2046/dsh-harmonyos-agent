/**
 * The `harmony` agent preset, registered at runtime through the Host
 * `agentPresets` service instead of a Loader row.
 *
 * Why not a Loader row: an inserted `@deepseek-ai/dsh-agent-preset` row resolves
 * its child plugin names through the profile directory, whose node_modules does
 * not contain the harness's own packages. The registry, by contrast, mounts the
 * children inside its own (app.asar) tree, so the names below resolve against
 * the harness release that is actually running.
 *
 * The three "modes" are native session states, not three agents:
 *   plan  -> @deepseek-ai/dsh-plan-mode (read-only, ends through exit_plan_mode)
 *   goal  -> dsh-goal + dsh-tool-goal + dsh-command-goal (auto continuation rounds)
 *   build -> the default loop (write/edit/pwsh), no special state
 */

const PERSONA = `你是 HarmonyOS NEXT 应用开发专家，负责 ArkTS / ArkUI 工程。

工作规则：
- 动手前先读 build-profile.json5、module.json5、app.json5，确认 compatibleSdkVersion、bundleName、模块类型与签名配置。
- 只使用 compatibleSdkVersion 允许的 API；不确定时先查文档，不要凭印象写接口。
- ArkTS 是静态语言：显式声明类型，不用 any / unknown，对象字面量必须先有对应的 interface 或 class。
- 编译、装机、拉起、抓日志一律走 \`harmony\` 工具（build / run / devices / deploy / logs），不要裸敲 hvigorw、hdc；改完 .ets 优先跑 \`action=run\`，它一次给出编译、安装、启动、崩溃四段结论。
- 构建用 hvigorw，依赖用 ohpm，设备操作用 hdc；命令失败时先读第一条错误再改代码。
- 交付前跑通一次构建；无法构建时说明缺什么（SDK、签名、设备），不要假装成功。

当前会话模式：
- plan：只调研并产出方案，不改文件、不构建、不装包；方案里要写清要改哪些文件、用哪条验证命令，最后通过 exit_plan_mode 提交等待批准。用户用 /build 或批准计划后才动手。
- goal：围绕一个可验收的目标持续推进，完成或受阻时更新目标状态。
  开 goal 前把验收条件写进 objective，模板：「<要做的事>；完成判据：<可观察的结果>；验证方式：<命令或操作>」。
  例：「给设置页加上开关并保存到 preferences；完成判据：真机打开设置页能切换且重启后保持；验证方式：harmony run 成功且日志无崩溃」。
  不要用「优化一下」「完善体验」这类无法验收的措辞；一条 goal 只对应一个可验证的结果。
- build：直接实现，改完即用 \`harmony run\` 构建、装机、看日志验证。`

// PlanModeConfig requires a non-empty `section`; this is the shipped
// standard-preset text, which carries the whole plan-mode contract.
const PLAN_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode be the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

export const harmonyPreset = {
  id: 'harmony',
  name: 'HarmonyOS',
  description: '鸿蒙应用开发：plan / goal / build 三模式，附带 ArkTS、hvigor 与 hdc 技能。',
  order: 20,
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: PERSONA } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },

    // Windows deployment: pwsh available, bash disabled.
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: true },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },

    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },

    // Skills: disk skills + the harmony-* runtime skills registered by the Host half.
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    // goal mode
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

    // plan mode: the plan state must stay isolated in the preset's own realm
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: PLAN_SECTION } },
      ],
    },

    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },

    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [
        // No `.../list-agents` row: that subpath is absent from this package's
        // "exports" map (0.2.2-rc.1 exports only ".", "./src/*", "./package.json",
        // "./locale/*.json"), so the row can never mount and the whole preset
        // fails with "never started". The control plugin registers list_agents.
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true },
        },
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'fork', toolName: 'subagent_fork' },
        },
        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
      ],
    },

    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ],
}
