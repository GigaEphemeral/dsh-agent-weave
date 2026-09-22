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
## 补充（2026-09-22，契约复核）：workflowEngine 无法按角色选择 provider

复核官方 `dsh-workflow-worker-thread` 实现（0.1.5-rc.2）确认：

| 事实 | 证据 |
|---|---|
| `agent(prompt, opts)` 支持的 options | `SUPPORTED_AGENT_OPTIONS = {label, phase, schema, provider, model}`（runtime.js:20） |
| `opts.provider` 的语义 | 进入 `agentOptions.provider`（LLM 路由覆盖），**不是** `ctx.subagents.start(name)` 的 provider 选择（index.js:493-495） |
| 子代理 provider 选择 | 仅在 `WorkflowStartRequest.subagentProvider`（run 级，默认 `spawn`），一次 run 只有一个 provider（index.js:875） |

**结论**：设计文档 §4.5 的 `workflowEngine.agent(prompt, { provider: 'R1-requirement' })`（用 provider 名选角色）**无法实现**——`provider` 会被当成 LLM 路由，导致 spawn 到不存在的模型路由。

**修正后的 MVP-1 单链方案（P1.2.1）**：
1. **角色注册**：每个角色编译为 `SubagentProvider`（包装 spawn，`name=角色ID`，`start()` 内注入 persona/toolFilter/agentOptions 后委托 `startInProcessRun`），注册到 `ctx.subagents`。
2. **单链执行**：不依赖 workflowEngine 的 `agent()` 按角色切 provider；改为自写编排脚本，按序调用 `ctx.subagents.start(角色ID, request)` 完成 R1→R8 串行（Q1-Q3 验证路径不变）。
3. **门禁 4（chat 可见 workflow 节点）**：单独用 workflowEngine 跑一个 provider=`spawn` 的 demo run，验证 `workflow/*` 事件在 chat 可见（证明 workflowEngine 集成可用，角色经注册表供其消费）。

## 撤销条件

官方 workflowEngine 若新增 per-call 子代理 provider 选择，可回归文档 §4.5 的原始写法。

---
**关联**：`docs/MVP-1/0-设计.md` §3.2/§4.2/§4.5、`docs/001-开发契约.md` §5.2、`docs/env-verification.md` §二
