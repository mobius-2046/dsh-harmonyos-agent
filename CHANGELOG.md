# Changelog

只记会影响使用方式的变化。实现细节与踩坑记录在 `docs/design-notes.md`。

## 0.19.0 — 2026-11-12

**出错时先说人话，再记着你上次用的是哪台设备。**

- 错误码解释：装包、拉起、构建失败时会附上这条码该怎么处理，而不是只丢一行 `code:9568305`。同一个 9568305 有两种含义——「依赖的 HSP 没装」和「设备空间不足」——现在按输出内容区分，给的建议是相反的（前者 `hsp: true` 重建，后者先清空间）。覆盖 9568332 / 9568289 / 9568344 / 9568305×2 / 1300002 / 401 / 202 / 801 / 10002 / 140112。
- 设备记忆：成功后记住那台设备，下一条命令不写 `device` 就落在它上面；设备拔掉了自动回退到仍在线的第一台，不会拿着一个不存在的 id 反复重试。`devices` 会在那一台上标「（上次使用）」。记忆只在当前进程里，重启后回到第一台。
- `ui` 新增 `op=find`：只告诉你「这几个控件匹配、它们的坐标在哪」，不点击。用于「确认界面上有没有这个东西」以及拿坐标后再决定点不点；`op=tap` 仍然保留按文字直接点的快捷路径。

## 0.18.0 — 2026-11-12

**左下的设备徽标终于长成了它该有的样子，并且能直接看到设备状态。** 上一版样式全丢了：样式表原来挂在日志面板的根节点里，而徽标在面板之外——面板没打开过，页面上就只剩一行裸文字。现在客户端加载时把样式一次性挂到 `<head>`，面板和徽标共用一份。

徽标本身重做：32px 图标按钮，右上角绿色胶囊是台数；侧边栏展开时显示「鸿蒙」两个字。点开是一张 320px 的卡片，每台设备两行——机型 + 序列号，下面一排小标签：

- API 版本、电量、充电状态、电池温度
- 内存占用 / 总量、用户分区占用百分比
- 系统版本单独一行

这些字段来自一次 `hdc shell`（`param get` + `/sys/class/power_supply` + `/proc/meminfo` + `df`），两台设备并行约 0.5 秒。`harmony` 的 `devices` 动作也返回同一份数据，不再只有序列号。

## 0.17.1

- 设备徽标样式返工：状态点改为 `data-tone` 属性选择器 + 1px 描边环，宽栏时显示「鸿蒙」文字、状态点变成行内点。
- 展开面板重做成宿主菜单风格：`bg-overlay` 底、圆角 10、阴影、头部标题 + 台数 + 图标刷新按钮，列表行 hover、序列号等宽、「默认」胶囊、「在线」带绿点。
- 空态与错误态分开渲染：没有设备时给「接上设备再点刷新」提示，接口失败时才显示红色错误。

## 0.17.0 — 2026-11-12

**左下角多了一个设备徽标。** 以前要知道「现在连了几台、具体是哪台」，得跑一次 `devices`，或者打开 hilog 面板看下拉框——面板一关就不知道了。现在侧边栏底部常驻一个小图标：绿点表示有设备在线，右下角数字是台数；点开列出每台的序列号，第一台标成「默认」，右上角可以手动刷新。关着时 20 秒刷一次，打开时 5 秒。

## 0.16.0 — 2026-11-11

**`logs` 现在真的只看这个应用。** 之前给 `bundleName` 是拿包名去匹配日志正文——但 hilog 里没有包名字段，应用自己的行写的是进程缩写 tag（`A03d00/JSAPP`），所以这个过滤几乎把应用日志全滤掉了，剩下的反而多是系统噪声。

现在改为用 `ps -ef` 解析 pid，按 hilog 的 pid 列过滤：同一台设备实测 301 行里 25 行属于该应用；`run` 的日志段从「14 行混杂」变成「3 行全是应用自己的」。没有时间戳的续行（栈帧、换行打印的 JSON）跟随上一条记录，避免把栈截断。`pid` 也可以显式传；`appOnly: false` 退回旧的子串匹配。

空结果的措辞也改了：现在会说「进程 21890 有 40 行日志，但没有匹配 /error/i 的」，而不是笼统的「没有日志」。
## 0.15.0 — 2026-11-11

**新增 `deps`：`ohpm install --all`。** 改了 `oh-package.json5` 之后不同步依赖，下一个报错会是 ArkTS 的「找不到模块」，离真正的原因（registry 认证、本地 .har 名字对不上、文件不存在）隔了一层。现在可以直接同步，并把 ohpm 的 WARN 与 ERROR 归到 `deps` 的结论里。

实跑 `D:\workspace_6\xcommander_7885`：2 秒完成，59 条警告（绝大多数是「依赖名与包内实际名字不一致」——能编过，但按真名去 grep 会找不到）。工程路径不对或 ohpm 缺失时返回可读结果而不是抛栈。

## 0.14.0 — 2026-11-11

**`/goal` 有了门槛：没有完成判据的目标不再自动续跑。** 之前 `/goal <目标>` 直接建目标，自动续跑会一轮轮「继续」，因为没有可判定的终点。现在要求写成 `/goal <目标>；完成判据：<可观察的结果>；验证方式：<命令或检查步骤>`，缺任一项直接拒绝并给出模板；`轮次：N` 可选，默认 12、上限 40。`/goal clear` 结束当前目标。

自测覆盖三条路径：只有目标（拒绝，提示补完成判据）、有判据无验证（拒绝）、完整写法（建立目标且轮次被正确解析）。`npm test` 32/32。

顺带修正 README 里过期的能力表（工具动作数、goal 进入方式）。

## 0.13.0 — 2026-11-11

**新增 `crash` 动作。** 读 `/data/log/faultlog/faultlogger` 里最新的一份 `jscrash` / `cppcrash` / `appfreeze` 报告，`bundleName` 可按包名筛选；导出 `parseFaultLog` 提取进程名、`Reason:`、时间戳与栈顶 12 帧。没有匹配时列出最近的几份文件名，而不是只说「没找到」。

实测：设备上 25 份崩溃日志，无筛选时返回最新的 `cppcrash-hilogd-…`（`Reason:Signal:SIGSEGV(SEGV_MAPERR)@0x…`）；按 `com.tze.xcommander` 筛选时如实报告「25 份里没有匹配的」。`npm test` 32/32。

## 0.12.0 — 2026-11-11

**新增 `compile` 动作。** 只跑 ArkTS 类型检查（hvigor 的 `default@CompileArkTS`），不签名、不打包，返回同样的错误定位与警告计数。实测同一工程 46 秒，完整构建 84 秒——改完 .ets 想先看报错时不用等打包。

`module` 不传时自动取入口模块（`inferTarget`），避免「task not found」；plan 模式下拒绝（会写 build 中间产物）。`npm test` 31/31。

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
