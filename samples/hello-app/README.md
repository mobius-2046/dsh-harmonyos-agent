# hello-app

一个最小的 Stage 模型工程，用来演示 dsh-harmony：两个页面文件、一个按钮、一条 `console.info`。

```
samples/hello-app
├── AppScope/app.json5            bundleName: com.example.helloharmony
├── build-profile.json5           API 20，无 signingConfigs（构建出来是 unsigned）
├── hvigorfile.ts / oh-package.json5
└── entry/src/main
    ├── module.json5              EntryAbility 是入口
    ├── ets/pages/Index.ets       标题 + 计数器按钮
    └── resources/base/…         字符串、颜色、图标、页面清单
```

**构建**

```bash
# 在 DSH 里，告诉 harmony 工具工程在哪
harmony build projectDir=<这个目录的绝对路径>
```

第一次构建前需要有 `local.properties`（DevEco 也会自动生成它）：

```properties
sdk.dir=D:/SDK/Openharmony-6.0
```

**装到真机**

构建产物默认是 `entry-default-unsigned.hap`，真机会拒装。两条路：

1. 用 DevEco Studio 的自动签名（Project Structure → Signing Configs → 勾选自动签名），再 `harmony build`；
2. 或者在本插件的设置页填好签名材料，然后 `harmony sign op=sign`，再 `harmony deploy hap=<签名后的路径>`。

**为什么它适合当演示**

- 没有第三方依赖，`harmony build` 10 秒左右出结果；
- 点一下按钮就打印一行 `hello-app: tap N`，正好用来演示 `harmony logs` 按进程过滤；
- 代码全是公开的通用写法，不涉及任何业务。
