# dsh-harmony

HarmonyOS（ArkTS / ArkUI）应用开发插件：一个运行时注册的 `harmony` 预设、四份鸿蒙技能、一个构建/部署工具（五个动作），以及 Web 界面里的 hilog 日志面板。

<p align="center">
  <img src="docs/hilog-panel.png" width="900" alt="hilog 日志面板：设备切换、级别筛选、实时跟随">
</p>

## 它提供什么

| 部件 | 内容 |
|---|---|
| 预设 `harmony` | 与 `standard` 等能力的编码 agent，人格换成鸿蒙专家，内置 plan / goal / build 三模式所需组件；运行时注册，不占官方预设位 |
| 命令 | `/build`（退出 plan 直接开工）、`/mode`（看当前 plan / goal 状态） |
| 技能 | `harmony-project`、`harmony-arkts`、`harmony-build-deploy`、`harmony-ohpm` |
| 工具 | `harmony`（`build` / `run` / `devices` / `deploy` / `logs`） |
| 日志面板 | 侧边栏 **hilog** 图标 → 全屏日志页：设备切换、级别筛选、关键字过滤、实时跟随、暂停 / 清空 / 复制 |


三个模式不是三个 agent，而是同一个会话的三种状态：

| 模式 | 进入方式 | 行为 |
|---|---|---|
| plan | `/plan` | 只读调研，产出方案，`exit_plan_mode` 提交审批 |
| goal | `/goal <目标>` | 持久目标 + 自动续跑轮次，GoalBar 显示进度 |
| build | `/plan` 关闭后即默认状态 | 直接改文件并构建验证 |

## 一个工具，五个动作

只注册一个工具 `harmony`，用 `action` 选择动作。这样做是因为每个工具的 schema 每轮都要重发：四个工具（加上当时并存的 DevEco CLI 工具）把工具表撑到 87 个，单是 schema 就占了近一成上下文。

| action | 底层命令 | 返回 |
|---|---|---|
| `build` | `hvigorw assembleHap --mode module -p product=… -p buildMode=…`（`hsp: true` 时再跑 `assembleHsp`） | `ok`、产物 `.hap` 列表、是否已签名、结构化错误（hvigor 错误码 + ArkTS `file:line:column`）、提示、输出尾部 |
| `run` | 上面的 build → `hdc install -r` →（必要时装 HSP）→ `aa start` → `hdc shell hilog` | 编译 / 安装 / 预装 / 启动 / 运行五段结论，崩溃信号单独列出 |
| `devices` | `hdc list targets` | 设备 id 列表 |
| `deploy` | `hdc install -r <hap>`（可选 `aa start`） | 安装结果、是否拉起 Ability |
| `logs` | `hdc shell hilog`（限时窗口） | 过滤后的日志行 |

`run` 的价值在于把四步串成一次调用：模型不必自己 build → 找 hap → 装 → 拉 → 抓日志，平均省 3–4 轮。它还会处理 HSP 拆分工程：entry 的 HAP 直接装会报 `9568305 dependent module does not exist`，工具会扫描 `*/build/*/outputs/**/*-signed.hsp`，逐个装上并重试 entry，直到装成功或用尽轮次。

`build` 默认 `isolateHome: auto`：只要能拿到 pnpm wrapper，就把 hvigor 的缓存切到 `%TEMP%\dsh-harmony-hvigor-home`，用 `HVIGOR_USER_HOME` 而不是 `USERPROFILE`。两个原因都来自实测：


1. **hvigor 的 pnpm 引导在 Windows 上是坏的。** 它先用 `<HVIGOR_USER_HOME>/wrapper/tools/node_modules/.bin/pnpm` 是否存在来判断，不存在就调 `npm.cmd install pnpm`——那是一次无 shell 的 `.cmd` spawn，必然失败，报 `00308002 ... No stdout output`。所以隔离目录必须**预置** wrapper，不能让它自己装。
2. **不能改写 `USERPROFILE`。** 早期版本把 `USERPROFILE`/`HOME` 指向临时目录，副作用是 npm 也找不到 `~/.npmrc`，于是退回默认源。`HVIGOR_USER_HOME` 只影响 hvigor 自己的缓存，npm 仍看到真实 profile。

隔离时会从真实 `~/.hvigor/wrapper/tools`（约 13 MB）复制一次 wrapper，之后构建直接跳过引导；真实 profile 只读不写。若真实 profile 里没有可复制的 wrapper，自动退回真实目录。

**注意**：沙箱下**工程目录本身**也必须可写——hvigor 会写 `<project>/.hvigor` 和 `build/`。所以在 workspace-write 会话里构建工作区之外的工程仍会 `EPERM`，这种组合要么把工程放进工作区，要么让会话使用可写目录。

## hilog 日志面板

侧边栏（Plugins、Automation tasks 之后）出现 **hilog** 图标。布局照 DevEco Studio 的 HiLog 窗口做：上面是「设备 / 进程 / 级别 / 过滤器 / 搜索」筛选条，中间是固定列头，下面是带级别配色的控制台。

- **设备**：`hdc list targets` 的结果，旁边 ⟳ 重新枚举。
- **进程**：`ps -ef` 里跑着的应用进程（`名称 (pid)`），选中即按 pid 过滤；旁边 ⟳ 刷新。默认「全部进程」。
- **级别**：下拉勾选 Debug / Info / Warn / Error / Fatal，默认关掉 Debug；只在浏览器里过滤，不重连。
- **过滤器**：标签（tag / domain）、包含、排除三个条件，等价于 DevEco 的自定义过滤器。
- **搜索**：`Aa` 区分大小写、`.*` 正则、`↑/↓` 上一处/下一处，右侧显示 `第 n/共 m 处`；命中处在消息里高亮，当前那处反色。
- **动作**：暂停 / 继续、滚动到底部、自动换行、标准 / 紧凑视图、保存（导出当前可见日志为 `.log`）、全部清除、字号。
- **字号**：12–32px 可选，默认 **32px**，选择记在 `localStorage` 里；列宽、行高随字号一起缩放，消息列吃掉剩余宽度，默认开自动换行。
- **列头**：时间 / 进程 / 线程 / 级别 / 标签 / 消息；W 与 E/F 行带底色，级别字母按状态色着色。
- **滚动**：默认贴底；手动往上翻会自动取消「滚动到底部」，底部出现回到底部的按钮。

### 数据是怎么走的

浏览器拿不到 `hdc`，所以 `client.js` 只负责界面，数据由 Host 的 `lib/hilog.js` 采集：

| 路由 | 作用 |
|---|---|
| `GET /api/harmony/logs/devices` | 返回 `{ ok, devices: [id] }`，底层是 `hdc list targets` |
| `GET /api/harmony/logs/processes?device=<id>` | 返回 `{ ok, processes: [{ pid, name }] }`，底层是 `hdc shell ps -ef` |
| `GET /api/harmony/logs?device=<id>&prefill=<n>` | 返回 `application/x-ndjson` 流：`start` → 若干 `line` → `end`；出错时夹一条 `error` 帧 |

三条路由都注册在 Host 的 `ctx.connection.fetch` 上，也就是 `/api` 那条带浏览器令牌的通道——只有本机已登录的页面能调用，不是公开 HTTP 端口。

采集本身分两段：先 `hilog -x -z <prefill>`（默认 200 行，最多 500）把设备环形缓冲区的尾部灌进来，面板一打开就有内容；随后 `hilog` 阻塞跟随，逐行解码成 NDJSON 帧推给页面。

- 页面关闭、切面板、暂停、换设备都会 abort 请求；Host 收到 `request.signal` 后 kill 子进程，设备侧 `hilog` 随之结束。
- 每行先按 UTF-8 严格解码，失败再回退 GBK（和 `exec.js` 同一套逻辑），所以中文日志不会变成 `??????`。
- 带前缀的行解析成 `time / level / pid / tid / domain / tag / message`；堆栈等换行续行标记为 `continuation`，前端合并进上一条，日志保持整条可读。
- 前端最多保留 4000 行、最多挂 800 行 DOM；Host 同时最多 4 路日志流，超了返回 429。

## 安装

在 Harness 侧边栏的**插件**页安装并启用，或在 `plugin_manager` 里：

```
install_bundle  target: C:\Users\wuwei\Documents\deepseek-harness\default-workspace\dsh-harmony
```

安装后新建会话，在预设选择器里选 **HarmonyOS**。

从 0.2.x 升级到 0.3.0 时，因为新增了 Host 路由和浏览器半边，装完需要**重启一次** Harness 才能看到 hilog 面板（原因见下面的「改了代码要重启」）。

## 验证

先跑离线自测（不依赖设备，也会加载插件并检查模型实际收到的 schema）：

```powershell
npm test    # scripts/selftest.mjs，19 项离线断言
```

`scripts/selftest.mjs` 覆盖：工具只有一个、`parameters` 是 `object` 且 `required` 是数组、`action` 枚举齐全、hvigor 错误与 ArkTS 位置解析、ohpm / hdc 错误解析、签名判定两态、目标推断（含注释掉的模块）、四份技能文件存在、`engines.dsh` 与版本号；还会用假 ctx 跑一遍 `apply()`，确认 `/build` `/mode` 注册成功、`/build` 真的把 plan 关掉，以及预设是运行时注册而不是 Loader 行（patch 里只剩 `harmony-skills`）。

然后：

1. 新建会话 → 预设选 HarmonyOS。
2. 输入 `/plan 给这个工程加一个设置页` → 应进入 plan 模式，只读探索，最后弹出计划审批。
3. 批准后进入 build，再 `/goal 让设置页在真机上能打开并截图` → GoalBar 出现，agent 跨轮推进。
4. 问一个 ArkTS 报错应触发 `harmony-arkts`；让 agent 构建应该调用 `harmony` 的 `build` 动作而不是裸敲 `hvigorw`。
5. 点侧边栏 **hilog** → 选中设备，页面先出现最近 120 行，随后实时追加；按 E 之外的级别、输入关键字应即时过滤；暂停后行数不再增长，继续后从当前时刻恢复。
6. 预设是否真的挂载成功：看预设卡片有没有红色「加载失败」。仍有的话悬停徽标读逐行原因——那是注册表把 `record.broken` 原样交给客户端的结果。0.6.4 在开发机上实测 roster 为 `standard / ptc / minimal / cordis / harmony`，`harmony` 无 `broken`。

## 界面在哪里

宿主界面里与本包有关的三处：

1. **侧边栏 `hilog` 图标**（日志面板）：点开后是全屏日志页（见页首截图）。顶部从左到右是设备下拉、级别多选（V/D/I/W/E/F）、关键字搜索框；搜索框右侧依次是大小写、正则、排除模式三个开关；再往右是「暂停 / 继续」「清空」「保存到文件」。右上角是字号、自动换行、跳到末尾、上一处 / 下一处匹配。默认先取最近 200 行，随后实时追加（NDJSON 流，不是轮询）。

2. **预设选择器**（新建会话时）：`自定义` 分组下出现 **HarmonyOS**（id `harmony`），描述是「鸿蒙应用开发：plan / goal / build 三模式，附带 ArkTS、hvigor 与 hdc 技能」。如果它旁边有红色「加载失败」徽标，悬停徽标看逐行原因。

   ![预设选择器里的 HarmonyOS 卡片](docs/preset-card.png)

3. **对话框输入区**：`/plan`、`/goal` 是内置命令；本包补了 `/build`（退出 plan 开工）与 `/mode`（看当前模式状态）。plan 模式下输入区上方会出现计划审批条，Goal 激活后出现 GoalBar。

   ![GoalBar：输入区上方的目标状态条](docs/goal-bar.png)

## 实现细节：Windows 上的几个坑

这三条都是从真机跑出来的，不是拍脑袋写的，`harmony-selftest.mjs` 里有对应回归检查。

**1. 带空格的 `.bat` 不能用普通参数数组调。** `hvigorw.bat` 在 `C:\Program Files\...` 下，用 `spawn(cmd, ['/d','/s','/c','"C:\Program Files\...\hvigorw.bat" --version'])` 会让 Node 把内层引号转义成 `\"`，cmd 收到的命令名带反斜杠引号：

```
'\"C:\Program Files\...\hvigorw.bat\"' 不是内部或外部命令
```

正确做法是 `windowsVerbatimArguments: true`，并把整条命令行再包一层引号交给 `/s` 剥掉。

**2. 输出编码不是统一的 UTF-8。** hvigor / cmd 在中文 Windows 上输出 GBK，按 UTF-8 解会得到 `??????`。`exec.js` 保留字节、按行切分后先严格 UTF-8 解码，失败再回退 GBK，所以跨 chunk 的多字节字符也不会被切坏。

**3. 找 DevEco 不能按目录名字典序。** `DevEco Studio602` 会排在 `DevEco Studio 611` 前面（数字大于空格），导致选中 6.0.2 而不是 6.1.1。`locate.js` 改为读每个安装的 `product-info.json` 里的 `version` 再排序，`DEVECO_STUDIO_HOME` 仍然最优先。

**4. 产物搜索不能跳过 `build/`。** `findHaps` 原来把 `build` 当成垃圾目录跳过，结果构建成功后 `artifacts` 是空的。现在会走 `entry/build/default/outputs/default/*.hap`，按 mtime 取最新的（signed 优先）。

**5. hvigor 带 ANSI 颜色。** 即使 stdout 是管道，hvigor 也会输出 SGR 转义；不剥掉的话 `> hvigor ERROR:` 前面会多一段转义符，错误正则匹配不上。`exec.js` 解码后统一剥 ANSI，`parseHvigorOutput` 也做了同样兜底。

**6. 预设只能覆盖已发布的行，不能自己 `insert`。** 一开始 `cordis.patch.yml` 是

```yaml
- insert:
    - id: preset-harmony
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: harmony, plugins: [...] }
```

装完 Loader 里 `include:preset-harmony` 是 active 的，但预设面板显示「加载失败」。原因是 `@deepseek-ai/dsh-agent-preset` 是 `EntryGroup`（`static [EntryGroup.key] = true`），`config.plugins` 会变成子 Loader 条目，而**子条目的包名按声明它的 patch 文件位置解析**。profile 的 `node_modules` 里只有 `@local/*`、`billion-context` 等，没有 `@deepseek-ai/*`，于是每个子插件都 `ERR_MODULE_NOT_FOUND`。

0.4.x 改成覆盖官方那一行（`- id: preset-minimal` 只给 `config`），条目的解析基准仍是 app.asar 内部的 dsh 安装，子插件就能解析——代价是 `minimal` 预设被替换成 harmony。0.6.1 起改用运行时注册（第 8 条），`minimal` 已恢复原样。

**7. 覆盖之后仍然「加载失败」：两条行本身挂不起来。** 悬停徽标能看到逐行原因（`dsh-client-ui-agent-preset` 把它渲染在隐藏的 `.brokenTip` 里），0.4.0 时是：

```
plan-mode (@deepseek-ai/dsh-plan-mode): PlanModeConfig needs a non-empty `section`
tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started
```

- `PlanModeConfig` 要求 `config.section` 非空，官方 `standard.patch.yml` 里这段长文本就是整个 plan 模式的行为契约；自己拼 preset 时漏掉它，预设会在挂载阶段抛错。0.4.1 起原样抄进本包。
- `@deepseek-ai/dsh-tool-subagent-control` 0.2.2-rc.1 的 `exports` 只有 `.`、`./src/*`、`./package.json`、`./locale/*.json`，**没有 `./list-agents` 子路径**；`lib/` 里也只有 `index.js`（`list_agents` 的实现并进了主入口）。所以这条子路径行永远 `never started`，并连带整个预设挂载失败。0.4.1 起删掉该行，`list_agents` 仍由主入口注册。

排查这类问题的通用办法：失败信息只在客户端隐藏浮层里，服务端侧只能看到 `agent preset <id>: <error>` 这条 `logger.warn`；`mountPreset` 会把 `audit.failed.join('\n')` 直接抛成错误，行格式是 `<rowId> (<moduleName>): <detail>`，`never started` 表示条目从未挂载（模块解析失败或子路径不存在），`waiting for <services>` 表示等依赖服务。

**8. 0.6.1 起：预设改为运行时注册，不再占任何官方行。** Loader 行这条路走不通——`insert` 出来的行按 profile 解析，而 profile 的 `node_modules/@deepseek-ai` 只有 33 个包，比子插件的依赖闭包（106 个）少 73 个，包括 `cordis`、`dsh-system-prompt`、`dsh-session`。把这 73 个也加进本包 `dependencies` 会让 profile 顶层出现**第二份 `@deepseek-ai/cordis`**；Cordis 的 Service / EntryGroup 靠包内 symbol 识别，两份副本会让子插件注册的服务对宿主不可见，挂载仍然是坏的（而且是更难查的坏）。

现在的做法：`lib/preset.js` 导出一个普通的 definition 对象，`index.js` 在 `ctx.inject(['agentPresets'])` 里调 `agentPresets.register(harmonyPreset)`，`effect` 卸载时注销。注册表（`@deepseek-ai/dsh-agent-preset-registry`）自己住在 app.asar 树里，`register()` 用它的 `ctx` 作为 `record.context`，`activate()` 再 `extend({ baseUrl: record.context.baseUrl })`，所以 26 个子插件全部按 asar 解析——既不用复制依赖，也不碰 `preset-minimal`。注册失败不会抛，只会写进 `record.broken` 并 `logger.warn`，面板徽标悬停可见。

**9. 光有 `ctx.inject(['agentPresets'], …)` 不够，还要写进 `export const inject`。** 否则整个条目在激活时就抛 `cannot get property "agentPresets" without inject`，插件不会挂上，且只有 `plugin_manager` 的 `diagnostic` 里能看到（面板上表现为技能、工具全没了）。可选服务用 `ctx.inject(deps, cb)` 拿子上下文是对的，但这个 bundle 的预设必须在加载时就注册，所以 `agentPresets` 进了硬依赖列表。

## 改了代码要重启

bundle 通过 `link:` 接入 profile，宿主在启动时 `import` 插件模块并读取一次 `package.json`，所以：

- **改 Host 半边（`index.js`、`lib/*.js`、技能 markdown、`cordis.patch.yml`）**：删装一次（`remove_bundle` + `install_bundle`）会重新执行 `apply()`——0.6.4 用探针实测过；但已经开着的会话，工具面是启动时的快照，看不到新工具，预设列表也要刷新一次才稳。改完重装 + 刷新页面通常就够，改得深（新服务依赖）还是重启一次最省事。
- **改 `package.json` 的 `dsh.client` 或新增 `client.js`**：包元数据在启动时缓存，同样要重启一次；重启后浏览器半边才进入模块图。
- **之后只改 `client.js`**：已在模块图里的插件由 HMR 按 revision 替换，刷新浏览器即可看到（无需再重启 Harness）。

0.3.0 第一次装上（或从 0.2.x 升级）时，Host 路由和 `dsh.client` 都是新增的，所以**装完要重启一次**。面板打开后如果显示「日志服务未加载」，就是宿主还在跑旧代码。

## 已知边界

- **预设是运行时注册的**：`harmony` 只在插件启用期间存在，卸载后从预设列表消失；官方的 `minimal` / `standard` / `ptc` / `cordis` 四行不动（0.6.1 起）。
- **仅 Windows 组合**：`tool-pwsh` 启用、`tool-bash` 关闭（`disabled: true`）。换平台时对调这两行。
- **工具是 Host 级注册**：`harmony-*` 对所有预设可见，不只 harmony 预设。工具名带前缀，不会和内置工具冲突。
- **UI 只加了日志面板**：三档"模式条"仍是内置的 `/plan`、`/goal` 命令和 composer 计划控件；自定义 ModeBar 是 v2。
- **日志面板是只读的**：不解析崩溃栈、不做 grep 导出文件、不记忆上一次的设备；换设备或重启宿主后从「最近的 120 行」重新开始。
- **工具只有五个动作**：没有 `scaffold`、`clean`、`ohpm install` 的专用动作，这些仍可直接用 `pwsh`（`harmony-ohpm` 技能写了等价命令）。
- **签名是硬门槛**：`harmony_deploy` 只负责装包，签名配置缺失时 hvigor 会在构建阶段失败，错误会原样返回。
- **技能正文随包分发**：注册时剥离 frontmatter 作为运行时技能，不依赖 profile 外的文件路径。

## 工具作者注意：`parameters` 必须是 JSON Schema

`ctx.tools.register()` 不会调用 `defineTool`，所以它**不会**把

```js
parameters: { projectDir: { type: 'string' } }   // defineTool 的 DSL，别直接用
```

转换成 JSON Schema；这段会原样发给模型服务，根节点没有 `type: "object"`，于是每次请求都 400：

```
Invalid schema for function 'harmony_build': schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

本包统一用 `objectSchema(properties, required)` 生成：

```js
parameters: objectSchema({
  projectDir: { type: 'string', description: '…' },
})
```

`scripts/selftest.mjs` 会加载插件并断言 `harmony` 的 `parameters` 是对象根、`required` 是字符串数组、`action` 枚举合法，防止这个坑再回来。

## 0.6.1 变更

**预设不再覆盖 `preset-minimal`。** 从 Loader 行改成运行时注册（`agentPresets.register`），官方的 `minimal` / `standard` / `ptc` / `cordis` 全部保持原样。原因是 Loader 行只能按 profile 解析，而 profile 缺 73 个 `@deepseek-ai/*` 依赖；补齐会引入第二份 `cordis`，比原来的问题更难修。详见「实现细节」第 8 条。

**三模式有了显式入口。** 新增两个命令：`/build`（plan 停在半路时直接退出 plan 模式开工，等价于点 composer 的批准，但不用等一轮模型），`/mode`（打印 plan 是否 active / 是否在排队、goal 的 phase 与 objective，并告诉你该用哪个命令切换）。之前 plan 模式的出口只有 `exit_plan_mode` 工具和 GUI 按钮，纯键盘操作没有路径。

**人格里写了三模式的边界。** plan 只读、不改文件、不构建、不装包，产出要写清改哪些文件与验证命令；goal 必须写「完成判据 + 验证方式」，禁止「优化一下」这种没有终点的目标；build 改完就用 `harmony run` 验证，而不是只编译通过就宣布完成。

**依赖归零。** `package.json` 里 26 个 `@deepseek-ai/*` 依赖全部删除（0.6.0 为了在 profile 里解析子插件而加，方案作废）。现在安装只增加本包自己。

## 0.5.0 变更


**一个工具替代四个。** `harmony_build` / `harmony_devices` / `harmony_deploy` / `harmony_logs` 合并为 `harmony`，用 `action` 选择。动机是上下文成本：每个工具的 schema 每轮重发，当时工作区里还并存着 DevEco CLI 与 hdc-bridge 的 24 个工具，整张表 87 个工具、format 后约 136 KB。合并后本包只剩 1 个工具。旧的四个名字不再存在，若有旧会话记录引用它们，会看到 unknown tool。

**新增 `run`。** 一条命令走完 build → 装 entry →（HSP 工程）补装依赖 → `aa start` → 抓 6 秒 hilog，返回编译/安装/预装/启动/运行五段结论。真机实测（`D:\workspace_6\xcommander_7885`，设备 `009181a30445c820`）：编译 79 s、安装成功、`EntryAbility` 拉起成功、无崩溃信号。

**HSP 拆分工程能装了。** 这类工程的 entry HAP 直接装会报 `9568305 dependent module does not exist`，而且设备一次只报一个缺失模块（`common` 之后还有 `ArsenalModel` 之类），单轮安装必然失败。现在的做法：扫出所有 `*-signed.hsp`（跳过 `node_modules`/`oh_modules`/`.git`/`.hvigor`，深度 ≤ 8，上限 40 个），按轮装、每轮重试 entry、用已装集合去重；实测 23 个 HSP 全部装成功、entry 随后装成功。

**签名状态可见。** `build` 现在会读 `build-profile.json5` 的 `signingConfigs`，没配置时在 `hints` 里直接说「只产出了 unsigned，真机装不上，去 DevEco 的 Project Structure → Signing Configs 勾自动签名」，而不是让模型自己从 `entry-default-unsigned.hap` 这个名字猜。

**错误解析更宽。** 除了 hvigor 的 `> hvigor ERROR:` 和 ArkTS 的 `file:line:column`，现在也认 `ohpm ERROR`、`npm ERR!`、`[Fail]`、`error: failed to install`、`device not found`。`hdc install` 的错误码（`9568305`、`9568322`）会原样留在输出里。

**技能：** 新增 `harmony-ohpm`（registry / `.ohpmrc` / 依赖层级 / 6 类失败对照），`harmony-build-deploy` 重写成「先选动作 → 产物位置 → 等价命令 → 签名 → 运行期已知坑 → 日志」，四份技能都补了中文触发词，正文去掉了 README 里已有的长篇解释（技能每轮进上下文，越短越好）。

**工程化：** `package.json` 加 `engines.dsh`（`>=0.2.1-rc.5 <0.3.0-0`，preset 用到的 `planMode`、`goals`、`connection` 服务在这些版本里才有）与 `scripts.test`；新增 `scripts/selftest.mjs`，15 项断言覆盖工具 schema、两条产物解析、签名判定、目标推断、技能文件存在性，`npm test` 直接跑。

## 给后续维护者：三个会咬人的地方

1. **`inferTarget` 不能直接正则搜 `"srcPath"`。** 真实工程的 `build-profile.json5` 里常有注释掉的模块（`// "srcPath": "./DebugEntry"`），正则会选中它，于是 `module.json5` 读不到、`ability` 为空、`run` 静默跳过启动。现在先 `stripComments`，再在 `"modules"` 段里按 `"name" … "srcPath"` 配对并优先 `entry`。改这里务必用真实工程回归，别用脚手架生成的干净工程。
2. **HSP 的安装顺序不是拓扑序。** 设备只报「下一个缺失的模块」，所以要把「装依赖 → 重试 entry」当成循环，而不是一次排序后批量装。
3. **`run` 的日志为空是正常的一种结果。** `hilog` 在缓冲未刷新时可能一行都没有；`run` 会明确说「日志为空」而不是「没有崩溃」，别把两者混为一谈。

## 许可

MIT，见 [LICENSE](./LICENSE)。

