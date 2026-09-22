# RES.5 subagent 并发上限实测报告

> 任务：RES.5 subagent 并发上限实测｜状态：**✅ 完成**｜2026-09-22
> 结论：**dsh-subagent 0.1.5-rc.2 无内置并发闸**（仅 `maxDepth` 深度限制，默认 3）；
> 广度爆炸风险确认，MVP-2 需引擎层自建**全局并发闸**（多层防护见 §四）。

## 一、实测脚本

- 路径：`test-env/probe-concurrency.mjs`
- 运行命令：`node test-env/probe-concurrency.mjs [N=32]`
- 说明：真实 spawn 56 个 LLM 子代理成本极高（MVP-1 实测 21.2 万 token 已证明广度爆炸），
  本脚本采用「**静态源码确认 + 轻量 mock 实测**」双通道，零 LLM 消耗。

## 二、无内置并发闸确认

### 源码扫描（dsh-subagent@0.1.5-rc.2 lib 全部 .js）

```
关键词: maxConcurrent, concurrency, semaphore, rateLimit, maxTotal, maxParallel, throttle
⚠️ 发现关键词 2 处:
  dsh-subagent/lib/index.js: concurrency        （注释：projection-cache bounded-concurrency read）
  lib/types/list-children.js: concurrency       （注释：同上）
```

2 处命中均为 **projection-cache 读取**的注释描述，**不是子代理并发闸**。
**无** `maxConcurrentChildren` / `maxTotalAgents` / semaphore / rate-limit 等任何并发限制。

### 深度限制确认

```js
delegationDepthOf / assertSubagentMaxDepth 存在
→ maxDepth 只限「深度」（默认 3），不限「广度」（同层并发数）
```

`maxDepth` 语义（FIX.5 已证）：限制子代理**嵌套深度**，不是**单层并发数量**。

### 轻量实测（mock N=32）

```
全部 32 个 mock 子代理完成，总耗时 31ms，最大单代理耗时 31ms
→ 若存在并发闸（如 maxConcurrent=4），总耗时应 ≈ 8×(单代理耗时)；
  实际总耗时≈单代理耗时 → 无排队，全量并发
```

无排队、全量并发启动——与「无内置并发闸」结论一致。内存 `rss=65.2MB heapUsed=12.5MB`
（mock 无真实 LLM 上下文，真实场景内存随并发上下文线性增长）。

## 三、社区插件防护效果（设计参考，未直接依赖）

| 插件 | 机制 | 适用层 | 效果评估 |
|---|---|---|---|
| `dsh-plugin-product-subagents` | `maxConcurrentChildren`（角色级限制） | Provider 层 | 可限制单角色并发，但需验证 0.1.5-rc.2 兼容性 |
| `dsh-turn-budget` | `maxToolCallsPerTurn`（fail-closed per-turn） | Agent Loop 层 | 限制单 agent 工具调用数，间接控并发，需实测 |
| `dsh-discipline-guard` | 循环熔断 / 成本熔断 | 治理层 | 兜底防失控，非并发闸 |

> ⚠️ 社区插件多数未适配 0.1.5-rc.2（README 已标注「仅作设计参考，不直接依赖」），
> 具体兼容性需在隔离环境实测（列入 MVP-2 T12 验证项）。

## 四、MVP-2 多层防护依据

| 层级 | 机制 | 来源 |
|---|---|---|
| Provider 层 | `maxDepth`（深度限制，已生效） | 官方 `dsh-subagent`（FIX.5 已验证） |
| Provider 层 | `maxConcurrentChildren`（角色级并发） | `dsh-plugin-product-subagents`（设计参考） |
| **引擎层** | **全局活跃 child 计数（自建，MVP-2 强制）** | **本项目自建——StateGraph 引擎在 `start()` 处计数，run 结束释放** |
| Agent Loop 层 | `maxToolCallsPerTurn` | `dsh-turn-budget`（兜底） |
| 进程层 | 无官方方案 | 结构性限制（文档固化） |

### 引擎层全局并发闸设计建议（MVP-2 T8 纳入）

```typescript
// state-graph.ts 内
interface EngineConcurrency {
  maxActive: number;          // 全局上限（配置化，默认 8）
  active: number;             // 活跃计数
  queue: Array<() => void>;   // 等待队列（FIFO）
}
// addSubagent 节点执行前：acquire() → active+1；run 结束 finally: release() → active-1 + 唤醒队首
```

- **acquire/release 必须成对**，且在 `try/finally` 中释放（防止节点失败死锁）
- 计数资源用 `ctx.effect()` 管理（RES.4 检查清单第 1/6 项）
- 单元测试覆盖：并发满时排队、失败时释放、恢复后继续（列入 MVP-2 测试方案）

## 五、结论

| 项 | 结果 |
|---|---|
| 实测脚本可运行 | ✅ `test-env/probe-concurrency.mjs` |
| 无内置并发闸确认 | ✅ 源码级（无 maxConcurrentChildren / semaphore） |
| `maxDepth` 只限深度 | ✅（默认 3） |
| 广度爆炸风险 | ⚠️ 确认存在（Discussion #131 场景），MVP-2 引擎层自建全局闸 |
| 社区插件防护 | 📘 设计参考（需隔离环境实测兼容性） |
| 阻塞 MVP-2 状态 | ✅ 解除（已有明确防护设计依据） |

## 六、给 MVP-2 的输入

1. **引擎层全局并发闸是强制项**（非可选）：README 风险表「并行/BFS 广度爆炸」缓解
   「全局上限需引擎层自建」——本任务确认必须实现。
2. **maxDepth 语义文档化**：`max_concurrent_children` 映射的是深度不是广度，
   角色 YAML 该字段命名易误导，MVP-2 图 DSL 中补充注释。
3. **防护分层**：引擎层闸（强）+ 角色层 maxConcurrentChildren（参考）+ turn-budget（兜底）。

---
**关联**：`docs/MVP-1.5/process/FIX.5-max_concurrent_children验证.md`、`docs/MVP-1.5/process/RES.3-API复测.md`、README 风险表
