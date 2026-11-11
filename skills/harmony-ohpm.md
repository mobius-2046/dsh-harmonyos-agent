---
name: harmony-ohpm
description: ohpm dependency management for HarmonyOS — registry and .ohpmrc configuration, install/lockfile behaviour, module-scoped dependencies and local .har packages, and the fixes for the failures that actually happen.
whenToUse: Adding or upgrading a dependency, a missing @ohos/@kit import, ohpm install failures, lockfile or registry problems, or vendored .har packages. 装依赖、ohpm install 失败、找不到包、registry 或 lockfile 冲突时。
---

# ohpm 依赖

`ohpm` 是鸿蒙的三方包管理器，等价于 npm。依赖写在工程根或模块目录的 `oh-package.json5`；改完必须重新安装，构建不会自动拉包。

## 基本命令

```bash
ohpm install --all                  # 按 oh-package.json5 安装（改过依赖后必跑）
ohpm install <pkg>@<version>        # 新增依赖并写入 oh-package.json5
ohpm uninstall <pkg>
ohpm update <pkg>                   # 升级
ohpm list                           # 已安装依赖树
ohpm info <pkg>                     # 版本与元数据，装之前先查
```

默认 registry 是 `https://ohpm.openharmony.cn/ohpm/`。改配置：

```bash
ohpm config get registry
ohpm config set registry <url>      # 写 ~/.ohpm/.ohpmrc；工程内 .ohpmrc 可覆盖
```

`oh-package-lock.json5` 要入库，它固定了整棵依赖树；**不要手改**，升级用 `ohpm update` 让它自己重算。

## 依赖放在哪一层

- 根 `oh-package.json5`：整个工程的公共依赖与 `devDependencies`（如 `@ohos/hypium`、`@ohos/hvigor-ohos-plugin`）。
- 模块 `entry/oh-package.json5`：只有该模块用的库，别塞到根上——根依赖会进每个模块的编译。
- 本地库：`"mylib": "file:../libs/mylib.har"` 或 `file:./libs/xxx.tgz`；路径相对声明它的 `oh-package.json5`。

## 常见失败

| 现象 | 原因 | 修法 |
|---|---|---|
| `Cannot find module '@ohos/xxx'` 但依赖已声明 | 没执行安装，或 IDE/构建缓存过期 | `ohpm install --all`，再 clean 重建 |
| `404` / `not found` | 包不在当前 registry，或版本不存在 | `ohpm info <pkg>` 确认；核对 API 版本（`@ohos.*` 与 `@kit.*` 的新旧差异） |
| `ETIMEDOUT` / `ECONNRESET` / `socket hang up` | registry 链路不通（企业网、代理） | 换可达镜像或配代理；确认 `~/.ohpm/.ohpmrc` 与工程 `.ohpmrc` 没有互相覆盖 |
| 版本冲突 / peer 不满足 | 多模块各自锁了不同版本 | 收敛到根 `oh-package.json5`，删 lock 后重装 |
| `.har` 装不上 / 解包失败 | 路径写错，或 `.har` 与目标 API 不兼容 | 用绝对路径排查；`.har` 需与 `compatibleSdkVersion` 匹配 |
| 构建报"依赖未解析" | 依赖声明在根，但模块用到了却没在模块级声明（或反之） | 在**使用它的模块**的 `oh-package.json5` 里声明 |

## 纪律

- 装之前先 `ohpm info` 看版本与许可证，别凭印象写版本号。
- 一次只加一个依赖并立刻构建，失败时能确定是谁引入的。
- 三方库进 ArkTS 严格模式前先确认它支持目标 API；不支持的库表现为一堆类型错误，而不是安装错误。
