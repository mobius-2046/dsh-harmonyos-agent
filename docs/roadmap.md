# 路线图

目标：**让 `harmony` 工具覆盖 DevEco Studio 里那些「必须开 IDE 才能做的事」**，并且每一步都能在没有 IDE 的情况下完成、验证。

原则：只加能减少一次往返、或减少一次误判的东西。不为动作数量堆功能。一个版本一个可验证的行为变化。

节奏：**工作日白天只做计划，实施放在 18:00 之后或周末**（见 `AGENTS.md`）。白天写进本文件的条目要带「问题 / 验收方式 / 改动面」，晚上按条目实施；插件装在用户正在工作的会话里，白天装/卸会打断他。

## 进行中 / 下一步

### 1. 并发构建防护（0.24.0 已交付本工具自身的锁）
DevEco 开着构建时，hvigor 抢同一份 `.hvigor/outputs/build-logs/build.log`，报 `EBUSY`，随后是一串误导性的 `getName` 报错，错误冒到签名阶段才显现。自己发两个构建（`build` 与 `run` 并行）也会互相踩。
已做：`<工程>/.hvigor/dsh-harmony.build.lock` 抢锁，第二个构建立即返回持有者与已持有时长；pid 已退出或超过 30 分钟视为残留并接管；`finally` 释放。
未做：与 DevEco 的构建协调只能靠 EBUSY 探测（自动重试一次 + 提示），没有跨进程协议可用。

### 2. `run` 的失败归因（0.25.0 已交付）
现在失败会给四段结论，但「下一步怎么办」要模型自己推。
已做：`lib/attribute.js` 按首错分六类（编译 / 签名 / 缺 HSP / 无设备 / 启动 / 崩溃），末尾一行给命令；判不出来时建议 `doctor`。
未做：把归因结果反过来驱动自动修复（例如判成「缺 HSP」就直接重跑 `hsp: true`），那属于 `doctor --fix` 的范畴。

### 3. `doctor --fix`（0.26.0 已交付）
已做：`fix: true` 时修三类验得出的问题——残留构建锁（`acquireBuildLock` 探测，死 pid 才接管，活进程写「未动」）、缺 pnpm wrapper（`prepareHvigorHome()` 从真实 `~/.hvigor` 补种）、shared 模块缺 signed HSP（补跑 `assembleHsp` 后重新比对产物）。修完重算 ✓ / ! / ✗，修了什么单独列「已修：」并进 `data.repairs`。
未做：`run` 的归因结果反向驱动自动修复（判成「缺 HSP」就自动 `hsp: true` 重跑）——那要先把归因准确率做实。

### 4. `sign` 动作（0.22.0 诊断；2026-11-16 定调：不做凭证库）
0.22.0 已交付诊断：读 `signingConfigs`、核对三个材料、解析证书有效期、校验 `.p7b` 的 bundleName 是否就是这个工程。

**定调（用户 m07209 / m07216）**：不在 DSH 里存签名密码，也不按工程存一份。依据是事实而不是偏好——`build-profile.json5` 里 DevEco 写的是本机加密串：

```
"keyPassword": "0000001BDD99704D6DD45EA682FCCDCD1C1C7E9414D33AA5633A2DA004BE086E2D13CA6DAD23023076BA9E"
```

而 `hvigorw assembleHap` 用它**签出来了**（`entry-default-signed.hap`，本工程 11-15 构建产物，装到两台真机并启动成功）。即：签名是工程配置的一部分，`hvigor` 自己就能完成，DSH 既不需要知道密码，也不需要保管它。

因此 0.32.x 里那套东西已全部移除（**0.33.0 已交付**）：`lib/signroutes.js`、`client.js` 的 `SignSection` 与 `signNav` 等键、`lib/settings.js` 的 `signCredentials()`、两个 `DSH_HARMONY_*_PASSWORD` 环境变量、`lib/signing.js` 的 `signApp()`（唯一把密码放到命令行上的路径）。验收方式是断言而不是印象：`npm test` 里有一条检查会扫 `lib/`、`index.js`、`client.js`，确认没有 `keystorePwd` / `keyPwd` / `signCredentials` / `DSH_HARMONY_KEYSTORE_PASSWORD`。

`sign` 保留三个 op：
- `report`：材料是否齐、证书还剩多少天、`p7b` 的 bundleName 是否匹配、有没有 DevEco 加密串。
- `verify`：`hap-sign-tool verify-app`，不需要密码。
- `rebuild`：跑一次构建让 `hvigor` 重新签名（等价于 `build`，但在签名语义下调用）。

自定义证书（不想用 DevEco 自动签名那份）的正确入口是 DevEco 的签名界面：配一次、写进工程、可以进版本管理。DSH 不复制这套存储，也就不会出现「A 工程用了 B 的钥匙」。

验收：`sign op=report` 给出到期天数与 profile 匹配结论；`sign op=rebuild` 产出新 signed HAP 且 `verify` 通过；全仓 grep 不到任何密码字段。

## 中期

### 5. hilog 面板可用性（0.28.0 已交付命名/导出/单条删除）
已做：快照可改名（回车保存，名字随快照存浏览器本地，旧快照无名仍按时间显示）、导出 `.log`（文件名 = 名字或时间 + 设备）、单条删除（对比下拉在选择项消失时清空）。
已做（0.47.0）：对比前按级别（全部/仅错误/错误+警告）与关键字过滤两份快照；快照上限 6 → 12，并加 1.5 MB 字节预算（localStorage 约 5 MB/源，还被别的键共用）。

### 6. `ui` 的等待与断言（0.23.0 等待、0.27.0 断言、0.31.0 跨设备）
已做：`op=wait`（出现/消失 + 超时如实报）、`op=assert`（文字/个数/界面指纹三类期望，空期望算失败）、`op=dump` 返回 `data.fingerprint`（节点集合排序后取 sha1 前 16 位，遍历顺序不影响）；`device=all` 时同一期望逐台跑，结果为「N/M 台符合预期」+ 每台一行，失败行点名是哪条期望、实际多少。
已做（0.46.0）：同一用例在不同机型上跑**不同**断言 —— `ui op=assert matrix="id=登录;id=设置"`，每台只看自己那句，结果仍是每台一行的表。

### 7. 设备矩阵（0.30.0 已交付）
已做：`run` 的 `matrix` 按设备分配动作（`"id=run;id=install;id=uninstall"`）；编译一次、按设备并行，结果是一张设备 × 动作的表；写法错在编译前返回，未连接的 id 直接列出当前在线设备。
已做（0.46.0）：把 `ui assert` 的期望按设备写进 matrix（见第 6 项）。

## 构建速度（2026-11-18）

- 已交付 0.39.1：默认共用 `~/.hvigor`，只有不可写才隔离。实测 `build module=entry` 77s（共用）/ 87s（隔离）/ 127s（隔离+冷启动）、`compile` 45s。
- 还可做：`hsp:true` 的全量 HSP 重建（4 分半）改成只在 shared 模块变更时触发；把 `assembleHap` 的模块范围收窄。

## 减少打开 DevEco 的次数（用户 2026-11-16 提出，按此顺序做）

用户仍会为四件事打开 DevEco：看 log、看代码、性能分析、查看手机文件与数据库。除性能分析的图形部分外，其余都能收窄。

### 8. 日志回到对话（优先，0.34.0 已交付）
- 现状：`logs` 贴末 200 行原文，面板与对话分离，眼睛来回跳。
- 做：`captureLogs` 输出**摘要**——新出现的行、错误与警告、重复行折叠（`×N`）、时间范围、进程；原文只在 `full: true` 时给。面板筛选结果加一个「复制摘要」按钮，压成十几行粘进对话。
- 验收：一次 5 秒抓取在 12 行内说清「有没有新错误」；`full: true` 才回落到原文。

### 9. 手机文件浏览 ✅ 0.35.0
- `file` 已有 `pull`/`send`；补 `op=ls` / `op=cat` / `op=du`（走 `hdc shell`，只读，plan 模式放行）。
- 验收：`ls /data/local/tmp`、`cat` 一个小文本、`du -sh` 一个目录都能出结果；不存在的路径给出 `[Fail]` 原文而不是「没有可用设备」这类误导。

### 10. 数据库查询 ✅ 0.36.0（先验可达性）
- 目标：`db tables | schema | query`，pull 出 RDB 后用宿主自带 Python 的 `sqlite3` 只读打开。
- 前置：`hdc shell run-as <bundle>` 或 root 能否读到 `/data/app/el2/100/database/<bundle>/…`。今晚先在你机器上验一次；不通就降级为「列出数据库文件并 pull 回来」。
- 安全：`file:...?mode=ro` 只读打开；只允许 `SELECT` / `PRAGMA`，其余直接拒绝。

### 11. 代码导航页（只读）✅ 0.38.0
- 一条命令生成静态 HTML：文件树、ArkTS 符号索引、点开看原文，纯静态零依赖，浏览器打开。
- 不做：编辑、跳转定义、重构——那是 IDE 的活，做一半更难用。

### 12. trace 采集（分析交回 IDE）✅ 0.37.0
- `trace start|stop|pull` 走 `hitrace` / `hiprofiler_cmd`，输出录制时长、进程、文件路径与摘要指标。
- 明确不做火焰图与帧分析；文件交给 DevEco Profiler 看。

## hdc 服务泄漏（用户 2026-11-18 报告，0.40.0 已交付）

现场（2026-11-18 14:20 实测）：

- `hdc.exe` PID 31604，命令行 `dummy -l 3 -s ::ffff:127.0.0.1:8710 -m` —— 这是 **server**，一个用户一个，DevEco 与本插件共用。
- 138 线程、444 句柄（用户 11-18 早上看到的是 417，还在长）、工作集 123 MB、虚拟内存 5.46 GB、私有 1.34 GB。
- 已运行 46.4 小时（11-16 15:53 起）、累计 CPU 7.8 小时、当时 5 秒采样 0.84 秒 CPU → **0.17 个核持续空转**。
- 用户补充历史：10-29 系统资源耗尽记录里 `hdc.exe` 占 34,680,074,240 字节（32 GB 虚拟内存），同一类累积。

判断：线程数几乎不变、句柄与内存持续增长 → 每连接资源不回收；0.17 核稳定 → 对死 socket 的重试循环。属华为服务端问题，插件无法修复，只能减少触发与尽早发现。

计划（0.40.0）：

1. 徽标轮询降频降载：轮询只取 id（单次 `hdc list targets`）；机型/电量/内存只在浮层展开时取，并缓存 15 秒。目标：收起 1 次/60 秒、展开 1 次/5 秒（现在每 tick 是「1 次 list + 每台 1 次 14 参数 shell」）。
2. `doctor` 加「hdc 服务健康」行：PID、运行时长、线程数、句柄数、虚拟内存、1 秒 CPU 增量；线程 >120 / VM >4 GB / CPU >5% 单核时给 warn 并说明重启办法。
3. `doctor fix=true` 里做回收：`hdc kill` → 下条命令自动拉起服务，文案说明「DevEco 的设备连接会闪断约 2 秒」。

实测（2026-11-19，一台设备在线，每秒一次、连续 20 秒）：

- 旧行为（每个 tick 取详情）：419 ms/次，hdc 服务的 CPU 从 0.134 核涨到 0.209 核；
- 新行为（只取 id）：107 ms/次，同一时段 CPU 从 0.104 核降到 0.029 核；
- 详情命中 15 秒缓存时 101 ms/次，与只取 id 基本持平——贵的是那次 shell 探测，不是轮询本身。

结论：徽标轮询不是大头，真正贵的是每 tick 一次 `hdc shell`（每台设备一次、14 个参数）。0.40.0/0.40.1 已交付上述三条。
4. 验收：回收前后对比 `doctor` 输出；徽标展开 1 分钟后 `hdc.exe` 的 CPU 增量应明显下降。

## 待定

- ~~**`scaffold`（新建工程）**~~：**不做（用户 2026-11-16 定）**。理由不是「暂时没空」，而是职责错位——建工程的本质是「模板 + API 版本 + 签名 + 设备」四件事的绑定，其中模板、签名、设备都属于 IDE；DSH 造出来的工程在签好名之前装不上，最后仍要回 DevEco 点一次自动签名，等于交付一个半成品。DSH 的价值在「已有工程上把改代码 → 编译 → 装机 → 看日志 → 验界面跑通」。
  若将来仍想要「一句话建工程」，正确的做法是薄封装官方 `devecocli`（`hms_*` 通道），而不是自制模板树——那条通道本机是否可用尚未验证。
- ~~**演示 GIF**~~：**不做（用户 2026-11-16 定，m07250）**。理由：唯一能公开的示例是 `samples/hello-app`（点一下数字变 1），录出来体现不了这个工具的价值；真实工程的画面涉内部产品，不能进公开仓库；GIF 还会随 UI 改动过期、永久占仓库体积。
  替代做法（做一次就够）：README 里贴一段 `harmony run` 的**真实输出**——编译耗时、装到哪台、启动结果、日志里出现什么，一条不美化；「想验证自己的机器能不能编」指向 `samples/hello-app`（10 秒出 unsigned HAP）。
- **CI**：hvigor 构建依赖本地 DevEco SDK，托管机器上没有；只能跑纯逻辑自测（现有 33 项里约一半可脱离真机）。

## 已交付

0.7.0 多设备 / plan 守卫 / HSP 分层预装 / 日志快照对比 → 0.8.0 截图与应用生命周期 → 0.9.0 `doctor` → 0.10.x `ui` 与日志过滤 → 0.11.0 文件传输 → 0.12.0 `compile` → 0.13.0 `crash` → 0.14.0 `/goal` 门槛 → 0.15.0 `deps` → 0.16.0 日志按 pid 收敛。

## 借鉴 dsh-hdc-bridge（0.10.3）的想法

读了它的源码（`lib/host.js` 2893 行、`lib/async-budget.mjs`、`knowledge/` 1.7 MB 官方摘录）之后，值得拿的四件事：

1. **探测预算**（`async-budget.mjs`）：一组互相独立的探测各自限时、共享总预算，超时与"来不及开始"分开报告。它的注释写得很实在——在没有边界时，一次卡住的 hdc 探测会把整个 `doctor` 拖过外层超时。我们的 `doctor` 9 项是顺序跑的，同样有这个风险。
2. **`hdc_ui_find`**：只查控件不点击，返回 bounds 与中心点。我们的 `ui tap` 内部有 `findUiNode`，但没有"只找"的动作——先查清楚再决定点不点，比"点了才发现找错"便宜。
3. **版本化 API 查询**（`hms_api`）：从本地 SDK 的 `.d.ts` 按 `@since` 分类回答"这个接口从哪个 API 版本才有"。我们目前只能靠模型记忆，答错方向会很隐蔽。
   （✅ 0.41.0：`docs op=api` 查单个符号，`docs op=compat` 查整个工程的导入是否超过 `compileSdkVersion`。）
4. **自身诊断**（`hdc_diag`）：专门回答"这个工具自己为什么没找到 hdc"。我们的 `doctor` 诊断工程，不诊断工具。

另外两个次要的：**记住上次用的设备**（对方有 `preferred` 概念，我们总是取第一台），以及 **`switch_cwd`**（显式设工作目录，少传 `projectDir`；但要先评估与 DSH 会话工作目录的关系，避免两套概念打架）。

**不借鉴**：工具粒度。对方 12 个 `hdc_*` 工具，我们刻意合成一个 `harmony`——每个 schema 每轮都要重发，二十来个工具大约吃掉一成上下文。他们用技能和分阶段工具面来补偿，我们选择让模型少背一点。

## 界面：把 hilog 面板挪到右侧栏（用户 2026-11-24 提出，未排期）

**问题**：日志面板现在挂在 `main`（按侧栏条目 id 选中的中央面板），和 `conversation` 互斥——看图要整屏切走，看完再切回来。用户要的是「中间对话、右边日志」同屏。

**已核实的事实**（`cordis_inspect_query` client / `Slots.listSubTree` 全量拓扑 + `Service.listService`）：

- 右侧栏存在：`rightbar`（single, root）→ `rightbar.session`（single, session）→ `sidebar.right.pane.tab`（keyed，按 `tab.kind` 的类型 id 分发内容）；同族还有 `sidebar.right.pane.tab.title`、`sidebar.right.tab.menu.item`、`sidebar.right.tab.document*`（文件预览那套）。
- `layout` 服务可编程控制：`openRightbar(track: boolean, fullscreen: boolean)`、`closeRightbar()`、`selectPanel()`、`toggleSidebar()`。`track: true` 表示「中间列给右栏让出空间」，而不是浮在内容之上。
- 但客户端服务面里**没有**「注册右侧标签类型」的公开入口；现有标签（document / guide）看起来是宿主自己声明的。

**两条路**：

- A（正路）：读 asar 内 `dsh-client-ui-sidebar` 的源码，确认标签是否可扩展。可扩展则注册 `sidebar.right.pane.tab` 的 key，再用 `layout.openRightbar(true, false)` 打开。
- B（兜底）：在 `shell.overlay` 里画固定定位的右栏（自带标题栏与收起按钮），同时 `layout.openRightbar(true, false)` 让中间列让位——视觉上等价，代价是标签样式与宿主不完全一致。

**验收**：对话在中间、日志在右侧同屏；关掉右栏对话恢复原宽；切换设备与轮询不打断正在输入的消息。

**改动面**：`client.js`（把 `LogsPage` 的内容抽成可复用组件，右栏与 `main` 两个入口共用）、`cordis.patch.yml` 是否需要新槽位权限（注册时校验）、`package.json` 版本、README 界面一节、自测加「右侧栏注册存在」的源码断言。`main.harmony-logs` 保留，作为全屏看日志的入口。
