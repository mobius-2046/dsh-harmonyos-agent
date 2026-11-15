# 用一句话把鸿蒙应用装到真机上：dsh-harmony

> 写给每天都在「改 ArkTS → 等编译 → 装真机 → 翻 hilog → 再改」这条循环里的鸿蒙开发者。

DevEco Studio 很好用，但它没有解决一件事：**这套循环本身是重复劳动**。改完几行代码，你要切窗口、点构建、等两分钟、点运行、等安装、点开应用、再去日志窗口里筛进程。

`dsh-harmony` 是 DeepSeek Harness 的一个插件，把这些动作收进一个 `harmony` 工具（十五个动作），让你用一句话交代：

```
改完这个登录页的校验，跑一下真机，崩了就把日志里第一条错误给我
```

它做的事：`compile` 先做类型检查（约完整构建一半时间）→ `run` 构建、装包、补 HSP 依赖、拉起 Ability、抓 6 秒日志 → 崩了自动读最新 `jscrash` 并解出栈顶帧。失败时不是甩一段 hvigor 输出，而是一行「接下来做什么」。

## 三个模式，一个会话

不是三个 agent，是同一个会话的三种状态：

- `/plan` —— 只读调研、出方案，**工具层面**拒绝构建与装机。你批准后才动手。
- `/goal 目标；完成判据：…；验证方式：…` —— 跨轮目标 + 自动续跑，输入区上方的 GoalBar 显示进度。缺判据会被拒绝，避免「一轮轮继续」。
- 默认 build —— 直接改文件、构建、装机、验证。

## 真机能做的其他事

| 想干的事 | 动作 |
|---|---|
| 看当前界面长什么样 | `screenshot` |
| 点按钮、输入、翻页 | `ui op=tap/input/swipe` |
| 断言界面对不对（文字、个数、指纹） | `ui op=assert`，多台设备出一张表 |
| 读崩溃日志 | `crash` |
| 查装没装、什么版本 | `app op=query` |
| 拉/推设备文件 | `file` |
| 环境不对 | `doctor`（每个探测限时，会回来） |
| 接口从哪个版本开始有 | `docs op=api`（读本地 SDK 的 `@since`） |

多台设备用 `device="all"`，或按设备分工：

```
matrix: "A机=install;B机=run"
```

编译一次，结果是一张「设备 × 动作 × 结果」的表。

## 装上要多久

Windows、dsh `>=0.2.1-rc.5`、DevEco Studio 6.x、设备连上 `hdc`：

```powershell
dsh plugin --profile desktop add file:<本目录>
```

重启一次 Harness，新建会话选 **HarmonyOS** 预设。第一次用建议先跑 `harmony action=doctor`，它会把 hdc / 设备 / SDK / hvigorw / 签名 / ohpm 逐项标出来。

仓库：<https://github.com/mobius-2046/dsh-harmonyos-agent>（MIT）

## 它不做什么

不做预览器、断点调试、内存与性能分析——那些 DevEco 做得比我好。也不做签名：`hap-sign-tool` 需要明文密码，密码放哪由你决定，我只核对材料与证书。

一句话：**把重复的手工步骤收掉，把判断留给人。**
