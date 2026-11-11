# 设计笔记（给维护者）

README 讲怎么用，这份讲为什么这么写、哪里会咬人。每条都来自真机或真实宿主的实测，`scripts/selftest.mjs` 里有对应回归检查。

## Windows 上的 9 个坑

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

## 工具 schema 必须是 JSON Schema

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

## 改了代码何时要重启

bundle 通过 `link:` 接入 profile，宿主在启动时 `import` 插件模块并读取一次 `package.json`，所以：

- **改 Host 半边（`index.js`、`lib/*.js`、技能 markdown、`cordis.patch.yml`）**：删装一次（`remove_bundle` + `install_bundle`）会重新执行 `apply()`——0.6.4 用探针实测过；但已经开着的会话，工具面是启动时的快照，看不到新工具，预设列表也要刷新一次才稳。改完重装 + 刷新页面通常就够，改得深（新服务依赖）还是重启一次最省事。
- **改 `package.json` 的 `dsh.client` 或新增 `client.js`**：包元数据在启动时缓存，同样要重启一次；重启后浏览器半边才进入模块图。
- **之后只改 `client.js`**：已在模块图里的插件由 HMR 按 revision 替换，刷新浏览器即可看到（无需再重启 Harness）。

0.3.0 第一次装上（或从 0.2.x 升级）时，Host 路由和 `dsh.client` 都是新增的，所以**装完要重启一次**。面板打开后如果显示「日志服务未加载」，就是宿主还在跑旧代码。

## 已知边界

- **预设是运行时注册的**：`harmony` 只在插件启用期间存在，卸载后从预设列表消失；官方的 `minimal` / `standard` / `ptc` / `cordis` 四行不动（0.6.1 起）。
- **仅 Windows 组合**：`tool-pwsh` 启用、`tool-bash` 关闭（`disabled: true`）。换平台时对调这两行。
- **工具是 Host 级注册**：`harmony` 对所有预设可见，不只 harmony 预设。工具名带前缀，不会和内置工具冲突。
- **UI 只加了日志面板**：三档"模式条"仍是内置的 `/plan`、`/goal` 命令和 composer 计划控件；自定义 ModeBar 是 v2。
- **日志面板是只读的**：不解析崩溃栈、不做 grep 导出文件、不记忆上一次的设备；换设备或重启宿主后从「最近的 120 行」重新开始。
- **工具只有五个动作**：没有 `scaffold`、`clean`、`ohpm install` 的专用动作，这些仍可直接用 `pwsh`（`harmony-ohpm` 技能写了等价命令）。
- **签名是硬门槛**：`deploy` 只负责装包，签名配置缺失时 hvigor 会在构建阶段失败，错误会原样返回。
- **技能正文随包分发**：注册时剥离 frontmatter 作为运行时技能，不依赖 profile 外的文件路径。

## 三个会咬人的地方

1. **`inferTarget` 不能直接正则搜 `"srcPath"`。** 真实工程的 `build-profile.json5` 里常有注释掉的模块（`// "srcPath": "./DebugEntry"`），正则会选中它，于是 `module.json5` 读不到、`ability` 为空、`run` 静默跳过启动。现在先 `stripComments`，再在 `"modules"` 段里按 `"name" … "srcPath"` 配对并优先 `entry`。改这里务必用真实工程回归，别用脚手架生成的干净工程。
2. **HSP 的安装顺序不是拓扑序。** 设备只报「下一个缺失的模块」（`common` 之后还有 `ArsenalModel` 之类），所以要把「装依赖 → 重试 entry」当成循环，而不是一次排序后批量装。实测 23 个 HSP 需要多轮才装完。
3. **`run` 的日志为空是正常的一种结果。** `hilog` 在缓冲未刷新时可能一行都没有；`run` 会明确说「日志为空」而不是「没有崩溃」，别把两者混为一谈。
