# RES.1 ctx.llm usage 字段探测报告

> 任务：RES.1 `ctx.llm` usage 字段探测｜状态：**✅ 完成**｜2026-09-22
> 结论：**usage 字段存在**。`ctx.llm` 公开 API 是 **`stream(options)`**（**无 `complete`**，任务草案需修正）；
> 每次模型调用以 `type:'usage'` chunk 携带 `TokenUsage`；session 日志的 `assistant/message` 事件 `data.usage`
> 携带同一字段集合。**Token 采集点建议：节点层**（读子代理 session 的 `assistant/message.data.usage`）。

## 一、探测途径（零新增 LLM 消耗）

1. **类型层**：`@deepseek-ai/dsh-llm@0.1.5-rc.2` 的 `lib/types/types.d.ts` + `index.d.ts`
2. **运行时**：扫描隔离环境 `test-env/dsh-home/sessions` 历史 session（zstd 多帧解压）
   中 `assistant/message` 事件的 `data.usage`（111 条真实 LLM 调用记录）

### 探测脚本

- 路径：`test-env/probe-llm-usage.mjs`
- 运行命令：
  ```powershell
  $env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
  node test-env/probe-llm-usage.mjs
  ```

## 二、运行输出

```
目标: D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home\sessions
usage 记录数: 111
事件类型分布: assistant/message=111
usage 字段出现频次: inputTokens=111, outputTokens=111, totalTokens=111, cacheReadTokens=64
--- type=assistant/message
data keys: turn,step,message,usage,stream
usage: {"inputTokens":1958,"outputTokens":122,"totalTokens":4128,"cacheReadTokens":2048}
--- type=assistant/message
data keys: turn,step,message,usage,stream
usage: {"inputTokens":15831,"outputTokens":25872,"totalTokens":51943,"cacheReadTokens":10240}
```

## 三、usage 字段确认表

| 疑似字段 | 是否存在 | 格式 | 说明 |
|---|---|---|---|
| `usage.inputTokens` | ✅（111/111） | `number` | 非缓存输入 token |
| `usage.outputTokens` | ✅（111/111） | `number` | 输出 token |
| `usage.totalTokens` | ✅（111/111） | `number` | 全调用合计（含缓存） |
| `usage.cacheReadTokens` | ✅（64/111） | `number` | 缓存命中（部分请求命中） |
| `usage.cacheWriteTokens` | ✅ 类型存在 | `number?` | 类型可选字段，本批数据未出现 |
| `usage.reasoningTokens` | ✅ 类型存在 | `number?` | 类型可选字段，本批数据未出现 |

## 四、类型层确认（`@deepseek-ai/dsh-llm` 0.1.5-rc.2）

### ctx.llm 服务（LlmRuntime）

- 公开模型调用 API：**`stream(options: GenerateOptions): AsyncIterable<StreamChunk>`**
- **`complete` 方法不存在**——任务草案（`ctx.llm.complete('说"你好"', ...)`）需修正为 `stream`
- 其他：`registerAdapter` / `listProviders` / `prepareCall` / `resolveCallConfig` / `listModels` 等

### TokenUsage（types.d.ts L136）

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

> **语义要点**：计数是**不相交**的——`inputTokens` 仅非缓存输入；缓存输入单列
> `cacheReadTokens`/`cacheWriteTokens`（**计费输入 = 三者之和**）。适配器会把 DeepSeek 的
> `prompt_tokens`（含缓存）拆分后回填。

### StreamChunk（types.d.ts L359）

```ts
type StreamChunk =
  | { type: 'block-start'; ... }
  | { type: 'text-delta'; ... }
  | { type: 'reasoning-delta'; ... }
  | { type: 'tool-call-delta'; ... }
  | { type: 'block-end'; ... }
  | { type: 'usage'; usage: TokenUsage }     // ← 每次调用的 token 计量
  | { type: 'finish'; reason: FinishReason };
```

## 五、Token 采集点建议

| 采集点 | 方式 | 优点 | 缺点 |
|---|---|---|---|
| **节点层（推荐）** | 子代理 run 完成后读其 session 的 `assistant/message.data.usage` | 与节点对应、分账精确、复用现有 session 数据 | 需按 childId 定位 session |
| **LLM 层** | 消费 `ctx.llm.stream()` 的 `usage` chunk | 实时、直接 | 引擎未直接调用 llm（经 subagent），需桥接 |
| **RunLedger 层** | 节点完成事件附带 usage 摘要 | 与审计账本一致 | 依赖上游采集 |

> **MVP-2 结论**：Token 分账在**节点层**采集——子代理 run 结束后，从该 child 的 session 日志
> （`assistant/message` → `data.usage`）读取，写入 RunLedger。字段名与 `dsh-agent-budget`/
> token-ledger 工具口径一致（`inputTokens`/`outputTokens`/`totalTokens`/`cacheReadTokens`）。

## 六、结论

| 项 | 结果 |
|---|---|
| 探测脚本可运行 | ✅ `test-env/probe-llm-usage.mjs` |
| usage 字段是否存在 | ✅ 存在（111 条真实记录） |
| 字段名/格式 | ✅ `TokenUsage`（inputTokens/outputTokens/totalTokens/cacheReadTokens 等） |
| `ctx.llm.complete` | ❌ **不存在**（正确 API 是 `ctx.llm.stream()`） |
| Token 采集点 | 建议节点层（session `data.usage`） |
| 阻塞 MVP-2 状态 | ✅ 解除 |

---
**关联**：`docs/MVP-1.5/process/RES.3-API复测.md`（subagent API）、`tools/token-ledger.mjs`（字段口径一致）
