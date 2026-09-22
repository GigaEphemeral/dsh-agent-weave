# 决策记录：SubagentProvider 契约偏差修正（D-001）

> 日期：2026-09-22 ｜ 阶段：MVP-1 P1.1.3 ｜ 决策人：R6 Developer + R4 契约核查

## 问题

设计文档（`0-设计.md` §4.2 / `001-开发契约.md` §5.2）中的 `SubagentProvider` 形状：

```typescript
interface SubagentProvider {
  name: string;
  capabilities: {
    persona: string;          // ❌ 文档：值
    toolFilter: string[];     // ❌ 文档：值
    agentOptions: {...};      // ❌ 文档：值
    outputSchema?: unknown;
    depthLimit?: number;
  };
  inheritsParentContext: boolean;
}
```

官方 `@deepseek-ai/dsh-subagent@0.1.5-rc.2`（实测）真实契约：

```typescript
interface SubagentProvider {
  readonly name: string;                              // 传输层注册名（spawn/fork/acp）
  readonly capabilities: SubagentCapabilities;        // 布尔能力标志
  readonly inheritsParentContext: boolean;            // 描述性，非服务校验
  readonly agentRouteDefaults?: { provider, model };  // 可选静态路由默认
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;  // 必需方法
  prepareContinuable?(request): Promise<ContinuableCreateSpec>;        // 可选
}
```

`persona` / `toolFilter` / `agentOptions` / `maxDepth` 属于 **`SubagentStartRequest`**（每次 start 时由调用方传入），不是 provider 静态字段。

## 选项

| 选项 | 描述 | 缺点 |
|---|---|---|
| A. 按官方契约修正（选） | RoleDefinition 仍为 YAML 数据；编译产物改为「角色启动参数工厂」，每次 start 时生成 SubagentStartRequest 的 persona/toolFilter/agentOptions 部分 | 与文档接口形状不同，需同步更新设计文档 |
| B. 包装 provider | 每个角色注册一个 SubagentProvider（start() 内注入角色字段后委托 spawn） | 复杂度高，且 workflowEngine 的 agent() 只支持 prompt/schema/provider/model，无法传 persona/toolFilter |
| C. 坚持文档形状 | 与运行时类型不符，tsc 直接报错 | 不可行 |

## 结论（选 A）

- `SubagentProvider` 类型直接从官方包导入（`import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'`），**不自定义同名类型**，避免与运行时身份分裂。
- `compileRoleToProvider(role, options)` 输出调整为 `RoleProfile`（含 `name` / `persona` / `toolFilter` / `agentOptions` / `inheritsParentContext`），供 workflowEngine 脚本在 `agent(prompt, { provider })` 前通过 provider 名查找并组装请求。
- 角色 YAML → RoleProfile 的映射保留文档 §3.2 的字段映射表（id→name、persona←skill 内容、tools→toolFilter、model→agentOptions、memory_scope→inheritsParentContext）。

## 撤销条件

官方 DSH 若提供「角色级 provider」的一等抽象（如 `dsh-plugin-product-subagents` 适配），可重新评估是否改走包装 provider 路线。

---
**关联**：`docs/MVP-1/0-设计.md` §3.2/§4.2、`docs/001-开发契约.md` §5.2、`docs/env-verification.md` §二
