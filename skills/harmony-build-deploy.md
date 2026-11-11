---
name: harmony-build-deploy
description: Decision table for the harmony tool (build / run / devices / deploy / logs / screenshot / app / doctor / ui), the hvigorw and hdc commands behind it, artifact paths, signing, and the runtime pitfalls that produce opaque failures.
whenToUse: Building a HAP, installing to a device or emulator, wiring signing, reading hilog after a failed run, grabbing a screenshot, checking whether the toolchain is healthy, or when a build/install fails with an opaque error. 编译不过、构建失败、装不上、真机签名报错、闪退要看日志、想看真机界面、怀疑环境不对时。
---

# 构建、安装与日志

## 先选动作，别手搓命令

| 场景 | 调用 |
|---|---|
| 环境不对、构建失败原因不明 | `harmony action=doctor` |
| 改完 `.ets`，只想知道能不能编过 | `harmony({ action: "build" })` |
| 编 → 装 → 起 → 抓日志，一次跑通 | `harmony({ action: "run" })` |
| 不确定设备在不在 | `harmony({ action: "devices" })` |
| 已有 HAP，只想安装/拉起 | `harmony({ action: "deploy", hap, bundleName, ability })` |
| 崩溃、闪退、启动失败取证 | `harmony({ action: "logs", bundleName, seconds: 10, filter: "error" })` |
| 想确认界面长什么样 | `harmony({ action: "screenshot" })` → 返回本地 JPEG 路径 |
| 要点界面上的按钮/输入框 | `harmony({ action: "ui", op: "dump" })` 先看文字，再 `op: "tap", text: "登录"` |
| 冷启动复测、清数据、卸载 | `harmony({ action: "app", op: "stop" / "clear" / "uninstall" })` |
| 一次覆盖所有已连接设备 | 上面任一带 `device: "all"` |

`run` 已经包含 build + install + start + logs 四步，并会指出失败在哪一段；**不要再**用 `hdc_shell` / `hdc_install` / `start_app` 手工拼同一套流程，也不要跳过 `run` 直接猜日志。

## 产物位置

```
entry/build/default/outputs/default/entry-default-signed.hap
entry/build/default/outputs/default/entry-default-unsigned.hap
```

多 product / 多 module 时把 `default` 换成对应名字。工具只报**本次**新生成的 HAP，所以失败时看到空 artifacts 是正常的。

## 等价命令（排查工具行为时用）

```bash
hvigorw --version
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
hvigorw clean --no-daemon
hdc list targets
hdc -t <id> install -r <path-to.hap>
hdc -t <id> shell aa start -a EntryAbility -b com.example.app
hdc -t <id> shell hilog
```

Windows 上工程里的 wrapper 是 `hvigorw.bat`，手敲要用 `.\hvigorw.bat` 或 `cmd /c hvigorw`。首次构建需要 `DEVECO_SDK_HOME`（或 `HOS_SDK_HOME`）指向 SDK。

## 签名

真机安装必须签名。`build-profile.json5` 的 `signingConfigs[].material` 需要：

- `.p12` 密钥库与口令
- `.cer` 调试证书
- `.p7b` Profile

由 DevEco Studio 的自动签名生成，或在 AppGallery Connect 手动申请。没有这套配置时构建仍会"成功"，但只产出 `-unsigned.hap`，装真机会被拒。**`bundleName` 必须与 `.p7b` 里的包名一致**，否则报 `install parse profile prop check error`。

## 运行期已知坑

| 现象 | 原因 | 修法 |
|---|---|---|
| `00308002 ... install pnpm ... No stdout output` | hvigor 首次引导 pnpm 时无 shell 地 spawn `npm.cmd`，Windows 上必然失败 | 用默认的 `isolateHome`（auto）：它从真实 `~/.hvigor/wrapper/tools` 复制一份 wrapper 到隔离目录；确认该目录存在 |
| `EPERM` / `operation not permitted` | 沙箱只允许写工作区，而 hvigor 要写 `<project>/.hvigor` 和 `build/` | 工程必须位于可写区域；只读会话里无法构建，别反复重试 |
| 构建"成功"却只有 unsigned | 工程没有可用的 `signingConfigs` | DevEco：Project Structure → Signing Configs → 勾选自动签名，重新构建 |
| `install failed due to grant request permissions failed` | 权限未在 `module.json5` 声明，或签名 profile 不允许 | 声明权限后重签 |
| `9568322 signature verification failed` | 证书与设备不匹配 | 重新生成调试签名 |
| 成功但没有新 HAP | `product` / `module` 参数与实际不符 | 读 `build-profile.json5` 的 products / modules |
| `EBUSY: resource busy or locked, open '.../.hvigor/outputs/build-logs/build.log'` | 另一个 hvigor 正在写同一工程（DevEco Studio 的构建或它的守护进程） | 工具会自动重试一次；仍失败就让用户关掉 DevEco 里的构建（`hvigorw --stop-daemon` 也能清掉注册的守护进程），再重跑 |
| 构建/签名阶段长时间无输出、无退出（`hap-sign-tool` 已起但文件没写大） | 与 DevEco 的并发构建争用（同一工程、同一签名缓存），Windows 上表现为卡死而非报错 | 关掉 DevEco 的构建窗口后重跑；已产生的 1 字节 `*-signed.hsp` 是中断残留，删除后重跑一次完整构建 |

## 日志

侧边栏的 **hilog** 面板是给人看的（设备切换、D/I/W/E/F 级别、关键字、暂停/清空/复制）；`harmony({ action: "logs" })` 是给自己抓一段窗口做判断的。排查崩溃先看 `FATAL` / `JS ERROR` / `jscrash` 的第一条，不要从尾部倒着猜。
