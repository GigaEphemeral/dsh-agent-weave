# RES.3 跨版本 API 复测报告

> 任务：RES.3 跨版本 API 复测｜状态：**✅ 完成**｜2026-09-22
> 结论：**MVP-1 采信的 `sendMessage` 正确**；评审报告出现的 `followup` / `reportFrom` **均不存在**。
> MVP-2/3 消息总线应使用 `ctx.subagents.sendMessage(sender, targetId, content, options)`。

## 一、版本信息

| 项 | 值 |
|---|---|
| DSH | `0.1.5-rc.2`（`dsh --version` 实测） |
| `@deepseek-ai/dsh-subagent` | `0.1.5-rc.2`（`package.json` 实测） |
| Node | 22.23 |

## 二、API 名确认（运行时探测）

探测方法：`node test-env/probe-subagent-api.mjs`——直接 import 包，检查 `SubagentRuntime.prototype`
的实际方法（**零 LLM 消耗**，非 mock）。

| 疑似 API 名 | 实际存在 | 签名（来自类型定义） |
|---|---|---|
| `start` | ✅ | `start(name: string, request: SubagentStartRequest): Promise<SubagentRun>` |
| `startContinuable` | ✅ | `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>` |
| `followup` | ❌ | —（不存在） |
| `sendMessage` | ✅ | `sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>` |
| `reportFrom` | ❌ | —（不存在） |
| `interrupt` | ✅ | `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void` |
| `listChildren` | ✅ | `listChildren(parentSessionId: SessionId, signal?): Promise<SubagentListEntry[]>` |
| `listDescendants` | ✅ | `listDescendants(rootSessionId: SessionId, signal?): Promise<SubagentDescendantListEntry[]>` |
| `registerProvider` / `getProvider` / `list` | ✅ | 注册表三件套 |
| `prompt` | ✅ | 浏览器侧投递（远程面） |

## 三、类型定义核对（`lib/types/types.d.ts` + `lib/types/index.d.ts`）

### ContinuableStartSpec

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | `string` | 子代理 provider 名 |
| `label` | `string` | 持久化为子代理创建标签 |
| `childId?` | `SessionId` | 调用方预留的 child 身份 |
| `request` | `Omit<SubagentStartRequest, 'label'|'signal'|'outputSchema'>` | 委派请求 |
| `signal` | `AbortSignal` | 取消信号（仅管到 inbox 接受） |

### SubagentProvider

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 注册名（`spawn`/`fork`/`acp`） |
| `capabilities` | `SubagentCapabilities` | 启动期能力标志（agentOptions/outputSchema/depthLimit/toolFilter/persona） |
| `inheritsParentContext` | `boolean` | 描述性标志，非服务校验 |
| `agentRouteDefaults?` | `{ provider: string; model: string }` | **静态路由默认值**（对应 FIX.4 验证对象） |
| `start(request)` | `Promise<SubagentRun>` | 一次性子代理 |
| `prepareContinuable?` | — | **方法存在即能力**：continuable 创建唯一参与点 |

### SubagentStartRequest

`label?` / `prompt: ContentBlock[]` / `parent: Agent` / `signal: AbortSignal` /
`agentOptions?` / `outputSchema?` / `maxDepth?` / `toolFilter?` / `persona?`

> **关键语义**：`maxDepth` 需 `capabilities.depthLimit`；`toolFilter` 需 `capabilities.toolFilter`；
> `persona` 需 `capabilities.persona`；`agentOptions` 需 `capabilities.agentOptions`——**fail loud，无静默降级**
> （与 D-001 包装 provider 契约一致，FIX.5 已验证）。

### SubagentCapabilities

```ts
interface SubagentCapabilities {
  agentOptions: boolean; outputSchema: boolean; depthLimit: boolean;
  toolFilter: boolean; persona: boolean;
}
```

### 事件（Cordis Events）

- `subagent/provider-added(provider)` / `subagent/provider-removed(name)`（emit）
- `subagent/start(info: SubagentRunInfo)` / `subagent/end(info: SubagentRunEndInfo)`（**scoped**：按委托父级分发）
  - 与 MVP-1 门禁 4 的 `subagent/catalog` 观测口径一致（FIX.3 已标注偏离）

## 四、结论

| 结论点 | 内容 |
|---|---|
| **消息总线 API** | MVP-2/3 用 **`ctx.subagents.sendMessage(sender, targetId, content, options)`**（✅ 实测存在） |
| **废弃名称** | `followup`、`reportFrom` 在当前版本**不存在**，消息总线设计不得引用 |
| **续接 API** | `startContinuable(ContinuableStartSpec)` 是唯一续接入口；`prepareContinuable` 方法存在=provider 能力 |
| **interrupt 语义** | `interrupt(targetSessionId, authority)` 是 fire-and-return，需 `SubagentInterruptAuthority`（user/ancestor） |
| **scoped 事件** | `subagent/start|end` 按父级作用域分发——观察者/看板消费时注意作用域过滤 |
| **阻塞 MVP-2 状态** | ✅ 解除——消息总线设计有了确定的 API 名 |

## 五、给 MVP-2 的输入

1. **消息总线**（README §消息总线与防死锁）：`A → 父 → B` 的转发实现用
   `ctx.subagents.sendMessage(parentAgent, targetId, content, { signal })`；`sender` 必须是**精确的 live Agent**。
2. **checkpoint 恢复**：不依赖 settlement notice（§4.6 缺陷 3 已约定），RunLedger 重建状态——
   本复测未发现 `reportFrom` 类"子代理主动上报"API，进一步确认恢复路径只能走 RunLedger。
3. **FIX.4 佐证**：`agentRouteDefaults` 字段存在于 `SubagentProvider` 类型（`Readonly<{provider, model}>`），
   且注释明示「Consumers merge tool/model overrides over these values before preflight」——与 FIX.4 实测一致。
4. **探测脚本保留**：`test-env/probe-subagent-api.mjs` 可复用于未来版本升级时的 API 漂移检测（零 LLM）。

---
**关联**：`docs/MVP-1/process/MVP-1阶段总结与遗留.md`（P3-坑5）、`docs/decisions/D-001-subagent-provider-contract.md`、`docs/MVP-1.5/process/FIX.4-agentRouteDefaults验证.md`
