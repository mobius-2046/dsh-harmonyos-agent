# Changelog

只记会影响使用方式的变化。实现细节与踩坑记录在 `docs/design-notes.md`。

## 未发布（文档）

**README 重写为对外版本。** 按「能干什么 / 提供什么 / 开发思路 / 如何安装 / 如何使用 / 发版记录」六问重排，262 行压到 120 行；原来的 9 个坑、重启规则、schema 陷阱、已知边界与维护者注意事项整体移到 `docs/design-notes.md`，README 只留一行链接。

## 0.11.0 — 2026-11-11

**新增 `file` 动作。** `op=pull` 用 `hdc file recv` 把设备文件拉回本机（默认落到 `%TEMP%\dsh-harmony-files`，返回字节数），`op=send` 把本机文件推到设备；设备路径必须是绝对路径。plan 模式下只有 `pull` 可用，`send` 会被拒绝（它会改设备上的文件）。

验证：把 44 字节的测试文件推到 `/data/local/tmp` 再拉回，内容一致；拉不存在的路径返回 `[Fail]Error opening file` 而不是静默成功。`npm test` 30/30。

## 0.10.1 — 2026-11-11

**`logs` 支持过滤。** `filter` 传子串（大小写不敏感）或 `/regex/flags`，在宿主机上过滤已抓到的行，设备端命令不变；结论里给出「匹配 N 行 / 共 M 行」，一行没匹配时也会说明扫到了多少行，避免把「关键字不对」误读成「没有日志」。

## 0.10.0 — 2026-11-11

**新增 `ui` 动作。** `op=dump` 用 `uitest dumpLayout` 抓控件树，拍平成「类型 + 文字 + 可点 + 坐标」并只保留有文字或可点的节点（原始 JSON 约 20 KB，多数是空布局容器）；`op=tap` 按文字找控件点中心（找不到会提示先 dump）；`op=input` 往当前焦点或指定坐标输入；`op=key` 发 Back/Home/Power；`op=swipe` 滑动。plan 模式下只有 `dump` 可用，其余会被拦。

验证：真机上 dump 出登录页 12 个节点／8 个可点；`tap text="取消"` 从「人员选择」页返回登录页；`key Back` 可用。`npm test` 28/28。

## 0.9.0 — 2026-11-11

**新增 `doctor` 动作。** 一次检查 hdc（版本与来源）、已连接设备、`DEVECO_SDK_HOME`、hvigorw 来源、签名配置、shared 模块是否都有 signed HSP 产物、ohpm、hvigor 隔离 home，每项给出 ✓ / ! / ✗ 与处置建议；只要有一项 ✗ 就 `ok=false`。plan 模式下可用（只读）。

**修正 shared 模块的判定。** 之前按「`"name"` 之后 200 字符内出现 `srcPath`」配对，而每个模块的 `targets[].name` 都是 `default`，导致报出 `缺产物：default` 且真正缺的模块被漏掉；改成按 `srcPath` 所属对象的 `name` 配对，23 个 shared 模块全部对上。

验证：`doctor` 在本机返回「环境检查全部通过」（23 个 shared 模块都有产物）；指向非工程目录时返回 1 项 ✗ 并说明原因。`npm test` 26/26。

## 0.8.0 — 2026-11-11

**`screenshot` 与 `app` 两个动作。** `screenshot` 在设备上 `snapshot_display` 抓图、拉回本地、删掉设备端临时文件，返回路径与分辨率（多设备时每台一张）；`app` 用 `op=start/stop/clear/uninstall` 启停应用、清数据、卸载。两者都支持 `device=all`。plan 模式下 `app` 也被拒绝，`screenshot` 与 `devices`/`logs` 仍可用（只读操作）。

验证：两台设备上 `screenshot` 返回 2340x1080 的 JPEG；`app` 启动 `com.tze.xcommander` 成功。

## 0.7.0 — 2026-11-11

**一次调用可以覆盖多台设备。** `deploy` / `run` / `logs` 的 `device` 接受 `all`（所有已连接设备）或逗号分隔的列表；每台设备的安装、启动、日志各自独立，一台失败不影响其余，结果按设备分块给出。`run` 只编译一次，安装与启动并行。

**plan 模式下工具会拒绝动手。** `build` / `run` / `deploy` 在 plan 激活时直接返回原因（只读、需 `exit_plan_mode` 或 `/build`），不再靠人格提示自觉；`devices` / `logs` 仍可用。

**HSP 依赖按层安装。** 安装共享包时按「依赖已满足的先进」迭代到没有进展为止（最多 8 轮），而不是固定 4 轮——依赖链比 4 层深时旧逻辑会误报安装失败（`nextMap` 依赖 `mapFunction` 就是这种）。

**hilog 面板可以存快照并对比。** 工具栏新增「快照」与「对比」：快照按当前筛选结果存进浏览器本地（最多 6 份）；对比按行出现次数算新增/消失/相同，回答「修完这个错误后，它还会不会出现」。

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
