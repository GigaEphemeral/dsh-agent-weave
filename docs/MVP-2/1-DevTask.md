# MVP-2：自研 StateGraph 引擎 · 完整开发任务书（含用户可视化验收）

> 版本：v2（2026-09-23）｜基线：**DSH 0.1.5-rc.2 + Windows 11 + Node 22.23**
> 交付对象：**Harness（开发执行）** + **验收人（手动验收 MVP-2 成果物）**
> 定位：**MVP-2 结束时，用户必须能手动观测到"哪个 subagent 在工作、工作到什么程度、有没有死循环"**


## 第一部分 · 需求确认与回应（先回答你的 5 个问题）

### Q1：图支持用户编辑吗？

**支持，但 MVP-2 是"YAML 文件编辑 + CLI 命令"，不是"图形界面拖拽"。**

| 编辑方式 | MVP-2 是否支持 | 落地方式 |
|---|---|---|
| **YAML 文件编辑** | ✅ 支持 | 用户直接编辑 `workflows/*.yaml` |
| **CLI 校验/查看** | ✅ 支持 | `weave graph validate <file>` / `weave graph show <file>` |
| **画布拖拽编辑** | ❌ 不支持 | 留给 MVP-5 |

MVP-2 用户编辑图的完整流程：
```
① 用户打开 workflows/my-flow.yaml，手动编辑节点和边
② 运行 weave graph validate my-flow.yaml，校验 Schema + 静态验证
③ 运行 weave graph show my-flow.yaml，看 ASCII 图结构
④ 运行 weave run my-flow.yaml，执行图
⑤ 观测终端实时视图 + 结束后看 HTML 报告
```

### Q2：支持分叉吗？

**支持"条件分叉"，不支持"并行分叉"。**

| 分叉类型 | MVP-2 是否支持 | 说明 |
|---|---|---|
| **条件分叉（cond edge）** | ✅ 支持 | 一个节点多条出边，每条带 `when` 条件，按优先级选第一条满足的 |
| **静态多出边** | ⚠️ 有限支持 | 多条 `seq` 边时只取第一条（不并行） |
| **并行分叉（parallel edge）** | ❌ 不支持 | 语法预留（`type: 'parallel'`），MVP-3 实现 |

**MVP-2 的分叉示例**：
```yaml
edges:
  - from: quality
    to: approval
    type: cond
    when: "state.retry_count >= state.max_iterations"
  - from: quality
    to: develop
    type: loop
    maxIter: 3
```
这是一个典型的"条件分叉"：quality 完成后，根据 `retry_count` 决定是升级到 approval 还是回退到 develop。

### Q3：支持循环吗？

**支持，这是 MVP-2 的核心能力。**

| 循环类型 | MVP-2 是否支持 | 说明 |
|---|---|---|
| **loop 边** | ✅ 支持 | `type: 'loop'` + `maxIter` |
| **条件回退** | ✅ 支持 | `cond` 边指向上游节点 |
| **迭代熔断** | ✅ 支持 | 全局 `maxIterations`（默认 25）+ 边级 `maxIter` |

### Q4：做了死循环控制吗？

**做了，三层防护。**

| 层级 | 机制 | 默认值 | 触发时机 |
|---|---|---|---|
| **边级熔断** | `loop` 边的 `maxIter` | 3 | 单条循环边的最大回退次数 |
| **全局熔断** | `maxIterations` | 25 | 整个图的迭代次数上限 |
| **并发闸** | `maxConcurrentChildren` | 8 | 同时活跃的子代理数 |

**熔断时的行为**：
- 达到 `maxIter` → 走升级路径（通常进审批节点）
- 达到 `maxIterations` → 发 `graph/error` 事件 + 终止执行
- **可视化告警**：终端视图和 HTML 报告都会用红色标注熔断

### Q5：做了进度可视化吗？

**MVP-2 新增两个可视化通道，专门给你手动验收用。**

| 通道 | 形态 | 用途 | 什么时候看 |
|---|---|---|---|
| **终端实时视图** | Shell 输出 | 运行中实时看：哪个节点在跑、跑到第几轮、有无死循环 | 运行时 |
| **HTML 执行报告** | 浏览器打开 | 运行后复盘：完整轨迹、Token 分账、节点耗时、图可视化 | 运行后 |

**终端实时视图长这样**：
```
┌─────────────────────────────────────────────────────────────┐
│ MVP-2 Graph Execution · graph-20260923-abc123               │
├─────────────────────────────────────────────────────────────┤
│   [develop]──→[test]──→[quality]──┐                         │
│       ↑                            │                        │
│       └────────loop (1/3)──────────┘                        │
│                                    │                        │
│                                    ↓ (retry_count>=3)       │
│                              [approval]                     │
├─────────────────────────────────────────────────────────────┤
│ 当前节点: R6-developer (develop)                            │
│ 迭代: 4/25 | retry_count: 1/3 | 耗时: 23s | Token: 12,345   │
├─────────────────────────────────────────────────────────────┤
│ 事件流:                                                     │
│  [00:00] ▶ graph/start                                      │
│  [00:01] ▶ develop 开始                                     │
│  [00:15] ✓ develop 完成 (14s, 5,678 tokens)                 │
│  [00:15] ▶ test 开始                                        │
│  [00:22] ✓ test 完成 (7s, 3,210 tokens)                     │
│  [00:22] ▶ quality 开始                                     │
│  [00:28] ⚠ quality 返回 retry → 回退到 develop              │
│  [00:28] ▶ develop 开始 (retry 1/3)                         │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

**HTML 执行报告长这样**（浏览器打开）：
- 顶部：执行状态 + 迭代次数 + 总耗时 + 总 Token
- 中部：SVG 画的图，节点按状态染色（绿=完成、黄=进行中、红=熔断）
- 下部：完整事件时间线 + Token 分账表


## 第二部分 · 任务总览（20 个任务）

> 相比原计划（17 任务），**新增 3 个可视化任务**（T11/T12/T13），并调整任务编号。

| 任务 ID | 任务名称 | 所属 Phase | 预估 | 依赖 |
|---|---|---|---|---|
| **T1** | 引擎内部类型定义 | A 图定义 | 1d | G0 |
| **T2** | 图 DSL Schema | A 图定义 | 2d | T1 |
| **T3** | 静态验证器 | A 图定义 | 2d | T2 |
| **T4** | CLI 图命令（validate / show） | A 图定义 | 1.5d | T3 |
| **T5** | checkpoint 契约（含 graphVersion） | B 引擎 | 2.5d | T1 |
| **T6** | 原子合并引擎 | B 引擎 | 2d | T1 |
| **T7** | 条件边与循环回退 | B 引擎 | 2d | T1 |
| **T8** | 全局并发闸 | B 引擎 | 1.5d | T1 |
| **T9** | StateGraph 引擎骨架 | B 引擎 | 3d | T2-T8 |
| **T10** | `ctx.graph` 服务 | B 引擎 | 1.5d | T9 |
| **T11** | 事件流总线（graph/* 事件） | C 可视化 | 1.5d | T9 |
| **T12** | 终端实时进度视图 | C 可视化 | 2d | T11 |
| **T13** | HTML 执行报告生成器 | C 可视化 | 2.5d | T11 |
| **T14** | 死循环/停滞告警 | C 可视化 | 1d | T12 |
| **T15** | 观察者 L1 | D 观察者 | 2d | T1 |
| **T16** | 挂载 dsh-turn-budget | D 观察者 | 0.5d | T10 |
| **T17** | 资源合规检查 | D 观察者 | 1d | T9, T10, T15 |
| **T18** | BDD/mock 测试矩阵 | E 测试 | 3d | T2-T15 |
| **T19** | 含循环端到端测试 | E 测试 | 2d | T18 |
| **T20** | graphVersion 恢复 + 热重载 | E 测试 | 1.5d | T5, T18 |

**合计**：20 个任务，**~36d**，**4-5 周**。


## 第三部分 · 阶段划分与门禁体系

### 3.1 五个阶段

```
┌─────────────────────────────────────────────────────────────┐
│ Phase A：图定义与编辑（T1-T4）                               │
│   目标：用户能用 YAML 编辑图，并用 CLI 校验/查看              │
│   门禁：GA（图定义门禁）                                     │
├─────────────────────────────────────────────────────────────┤
│ Phase B：引擎核心（T5-T10）                                  │
│   目标：StateGraph 引擎可执行，ctx.graph 服务可用             │
│   门禁：GB（引擎门禁）                                       │
├─────────────────────────────────────────────────────────────┤
│ Phase C：可视化观测（T11-T14）★ 用户核心诉求                 │
│   目标：终端实时视图 + HTML 报告 + 死循环告警                 │
│   门禁：GC（可视化门禁）                                     │
├─────────────────────────────────────────────────────────────┤
│ Phase D：观察者与合规（T15-T17）                             │
│   目标：L1 检查 + 资源合规                                   │
│   门禁：GD（合规门禁）                                       │
├─────────────────────────────────────────────────────────────┤
│ Phase E：测试与端到端（T18-T20）                             │
│   目标：全绿测试 + 循环跑通 + 版本恢复                        │
│   门禁：GE（测试门禁）                                       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ G-FINAL：MVP-2 收口门禁                                     │
│   用户手动验收 5 项（见第七部分）                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 门禁强制规则

| # | 规则 |
|---|---|
| 1 | **Entry Gate 未满足，任务禁止启动** |
| 2 | **Exit Gate 未通过，下游任务阻塞** |
| 3 | **Stage Gate 未通过，禁止进入下一阶段** |
| 4 | **契约冻结后（GB 通过），变更需重新走 GA** |
| 5 | **每个阶段必须有验收人签署** |


## 第四部分 · 任务详细拆解

---

## Phase A：图定义与编辑

### T1：引擎内部类型定义

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/types.ts` |
| 预估 | 1d |
| Entry Gate | G0（Phase F 通过） |
| Exit Gate | 类型检查通过 + 9 个类型完整 |

**开发任务**

1. 定义 9 个核心类型：`NodeHandler<T>` / `ConditionHandler<T>` / `GraphNodeContext<T>` / `TrajectoryEvent` / `GraphExecutionResult<T>` / `RunOptions<T>` / `CheckpointPayload<T>` / `CheckpointCallback<T>` / `GraphDefinitionSpec`
2. `TrajectoryEvent` 含 8 种类型（`graph/start` / `node-start` / `node-end` / `node-error` / `error` / `end` / `checkpoint-written` / `loop-iteration`）
3. `CheckpointPayload` 含 `graphVersion` + `graphSchemaHash`
4. 禁止 `any`；所有导出类型有 JSDoc

**Exit Gate**

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | `pnpm typecheck` | 0 error |
| 2 | 9 个类型存在 | 逐项核对 |
| 3 | `TrajectoryEvent` 含 8 种 | 逐项核对 |
| 4 | 无 `any` | `Select-String ": any"` 无输出 |

**验收人检查方法**
```powershell
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
pnpm typecheck
notepad src\l2-engine\types.ts
```

---

### T2：图 DSL Schema

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/graph-definition.ts` |
| 预估 | 2d |
| Entry Gate | T1 Exit |
| Exit Gate | 10 单测全绿 |

**开发任务**

1. 定义节点 ID 正则 `/^[a-z][a-z0-9_-]*$/`
2. 定义 5 个 Schema：`GraphNodeSpecSchema` / `GraphEdgeSpecSchema` / `CheckpointSpecSchema` / `GraphMetadataSchema` / `ObserverConfigSchema`
3. `GraphDefinitionSpecSchema` 含 6 条 refine：entryPoint 存在、边引用一致、ID 唯一、cond 有 when、loop 有 maxIter、自环只允许 loop
4. 实现 `parseGraphDefinition()` + `computeGraphSchemaHash()`
5. 10 个单测用例

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | 合法 YAML 通过 |
| 2 | 非法 YAML 被拒（含路径） |
| 3 | 10 单测全绿 |
| 4 | 6 条 refine 全部生效 |

**验收人检查方法**
```powershell
pnpm test tests/unit/graph-definition.spec.ts
# 期望：10 passed

# 手动测试非法 YAML
node -e "import('./lib/l2-engine/graph-definition.js').then(m => { try { m.parseGraphDefinition({entryPoint:'x',nodes:[],edges:[]}); console.log('❌'); } catch(e) { console.log('✅', e.message); } })"
```

---

### T3：静态验证器

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/static-validator.ts` |
| 预估 | 2d |
| Entry Gate | T2 Exit |
| Exit Gate | 8 单测全绿 + 性能达标 |

**开发任务**

1. 5 项检查：roleRef 注册、条件字段存在、入口可达、环检测（Kahn）、自环
2. 环检测用 Kahn + id 排序（确定性拓扑序）
3. **loop 边不视为环错误**
4. 状态字段白名单：`messages` / `current_phase` / `active_agent` / `task_queue` / `artifacts` / `quality_gate_status` / `retry_count` / `max_iterations`
5. 8 个单测 + 性能测试（100 节点图 < 10ms）

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-5 | 5 项检查生效 |
| 6 | 8 单测全绿 |
| 7 | loop 边不算错误 |
| 8 | 100 节点图 < 10ms |

**验收人检查方法**
```powershell
pnpm test tests/unit/static-validator.spec.ts
# 期望：8 passed，含性能输出
```

---

### T4：CLI 图命令（validate / show）

**任务目标**：让用户能用命令行校验和查看图。

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/cli/graph-commands.ts` + DSH 工具注册 |
| 预估 | 1.5d |
| Entry Gate | T3 Exit |
| Exit Gate | 3 个 CLI 命令可用 |

**开发任务**

1. **注册 3 个 CLI 命令**（通过 DSH 的 `ctx.tools.register`）：

| 命令 | 用途 | 示例 |
|---|---|---|
| `weave_graph_validate` | 校验 YAML 图 | `weave_graph_validate path=workflows/flow.yaml` |
| `weave_graph_show` | 显示 ASCII 图结构 | `weave_graph_show path=workflows/flow.yaml` |
| `weave_graph_help` | 显示命令帮助 | `weave_graph_help` |

2. **`weave_graph_show` 的 ASCII 输出**：
```
图: mvp2-loop-demo
入口: develop
节点数: 4 | 边数: 4 | 最大迭代: 25

  [develop]──→[test]──→[quality]──┐
      ↑                            │
      └────────loop (1/3)──────────┘
                                   │
                                   ↓ (retry_count>=3)
                             [approval]

节点详情:
  · develop (role: R6-developer)
  · test (role: R7-tester)
  · quality (role: R8-quality)
  · approval (approval)
```

3. **`weave_graph_validate` 的校验输出**：
```
✅ 图校验通过
   · Schema 校验：通过
   · 静态验证：通过
   · 5 项检查：全部通过
   · graphSchemaHash: a1b2c3d4e5f6
```

或
```
❌ 图校验失败
   · nodes.nonexistent: entryPoint 指向的节点不存在
   · edges.develop->unknown: 边的目标节点不存在
```

4. 3 个单测用例

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | 3 个命令可用 |
| 2 | `validate` 能识别合法/非法图 |
| 3 | `show` 输出 ASCII 图 |
| 4 | 3 个单测全绿 |

**验收人检查方法**

```powershell
# ① 启动隔离环境
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-headless "调用 weave_graph_show 工具，path 为 workflows/mvp2-loop-demo.yaml"

# ② 期望输出：ASCII 图结构
# ③ 手动编辑一个 YAML，跑 validate 看是否报错
```


## Phase B：引擎核心

### T5：checkpoint 契约（含 graphVersion）

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/checkpoint.ts` |
| 预估 | 2.5d |
| Entry Gate | T1 Exit |
| Exit Gate | 7 单测全绿 |

**开发任务**

1. `createCheckpointCallback(ctx, graphId, graphVersion, graphSchemaHash)`
2. 落盘 7 字段：`graphId` / `graphVersion` / `graphSchemaHash` / `node` / `state` / `iteration` / `timestamp`
3. 路径：`checkpoints/<graphId>/<iteration>-<node>.json`
4. 回调不抛错（吞掉记日志）
5. `restoreFromLatestCheckpoint(ctx, graphId, currentGraphVersion)`：版本相同→恢复；版本不同→`VERSION_MISMATCH`；无→`null`
6. 序列化失败 fail-fast
7. `ctx.effect()` 注册存储句柄
8. 7 个单测

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-7 | 7 单测全绿 |
| 8 | 无裸 `fs.open` / `setTimeout` |

**验收人检查方法**
```powershell
pnpm test tests/unit/checkpoint.spec.ts
Select-String -Path src\l2-engine\checkpoint.ts -Pattern "setTimeout|fs\.open"
```

---

### T6：原子合并引擎

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/atomic-merge.ts` |
| 预估 | 2d |
| Entry Gate | T1 Exit |
| Exit Gate | 10 单测全绿 |

**开发任务**

1. `MERGEABLE_FIELDS = ['messages', 'artifacts', 'retry_count']`
2. 三种策略：追加 / 深合并 / 累加
3. `mergeState()` 逻辑：可合并→策略；首次→写入；相同→无操作；不同→冲突
4. 10 个单测（含 3 组结合律用例）

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-6 | 6 个基础用例 |
| 7 | 结合律验证 |
| 8 | 10 单测全绿 |

**验收人检查方法**
```powershell
pnpm test tests/unit/atomic-merge.spec.ts
# 手动验证冲突
node -e "const m=require('./lib/l2-engine/atomic-merge.js'); console.log(JSON.stringify(m.mergeState({x:1},{x:2})))"
```

---

### T7：条件边与循环回退

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/condition-edge.ts` |
| 预估 | 2d |
| Entry Gate | T1 Exit |
| Exit Gate | 12 单测全绿 |

**开发任务**

1. `evaluateCondition()` 支持 9 种操作符 + 白名单 + `"use strict"`
2. `resolveNextNode()` 逻辑：
   - **条件分叉**：多条出边时，按优先级（cond > loop > seq）选第一条满足的
   - **循环回退**：loop 边根据 `shouldRetry` / `shouldEscalate` 决定
   - **终止**：无出边或 `__END__` 哨兵
3. `shouldRetry()` / `shouldEscalate()`
4. `ConditionEvalError`
5. 12 个单测（含 2 个优先级用例）

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | 9 种操作符支持 |
| 2 | 非法表达式抛错 |
| 3 | 循环回退正确 |
| 4 | 升级审批正确 |
| 5 | 条件边优先于静态边 |
| 6 | 12 单测全绿 |

**验收人检查方法**
```powershell
pnpm test tests/unit/condition-edge.spec.ts
# 手动验证
node -e "const c=require('./lib/l2-engine/condition-edge.js'); console.log(c.evaluateCondition('state.retry_count >= 3', {retry_count:5}))"
```

---

### T8：全局并发闸

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/concurrency-counter.ts` |
| 预估 | 1.5d |
| Entry Gate | T1 Exit |
| Exit Gate | 6 单测全绿 |

**开发任务**

1. `createConcurrencyCounter(ctx, limit)`：`acquire()` / `release()` / `getActive()` / `getLimit()`
2. `ctx.effect()` 注册清理
3. 6 个单测

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-5 | 5 个基础用例 |
| 6 | 6 单测全绿 |

**验收人检查方法**
```powershell
pnpm test tests/unit/concurrency-counter.spec.ts
```

---

### T9：StateGraph 引擎骨架

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/state-graph.ts` |
| 预估 | 3d |
| Entry Gate | T2-T8 Exit（**GB 契约冻结**） |
| Exit Gate | 引擎可执行 + 8 个断言通过 |

**开发任务**

1. 实现 `createStateGraph<T>(ctx, maxIterations=25)` 返回 5 个方法
2. `__END__` 保留哨兵；节点重名抛错
3. `run()` 主循环：
   - 迭代熔断（进入节点前检查）
   - 并发闸 acquire → 执行 → finally release
   - 审批门 `ctx.approval.request` 等 `allowed-once`
   - checkpoint（合并后、跳转前）
   - 轨迹事件 8 种
   - 合并冲突返回 `success: false`
4. 集成测试：简单三节点图 + 循环回退

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | 5 个方法可用 |
| 2 | `run()` 从入口执行 |
| 3 | 迭代熔断生效 |
| 4 | 合并冲突返回 `success: false` |
| 5 | 并发闸成对（finally release） |
| 6 | 审批门 `allowed-once` |
| 7 | 轨迹事件 8 种 |
| 8 | 简单三节点图跑通 |

**验收人检查方法**
```powershell
pnpm test tests/integration/state-graph.spec.ts
# 手动跑简单图
node -e "import('./lib/l2-engine/state-graph.js').then(async m => { const g=m.createStateGraph({}); g.addNode('a', async()=>({v:1})); g.addNode('b', async()=>({v:2})); g.addEdge('a','b'); const r=await g.run({},{checkpoint:async()=>{}}); console.log('success:',r.success,'iterations:',r.iterations); })"
```

---

### T10：`ctx.graph` 服务

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l2-engine/graph-service.ts` + `src/index.ts` 扩展 |
| 预估 | 1.5d |
| Entry Gate | T9 Exit |
| Exit Gate | `ctx.graph` 可访问 |

**开发任务**

1. `GraphEngineService extends Service`，`super(ctx, "graph")`
2. `declare module` 类型增强
3. `Config` 用 zod 校验：`defaultMaxIterations` / `logTrajectory` / `maxConcurrentChildren`
4. `create<T>()` / `fromDefinition<T>()`
5. `src/index.ts` 中 `ctx.plugin(GraphEngineService, {...})`
6. 3 个单测

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | Service 子类 |
| 2 | `ctx.graph` 可访问 |
| 3 | `create()` / `fromDefinition()` 可用 |
| 4 | 3 单测全绿 |

**验收人检查方法**
```powershell
pnpm test tests/unit/graph-service.spec.ts
# 隔离环境验证
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-test --dump-config 2>&1 | Select-String "graph"
```


## Phase C：可视化观测（★ 你的核心诉求）

### T11：事件流总线（graph/* 事件）

**任务目标**：把引擎产生的 `graph/*` 事件统一收集，供终端视图和 HTML 报告消费。

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l4-visual/host/event-bus.ts` |
| 预估 | 1.5d |
| Entry Gate | T9 Exit |
| Exit Gate | 事件总线可订阅 + 事件完整 |

**开发任务**

1. **定义事件总线接口**：

```typescript
export interface GraphEventBus {
  /** 订阅所有 graph/* 事件 */
  subscribe(handler: (event: TrajectoryEvent) => void): Disposable;
  /** 获取当前执行状态快照 */
  getSnapshot(): ExecutionSnapshot;
  /** 清空 */
  reset(): void;
}

export interface ExecutionSnapshot {
  graphId: string;
  current: string;           // 当前节点
  currentRole: string;       // 当前角色
  iteration: number;
  maxIterations: number;
  retryCount: number;
  maxRetry: number;
  startedAt: number;
  elapsedMs: number;
  tokenUsed: number;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  trajectory: TrajectoryEvent[];
  nodeStates: Record<string, NodeState>;
}

export type NodeState = 'idle' | 'running' | 'completed' | 'failed';
```

2. **在 `src/index.ts` 的 `apply` 中注册事件总线**：

```typescript
ctx.on('graph/start', (event) => bus.handle(event));
ctx.on('graph/node-start', (event) => bus.handle(event));
// ... 8 种事件
```

3. **提供 CLI 工具查询快照**：

```typescript
ctx.tools.register({
  name: 'weave_graph_status',
  description: '查看当前图执行状态',
  async execute() {
    const snapshot = bus.getSnapshot();
    return formatSnapshot(snapshot);
  }
});
```

4. 4 个单测

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | 8 种事件全部订阅 |
| 2 | `getSnapshot()` 返回完整状态 |
| 3 | `weave_graph_status` 工具可用 |
| 4 | 4 单测全绿 |

**验收人检查方法**
```powershell
pnpm test tests/unit/event-bus.spec.ts
# 运行中查询状态
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-headless "调用 weave_graph_status 工具"
```

---

### T12：终端实时进度视图

**任务目标**：运行图时，终端实时显示"哪个 subagent 在工作、跑到什么程度、有无死循环"。

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l4-visual/host/terminal-view.ts` |
| 预估 | 2d |
| Entry Gate | T11 Exit |
| Exit Gate | 终端视图可运行 + 3 个断言通过 |

**开发任务**

1. **实现终端实时视图**（订阅事件总线，逐行打印）：

```
┌─────────────────────────────────────────────────────────────┐
│ MVP-2 Graph Execution · graph-20260923-abc123               │
├─────────────────────────────────────────────────────────────┤
│   [develop]──→[test]──→[quality]──┐                         │
│       ↑                            │                        │
│       └────────loop (1/3)──────────┘                        │
│                                    │                        │
│                                    ↓ (retry_count>=3)       │
│                              [approval]                     │
├─────────────────────────────────────────────────────────────┤
│ 当前节点: R6-developer (develop)                            │
│ 迭代: 4/25 | retry_count: 1/3 | 耗时: 23s | Token: 12,345   │
├─────────────────────────────────────────────────────────────┤
│ 事件流:                                                     │
│  [00:00] ▶ graph/start                                      │
│  [00:01] ▶ develop 开始                                     │
│  [00:15] ✓ develop 完成 (14s, 5,678 tokens)                 │
│  [00:15] ▶ test 开始                                        │
│  [00:22] ✓ test 完成 (7s, 3,210 tokens)                     │
│  [00:22] ▶ quality 开始                                     │
│  [00:28] ⚠ quality 返回 retry → 回退到 develop              │
│  [00:28] ▶ develop 开始 (retry 1/3)                         │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

2. **关键设计**：
   - **不刷新整个屏幕**，只追加事件行（类似 `docker build` 输出，兼容所有终端）
   - **每分钟更新一次状态头**（用 `\r` 覆盖上一行）
   - **颜色编码**（ANSI 转义）：
     - `▶` 绿色：节点开始
     - `✓` 蓝色：节点完成
     - `⚠` 黄色：回退/警告
     - `✗` 红色：错误/熔断

3. **实现方式**：注册一个 DSH 工具 `weave_graph_watch <file>`，运行图并实时打印。

4. **3 个断言**：
   - 运行时能看到当前节点
   - 能看到迭代次数
   - 能看到 retry_count

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | `weave_graph_watch` 工具可运行 |
| 2 | 终端显示当前节点 |
| 3 | 终端显示迭代/retry/耗时/Token |
| 4 | 颜色编码生效 |

**验收人检查方法**

```powershell
# 启动隔离环境
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'

# 运行图（实时视图）
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_watch 工具，path 为 workflows/mvp2-loop-demo.yaml"

# 期望：终端实时显示当前节点、迭代次数、retry_count
```

**验收标准**：运行时能看到"现在是哪个 subagent 在工作 + 工作到什么程度"。

---

### T13：HTML 执行报告生成器

**任务目标**：运行结束后生成一个 HTML 报告，浏览器打开可完整复盘。

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l4-visual/host/html-report.ts` |
| 预估 | 2.5d |
| Entry Gate | T11 Exit |
| Exit Gate | HTML 报告可生成 + 4 个断言通过 |

**开发任务**

1. **生成 4 个 section**：

| Section | 内容 |
|---|---|
| **Summary** | 执行状态 + 迭代次数 + 总耗时 + 总 Token |
| **Graph SVG** | 用 SVG 画的图，节点按状态染色 |
| **Timeline** | 完整事件时间线（可滚动） |
| **Token 分账** | 按节点/角色的 Token 消耗表 |

2. **HTML 模板**（用内联 CSS + 简单 JS，无依赖）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Graph Execution Report · {{graphId}}</title>
  <style>
    body { font-family: system-ui; max-width: 1200px; margin: 0 auto; padding: 20px; }
    .summary { background: #f5f5f5; padding: 16px; border-radius: 8px; }
    .status-success { color: #16a34a; }
    .status-failed { color: #dc2626; }
    .node-running { fill: #fbbf24; }
    .node-completed { fill: #22c55e; }
    .node-failed { fill: #ef4444; }
    .node-idle { fill: #e5e7eb; }
    .timeline-entry { padding: 4px 0; border-bottom: 1px solid #eee; }
    .timeline-entry.warn { color: #d97706; }
    .timeline-entry.error { color: #dc2626; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <h1>图执行报告</h1>

  <section class="summary">
    <h2>执行摘要</h2>
    <p>图 ID: <code>{{graphId}}</code></p>
    <p>状态: <span class="status-{{statusClass}}">{{statusText}}</span></p>
    <p>迭代次数: {{iterations}} / {{maxIterations}}</p>
    <p>总耗时: {{totalDuration}}</p>
    <p>总 Token: {{totalTokens}}</p>
    <p>retry_count: {{retryCount}} / {{maxRetry}}</p>
  </section>

  <section>
    <h2>图结构</h2>
    <svg viewBox="0 0 {{svgWidth}} {{svgHeight}}">
      <!-- 用 d3 或手算坐标画节点和边 -->
    </svg>
  </section>

  <section>
    <h2>事件时间线</h2>
    <div id="timeline">
      {{#each trajectory}}
      <div class="timeline-entry {{#if warn}}warn{{/if}} {{#if error}}error{{/if}}">
        [{{time}}] {{icon}} {{message}}
      </div>
      {{/each}}
    </div>
  </section>

  <section>
    <h2>Token 分账</h2>
    <table>
      <thead><tr><th>节点</th><th>角色</th><th>输入</th><th>输出</th><th>缓存读</th><th>合计</th></tr></thead>
      <tbody>
        {{#each tokens}}
        <tr><td>{{node}}</td><td>{{role}}</td><td>{{input}}</td><td>{{output}}</td><td>{{cacheRead}}</td><td>{{total}}</td></tr>
        {{/each}}
      </tbody>
    </table>
  </section>
</body>
</html>
```

3. **注册 DSH 工具**：
   - `weave_graph_report <file>` — 运行图并生成 HTML
   - 输出路径：`reports/<graphId>.html`
   - 自动提示：`✅ 报告已生成: reports/graph-xxx.html（用浏览器打开）`

4. **4 个断言**：
   - HTML 文件生成
   - Summary 显示正确
   - SVG 图节点染色正确
   - Token 分账表完整

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | `weave_graph_report` 可运行 |
| 2 | HTML 文件生成 |
| 3 | 4 个 section 全部渲染 |
| 4 | 节点染色正确 |

**验收人检查方法**

```powershell
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'

# 运行并生成报告
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_report 工具，path 为 workflows/mvp2-loop-demo.yaml"

# 打开报告
start reports\graph-*.html
```

**验收标准**：浏览器打开报告，能看到 4 个 section，图节点按状态染色。

---

### T14：死循环/停滞告警

**任务目标**：当图出现死循环或停滞时，终端和 HTML 都明确告警。

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/l4-visual/host/loop-detector.ts` |
| 预估 | 1d |
| Entry Gate | T12 Exit |
| Exit Gate | 3 类告警生效 |

**开发任务**

1. **定义 3 类告警**：

| 告警类型 | 触发条件 | 终端表现 | HTML 表现 |
|---|---|---|---|
| **边级循环告警** | 某条 loop 边达到 `maxIter` 的 80% | 黄色 `⚠` | 节点橙黄色 |
| **全局迭代告警** | `iteration` 达到 `maxIterations` 的 80% | 黄色 `⚠` | Summary 橙色 |
| **熔断告警** | 达到 `maxIter` 或 `maxIterations` | 红色 `✗` | 节点红色 + 告警框 |

2. **实现方式**：订阅 `graph/loop-iteration` 和 `graph/error` 事件，触发时打印告警。

3. **3 个断言**：
   - 边级告警生效
   - 全局告警生效
   - 熔断告警生效

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | 3 类告警全部生效 |
| 2 | 终端和 HTML 都能看到告警 |
| 3 | 熔断时程序正确终止 |

**验收人检查方法**

```powershell
# 造一个会死循环的图
# 把 mvp2-loop-demo.yaml 的 maxIter 改成 100，max_iterations 改成 100

# 运行
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_watch 工具，path 为 workflows/infinite-loop-test.yaml"

# 期望：
# · 达到 80% 时终端黄色告警
# · 达到 100% 时终端红色熔断 + 程序终止
# · HTML 报告里节点红色
```


## Phase D：观察者与合规

### T15：观察者 L1

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `src/observers/observer-l1.ts` + `signal.ts` |
| 预估 | 2d |
| Entry Gate | T1 Exit |
| Exit Gate | 6 单测全绿 + 零 Token |

**开发任务**

1. 三项检查：命名规范（kebab-case）、权限（role 节点有 roleRef）、状态（retry_count 非负）
2. 零 Token（不调用 `ctx.llm`）
3. `L1CheckResult` 返回 `passed` / `signal` / `findings`
4. 6 单测

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-3 | 三项检查生效 |
| 4 | 零 Token |
| 5 | 6 单测全绿 |

**验收人检查方法**
```powershell
pnpm test tests/unit/observer-l1.spec.ts
Select-String -Path src\observers\observer-l1.ts -Pattern "ctx\.llm"  # 期望无输出
```

---

### T16：挂载 `dsh-turn-budget`

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `cordis.patch.yml` |
| 预估 | 0.5d |
| Entry Gate | T10 Exit |
| Exit Gate | 配置生效 |

**开发任务**

```yaml
- update:
    id: turn-budget
    config:
      maxStepsPerTurn: 16
      maxToolCallsPerTurn: 24
      maxProviderTokensPerTurn: 50000
```

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | `--dump-config` 含配置 |
| 2 | 超限被拒 |

**验收人检查方法**
```powershell
Get-Content cordis.patch.yml | Select-String "turn-budget"
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-test --dump-config 2>&1 | Select-String "turn-budget"
```

---

### T17：资源合规检查

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `docs/MVP-2/资源合规检查.md` |
| 预估 | 1d |
| Entry Gate | T9 + T10 + T15 Exit |
| Exit Gate | 7 项检查通过 |

**开发任务**

1. 按 RES.4 §五 的 7 项检查清单逐项审查
2. 每项列出证据（代码位置 + 检查结果）
3. 报告归档

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-7 | 7 项检查通过 |
| 8 | 报告归档 |

**验收人检查方法**
```powershell
Select-String -Path src\**\*.ts -Pattern "setTimeout|setInterval|fs\.open|new Database|fs\.watch"
notepad docs\MVP-2\资源合规检查.md
```


## Phase E：测试与端到端

### T18：BDD/mock 测试矩阵

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `tests/unit/*.spec.ts`（7 文件，59 用例） |
| 预估 | 3d |
| Entry Gate | T2-T15 Exit |
| Exit Gate | 59 单测全绿 + 零 LLM |

**开发任务**

7 个测试文件 + 59 用例（见原计划）。

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-7 | 7 个文件全绿 |
| 8 | 零 LLM |
| 9 | `pnpm typecheck` 0 error |

**验收人检查方法**
```powershell
pnpm test
Select-String -Path tests\unit\*.spec.ts -Pattern "ctx\.llm"  # 期望无输出
```

---

### T19：含循环端到端测试

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `workflows/mvp2-loop-demo.yaml` + `tests/integration/loop-workflow.spec.ts` |
| 预估 | 2d |
| Entry Gate | T18 Exit |
| Exit Gate | 循环跑通 + 熔断双生效 |

**开发任务**

1. 创建 `workflows/mvp2-loop-demo.yaml`（含 develop→test→quality→develop 循环）
2. 编写集成测试（mock 节点）
3. 6 个断言

**Exit Gate**

| # | 检查项 |
|---|---|
| 1 | 从 develop 开始 |
| 2 | 循环最多 3 次 |
| 3 | retry_count >= max 时进入 approval |
| 4 | 每次迭代有 checkpoint |
| 5 | trajectory 完整 |
| 6 | 零 LLM |

**验收人检查方法**
```powershell
pnpm test tests/integration/loop-workflow.spec.ts

# 用 CLI 实际跑一次
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_watch 工具，path 为 workflows/mvp2-loop-demo.yaml"

# 用 HTML 报告看
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_report 工具，path 为 workflows/mvp2-loop-demo.yaml"
start reports\graph-*.html
```

---

### T20：graphVersion 恢复 + 热重载

**任务概要**

| 项 | 值 |
|---|---|
| 交付物 | `tests/integration/version-restore.spec.ts` + `tests/integration/hot-reload.spec.ts` |
| 预估 | 1.5d |
| Entry Gate | T5 + T18 Exit |
| Exit Gate | 版本恢复 3 断言 + 热重载 3 断言 |

**开发任务**

1. 版本恢复 3 场景：相同→恢复；不同→`VERSION_MISMATCH`；无→`null`
2. 热重载 3 场景：无定时器泄漏；无文件句柄泄漏；LIFO 释放

**Exit Gate**

| # | 检查项 |
|---|---|
| 1-3 | 版本恢复 3 场景 |
| 4-6 | 热重载 3 场景 |

**验收人检查方法**
```powershell
pnpm test tests/integration/version-restore.spec.ts
pnpm test tests/integration/hot-reload.spec.ts
node test-env\probe-hot-reload.mjs
```


## 第五部分 · Stage Gate 检查清单（验收人打勾）

### GA：图定义门禁（T1-T4）

```powershell
pnpm test tests/unit/graph-definition.spec.ts tests/unit/static-validator.spec.ts
# 期望：18 passed

pnpm typecheck
# 期望：0 error
```

- [ ] T1 类型契约冻结
- [ ] T2 Schema 冻结（10 用例）
- [ ] T3 静态验证器（8 用例）
- [ ] T4 CLI 命令可用（3 个）
- [ ] **契约冻结声明**

**未通过 → 禁止启动 T5。**

### GB：引擎门禁（T5-T10）

```powershell
pnpm test tests/unit/checkpoint.spec.ts tests/unit/atomic-merge.spec.ts tests/unit/condition-edge.spec.ts tests/unit/concurrency-counter.spec.ts tests/integration/state-graph.spec.ts
# 期望：全部通过

pnpm typecheck
```

- [ ] T5 checkpoint 契约冻结（7 用例）
- [ ] T6 合并契约冻结（10 用例）
- [ ] T7 边契约冻结（12 用例）
- [ ] T8 并发闸（6 用例）
- [ ] T9 引擎可执行
- [ ] T10 `ctx.graph` 可访问
- [ ] **契约冻结声明（这是最重要的门禁）**

**未通过 → 禁止启动 T11。**

### GC：可视化门禁（T11-T14）

```powershell
pnpm test tests/unit/event-bus.spec.ts
# 期望：通过

# 手动跑可视化
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_watch 工具，path 为 workflows/mvp2-loop-demo.yaml"
```

- [ ] T11 事件总线可用
- [ ] T12 终端实时视图可运行
- [ ] T13 HTML 报告可生成
- [ ] T14 死循环告警生效
- [ ] **验收人手动跑通终端视图 + HTML 报告**

**未通过 → 禁止启动 T15。**

### GD：合规门禁（T15-T17）

```powershell
pnpm test tests/unit/observer-l1.spec.ts
Select-String -Path src\**\*.ts -Pattern "setTimeout|fs\.open"
```

- [ ] T15 观察者 L1（6 用例 + 零 Token）
- [ ] T16 `dsh-turn-budget` 挂载
- [ ] T17 资源合规 7 项通过

**未通过 → 禁止启动 T18。**

### GE：测试门禁（T18-T20）

```powershell
pnpm test
pnpm typecheck
pnpm build

# 手动跑 3 个端到端
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-headless "调用 weave_graph_report 工具，path 为 workflows/mvp2-loop-demo.yaml"
```

- [ ] T18 59 单测全绿 + 零 LLM
- [ ] T19 循环端到端跑通
- [ ] T20 版本恢复 + 热重载
- [ ] **验收人手动跑通完整流程**

**未通过 → 禁止进入 G-FINAL。**


## 第六部分 · G-FINAL：MVP-2 收口门禁（用户手动验收）

### 用户手动验收 5 步

**Step 1：环境准备**

```powershell
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode

# 设置隔离环境
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'

# 设置 API key（如需要）
$creds = Get-Content "D:\dsharness\data\.credentials.yaml" -Raw
$env:HUOSHAN_186_API_KEY = [regex]::Match($creds, 'HUOSHAN_186_API_KEY:\s*(\S+)').Groups[1].Value
```

**Step 2：图编辑 + 校验 + 查看**

```powershell
# ① 编辑一个图（用记事本或 VSCode）
notepad workflows\mvp2-loop-demo.yaml

# ② 校验
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_validate 工具，path 为 workflows/mvp2-loop-demo.yaml"

# ③ 查看 ASCII 图
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_show 工具，path 为 workflows/mvp2-loop-demo.yaml"

# 期望：看到 ASCII 图结构，节点和边清晰
```

**Step 3：实时观测**

```powershell
# 运行并实时观测
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_watch 工具，path 为 workflows/mvp2-loop-demo.yaml"

# 期望看到：
# · 当前节点（哪个 subagent 在工作）
# · 迭代次数（4/25）
# · retry_count（1/3）
# · 耗时和 Token
# · 事件流逐行滚动
```

**Step 4：HTML 报告复盘**

```powershell
# 生成报告
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_report 工具，path 为 workflows/mvp2-loop-demo.yaml"

# 打开报告
start reports\graph-*.html

# 期望看到：
# · Summary：状态/迭代/耗时/Token
# · SVG 图：节点按状态染色
# · Timeline：完整事件时间线
# · Token 分账表
```

**Step 5：死循环告警验证**

```powershell
# 造一个会死循环的图
Copy-Item workflows\mvp2-loop-demo.yaml workflows\test-infinite.yaml
# 编辑 test-infinite.yaml：把 maxIter 改成 100，max_iterations 改成 100

# 运行
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "调用 weave_graph_watch 工具，path 为 workflows/test-infinite.yaml"

# 期望：
# · 达到 80% 时黄色告警
# · 达到 100% 时红色熔断 + 程序终止
```

### 用户验收 5 项门禁

| # | 门禁 | 验证方式 | 通过标准 | 签署 |
|---|---|---|---|---|
| 1 | **图可编辑** | 步骤 2 | YAML 编辑 + validate + show 全部可用 | ☐ |
| 2 | **图支持循环与条件分叉** | 步骤 3 | loop 边 + cond 边生效 | ☐ |
| 3 | **死循环控制** | 步骤 5 | 三层熔断生效 + 告警正确 | ☐ |
| 4 | **实时可视化** | 步骤 3 | 终端实时显示当前节点/迭代/retry/耗时/Token | ☐ |
| 5 | **复盘可视化** | 步骤 4 | HTML 报告 4 section 完整 | ☐ |

**验收人签署栏**：

```
验收日期：2026-XX-XX
验收人：_____________
结论：☐ 全部通过 / ☐ 有条件通过 / ☐ 未通过
备注：_____________
```


## 第七部分 · 一键验收脚本

创建 `test-env/verify-mvp2.ps1`：

```powershell
# verify-mvp2.ps1 — MVP-2 验收一键脚本
Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MVP-2 验收检查" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan

cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
$dshBin = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"

# ① 类型检查
Write-Host "`n[1/7] 类型检查..." -ForegroundColor Yellow
pnpm typecheck
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 类型检查失败" -ForegroundColor Red; exit 1 }
Write-Host "✅ 类型检查通过" -ForegroundColor Green

# ② 单元测试
Write-Host "`n[2/7] 单元测试..." -ForegroundColor Yellow
pnpm test
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 单测失败" -ForegroundColor Red; exit 1 }
Write-Host "✅ 单测通过" -ForegroundColor Green

# ③ 集成测试
Write-Host "`n[3/7] 集成测试..." -ForegroundColor Yellow
pnpm test tests/integration/
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 集成测试失败" -ForegroundColor Red; exit 1 }
Write-Host "✅ 集成测试通过" -ForegroundColor Green

# ④ 构建
Write-Host "`n[4/7] 构建..." -ForegroundColor Yellow
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 构建失败" -ForegroundColor Red; exit 1 }
Write-Host "✅ 构建通过" -ForegroundColor Green

# ⑤ 零 LLM 验证
Write-Host "`n[5/7] 零 LLM 验证..." -ForegroundColor Yellow
$llmHits = Select-String -Path tests\unit\*.spec.ts -Pattern "ctx\.llm" -ErrorAction SilentlyContinue
if ($llmHits) { Write-Host "❌ 测试中调用了 ctx.llm" -ForegroundColor Red; exit 1 }
Write-Host "✅ 零 LLM 通过" -ForegroundColor Green

# ⑥ 图编辑命令验证
Write-Host "`n[6/7] 图编辑命令验证..." -ForegroundColor Yellow
node $dshBin --profile weave-headless "调用 weave_graph_validate 工具，path 为 workflows/mvp2-loop-demo.yaml" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "⚠️ 图校验命令需手动验证" -ForegroundColor Yellow }
else { Write-Host "✅ 图校验命令可用" -ForegroundColor Green }

# ⑦ HTML 报告生成验证
Write-Host "`n[7/7] HTML 报告生成验证..." -ForegroundColor Yellow
node $dshBin --profile weave-headless "调用 weave_graph_report 工具，path 为 workflows/mvp2-loop-demo.yaml" 2>&1 | Out-Null
$report = Get-ChildItem reports\*.html -ErrorAction SilentlyContinue | Select-Object -Last 1
if ($report) { 
  Write-Host "✅ HTML 报告已生成: $($report.FullName)" -ForegroundColor Green
  Write-Host "   运行: start $($report.FullName)" -ForegroundColor Cyan
} else {
  Write-Host "⚠️ HTML 报告未生成" -ForegroundColor Yellow
}

Write-Host "`n═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  验收完成" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan

Write-Host "`n下一步：手动验收 5 项" -ForegroundColor Yellow
Write-Host "  1. 编辑 workflows/mvp2-loop-demo.yaml"
Write-Host "  2. weave_graph_validate"
Write-Host "  3. weave_graph_show"
Write-Host "  4. weave_graph_watch（看实时视图）"
Write-Host "  5. weave_graph_report（看 HTML 报告）"
```

**运行方式**：

```powershell
.\test-env\verify-mvp2.ps1
```


## 第八部分 · 总结

### 相比原计划的差异

| 项 | 原计划 | 新计划 |
|---|---|---|
| 任务数 | 17 | **20**（新增 3 个可视化任务） |
| 用户可视化 | ❌ 无 | ✅ 终端实时视图 + HTML 报告 + 死循环告警 |
| 图编辑 | 隐式（YAML） | ✅ CLI 命令 `validate` / `show` |
| 分叉支持 | 不明确 | ✅ 明确"条件分叉支持，并行分叉不支持" |
| 死循环控制 | 隐式 | ✅ 三层熔断 + 可视化告警 |
| 用户验收 | 无 | ✅ 5 步手动验收 + 一键脚本 |

### 你的 5 个问题回答汇总

| 问题 | 答案 |
|---|---|
| 图支持用户编辑吗？ | ✅ YAML 编辑 + CLI 校验/查看 |
| 支持分叉吗？ | ✅ 条件分叉支持；❌ 并行分叉不支持（MVP-3） |
| 支持循环吗？ | ✅ 核心能力 |
| 做了死循环控制吗？ | ✅ 三层熔断（边级/全局/并发）+ 可视化告警 |
| 做了进度可视化吗？ | ✅ 终端实时视图 + HTML 复盘报告 |

### MVP-2 结束你能看到什么

1. **编辑一个 YAML 图**（记事本）
2. **运行 `weave_graph_validate`** 校验
3. **运行 `weave_graph_show`** 看 ASCII 图
4. **运行 `weave_graph_watch`** 实时看"哪个 subagent 在工作、跑到什么程度、有没有死循环"
5. **运行 `weave_graph_report`** 生成 HTML 报告，浏览器复盘
6. **运行 `verify-mvp2.ps1`** 一键验收