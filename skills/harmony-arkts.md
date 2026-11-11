---
name: harmony-arkts
description: ArkTS static-language rules and ArkUI state-management decorators, plus fixes for the compiler errors this ruleset produces.
whenToUse: Writing or reviewing .ets code, or fixing ArkTS type errors such as object literals without a declared type, implicit any, or decorator misuse.
---

# ArkTS 与 ArkUI 规则

ArkTS 不是 TypeScript 的超集，而是一个静态子集：写起来像 TS，编译约束更接近 Java。下面的规则适用于 API 12 及以后；更早版本以上限更宽的 SDK 报错为准。

## 类型系统

- **显式类型**：变量、参数、返回值都要能推导或显式声明。禁止 `any`、`unknown`，禁止省略后落到隐式 any。
- **对象字面量必须有对应类型**：`let p = { x: 1 }` 编译失败，必须先声明 `interface Point { x: number }`，再 `let p: Point = { x: 1 }`。
- **不支持结构化类型（鸭子类型）**：两个字段完全相同的 interface 不能互相赋值，需要显式实现或转换。
- **不支持运行时动态属性**：`obj['dynamicKey'] = v` 不可用；用 `Map`、`Record` 或显式索引签名。
- **禁止** `eval`、`delete`、原型改写、`with`、动态 `import()` 的表达式形式。
- 泛型、`readonly`、可选链、空值合并、`as` 断言都可用。

典型报错与修法：

| 报错 | 修法 |
|---|---|
| `Object literal must correspond to some explicitly declared class or interface` | 先声明 interface / class |
| `Use explicit types instead of "any", "unknown"` | 补类型；确实未知时用具体联合类型 |
| `Property 'x' does not exist on type 'Y'` | 在类里声明该字段并初始化 |
| `Cannot assign to 'x' because it is a read-only property` | 去掉 `readonly` 或在构造时赋值 |
| `Type 'A' is not assignable to type 'B'`（字段一致） | ArkTS 不做结构匹配，改为显式实现接口 |

## 组件与状态

- 组件是 `struct`，必须 `@Component` 修饰并实现 `build()`；入口页面再加 `@Entry`。
- 状态装饰器（V1）：`@State` 组件内可变；`@Prop` 父传子单向；`@Link` 双向；`@Provide` / `@Consume` 跨层；`@Watch` 监听变化；`@Observed` + `@ObjectLink` 观察对象内部字段。
- 状态装饰器（V2）：`@ComponentV2`、`@Local`、`@Param`、`@Event`、`@Once`、`@Monitor`、`@Computed`。V1 与 V2 不能在同一 struct 上混用。
- `@Builder` 定义可复用 UI 片段，`@Styles` 定义通用样式，`@Extend` 扩展内置组件样式。
- 不要在 `build()` 里做副作用（网络、写文件、启动定时器），放到 `aboutToAppear` 或事件回调。

## 常见反模式

- 在 `@State` 里放不可观察的深层对象：只改嵌套字段不会触发刷新，需 `@Observed`/`@ObjectLink`，或整体替换引用。
- 用 `setTimeout` 在组件卸载后改状态：在 `aboutToDisappear` 清理定时器与监听。
- 把数组当队列 `push` 后不刷新：`@State` 数组的 `push` 是可观察的，但嵌套对象内部的数组不是。
- 在 aboutToAppear 里 `await` 后直接改状态而不检查组件是否已销毁。

## 排查顺序

1. 先看第一条编译错误——ArkTS 的后续报错常由第一条类型错误级联产生。
2. 类型问题优先补 interface，而不是加 `as any`（`any` 本身就不允许）。
3. 装饰器不生效时，确认 `@Component` / `@Entry` 是否同时存在，以及状态变量是否声明在 struct 字段位置。
