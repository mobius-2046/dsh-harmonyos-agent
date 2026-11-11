# Changelog

只记会影响使用方式的变化。实现细节与踩坑记录在 `README.md`。

## 0.6.5 — 2026-11-10

**预设挂载修好了。** 0.6.1 的运行时注册其实一直被 cordis 拦在激活阶段：`cannot get property "agentPresets" without inject`——只写 `ctx.inject(['agentPresets'], …)` 不给访问权，服务必须进 `export const inject`。修好后 roster 实测为 `standard / ptc / minimal / cordis / harmony`，`harmony` 无 `broken`，`minimal` 仍在。

- 临时探针（写 `apply-probe.log`）已删除。
- `/build`、`/mode` 的命令描述改为中文，与面板语言一致。
- README 更正：删装一次会重新执行 `apply()`；已开着的会话仍看不到新工具（工具面是启动快照）。

## 0.6.4 — 2026-11-10（内部）

加入 `agentPresets` 硬依赖并用探针取证。

## 0.6.3 — 2026-11-10（内部，失败）

漏了 `inject` 声明，条目激活失败（`cannot get property "agentPresets" without inject`），未发布。

## 0.6.2 — 2026-11-10

**并发 hvigor 不再让构建「假装在跑」。** 子进程 stdin 一律关闭（`hvigorw` 的 `install pnpm? [y/N]`、`hap-sign-tool` 的交互输入都会让它挂到超时）；`assembleHsp` 遇到 `EBUSY ... build.log` 自动重试一次；两种情况都会给出明确提示。真机回归时发现 DevEco Studio 同时开着构建会争用同一份 `build.log`。

## 0.6.1 — 2026-11-10

**预设改为运行时注册。** `harmony` 不再占用官方 `preset-minimal` 那一行，四个内置预设在列表里都在。插件启用时注册、卸载时注销；预设面板里仍显示为「自定义」。

- 新增 `lib/preset.js`：预设定义就是一个 JS 对象（20 个插件行），不再是 YAML 片段。
- `cordis.patch.yml` 只剩 `harmony-skills` 一个 Host 行。
- `package.json` 删除 26 个 `@deepseek-ai/*` 依赖（0.6.0 的实验作废）。
- 已知限制：预设随插件启用状态出现/消失；不能像内置预设那样在没有插件的情况下被选。

**`/build` 与 `/mode`。** `/build` 直接退出 plan 模式开始改代码（不必等模型走 `exit_plan_mode`）；`/mode` 打印 plan 的 active/pending、goal 的 phase 与 objective。

**人格补了三模式的边界。** plan 只读；goal 必须写「完成判据 + 验证方式」；build 改完即 `harmony run` 验证。

## 0.6.0 — 2026-11-10（已被 0.6.1 取代）

尝试用独立 Loader 行注册预设，并在本包声明 26 个 `@deepseek-ai/*` 依赖让子插件从本包解析。失败原因：Loader 插入行实际按 profile 解析，而 profile 的依赖闭包缺 73 个包（含 `cordis`），补齐会引入第二份 `cordis`。回退。

## 0.5.0 — 2026-11-10

**四个工具合成一个。** `harmony_build` / `harmony_devices` / `harmony_deploy` / `harmony_logs` → `harmony`，用 `action` 选 `build` / `run` / `devices` / `deploy` / `logs`。旧名字不再存在。

**新增 `run`。** build → 装 entry →（HSP 工程）补装依赖 → `aa start` → 抓 6 秒 hilog，一次返回五段结论。HSP 工程按轮安装、用已装集合去重（设备一次只报一个缺失模块）。

**签名状态可见。** `build` 读 `signingConfigs`，未配置时直接提示「只有 unsigned，真机装不上」。

**错误解析更宽。** 增加 `ohpm ERROR`、`npm ERR!`、`[Fail]`、`error: failed to install`、`device not found / offline`。

**技能。** 新增 `harmony-ohpm`；`harmony-build-deploy` 重写为「先选动作 → 产物位置 → 等价命令 → 签名 → 已知坑 → 日志」；四份技能都补了中文触发词。

**工程化。** `engines.dsh`、`scripts.test`、`scripts/selftest.mjs`（19 项离线断言）。

## 0.4.1 — 2026-11-09

- 补上 `plan-mode` 的 `config.section`（`PlanModeConfig` 要求非空，缺了会让整个预设挂载失败）。
- 删掉 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 这一行——该子路径在 0.2.2-rc.1 的 `exports` 里不存在，永远 `never started`。

## 0.4.0 — 2026-11-09

覆盖官方 `preset-minimal` 行来注册预设（0.6.1 已放弃该方案）。

## 0.3.3 — 2026-11-09

- `HVIGOR_USER_HOME` 隔离：hvigor 在沙箱里引导 pnpm 时不再写真实 `~/.hvigor`，也不再因 Windows 无 shell 地 `spawn(npm.cmd)` 而失败（`00308002`）。默认 `auto`：能从 `~/.hvigor/wrapper/tools` 复制一份 wrapper 才隔离。
- 产物只报本次新生成的文件。

## 0.3.1 — 2026-11-09

- 修 hilog 路由返回裸 `Response` 导致的 HTTP 500（`HostConnectionFetch.fetch` 契约要 `Promise<Response>`）。

## 0.2.2 — 2026-11-09

- 新增 hilog 日志面板与 `/api/harmony/logs`、`/devices`、`/processes` 三条路由。

## 0.2.0 — 2026-11-09

- 新增 `harmony_build` / `harmony_devices` / `harmony_deploy` / `harmony_logs`。

## 0.1.0 — 2026-11-09

- 首个可用版本：`harmony` 预设 + 三份技能。
