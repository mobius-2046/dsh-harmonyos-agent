---
name: harmony-project
description: HarmonyOS Stage-model project layout and the configuration files to read before changing ArkTS code.
whenToUse: Working in an existing HarmonyOS project — locating a module, adding a page or ability, declaring permissions, or diagnosing resource and routing errors.
---

# HarmonyOS 工程结构与关键配置

## 动手前先读这 6 个文件

| 文件 | 决定什么 |
|---|---|
| `build-profile.json5`（工程级） | `products`、`signingConfigs`、`compatibleSdkVersion` / `compileSdkVersion`、构建 target |
| `oh-package.json5`（工程级） | 三方依赖、`overrides`、依赖冲突 |
| `AppScope/app.json5` | `bundleName`、`versionCode` / `versionName`、应用名与图标 |
| `entry/src/main/module.json5` | 模块类型、`abilities`、`requestPermissions`、`deviceTypes` |
| `entry/build-profile.json5` | 模块级 `targets`、`runtimeOS`、`buildOption` |
| `entry/src/main/resources/base/profile/main_pages.json` | 页面路由表，未注册的页面无法跳转 |

`compatibleSdkVersion` 是可调用 API 的上界。写业务代码前先确认它，不要使用更高版本才有的接口——这类错误在编译期不会全部暴露，常在真机运行时才崩溃。

## Stage 模型目录约定

```
AppScope/                       应用级资源与 app.json5
entry/
  src/main/
    module.json5                模块声明
    ets/
      entryability/EntryAbility.ets   UIAbility 生命周期
      pages/Index.ets          @Entry 页面
      components/              自定义组件
    resources/base/
      element/                 string.json / color.json / float.json
      media/                   图片
      profile/main_pages.json  路由表
  src/ohosTest/                 单元与 UI 测试
  build-profile.json5
```

## 改代码前的检查清单

- 新增页面：同时在 `main_pages.json` 注册，并在 `module.json5` 的 `abilities` 或路由引用里可达。
- 新增 Ability：必须写进 `module.json5` 的 `abilities`，并补 `src` 入口与 `export default class ... extends UIAbility`。
- 新增权限：`requestPermissions` 里每一项的 `reason` 必须引用 `$string:xxx` 资源，不能写裸字符串。
- 新增资源：名称不能与已有资源重复，否则编译期报 `Duplicate resource`。
- 改动 `oh-package.json5` 后执行 `ohpm install --all`，并确认 `oh-package-lock.json5` 一起提交。

## 常见结构错误

| 现象 | 原因 |
|---|---|
| 页面跳转 404 / 白屏 | 页面未在 `main_pages.json` 注册 |
| 启动后无内容 | `onWindowStageCreate` 未 `loadContent('pages/Index')` |
| 依赖解析失败 | `oh-package.json5` 与 lock 文件不一致，或 `overrides` 版本冲突 |
| 真机安装失败 `install parse profile prop check error` | `bundleName` 与签名 profile 不匹配 |
| 权限申请被拒 | `reason` 未使用 string 资源，或权限未在 `module.json5` 声明 |
