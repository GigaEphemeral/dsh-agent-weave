# MVP-2.5 代码审查修复记录

> 版本：v1（2026-09-23）｜依据：`docs/MVP-2.5/代码审查修复.md`（51 问题）
> 范围：修复阻塞 MVP-3 的 S 系列 + 关键 M/WIN 系列；LOG 系列日志规范暂缓（用户指示）
> 状态：**✅ 修复完成**（178 测试全绿 + typecheck 0 + 实机验证）

## 一、修复清单（11 个必须修 + 关键项）

### S 系列（严重，全部修复）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| **S1** | graphVersion 硬编码 + graphSchemaHash 空 | `RunOptions` 加必需 `graphVersion`/`graphSchemaHash`；run() 缺失抛错 | ✅ review-fixes.spec |
| **S4** | loopUsed 恢复后归零 | `CheckpointPayload.loopUsage` 落盘 + 恢复读回 | ✅ checkpoint.ts |
| **S6** | 条件边 used 无上限 | `addConditionalEdge` maxIter 缺省 = 全局 maxIterations | ✅ review-fixes.spec（环熔断） |
| **S7** | fromDefinition 未处理 cond 边 | 同 from 的 cond 边合成一个 ConditionHandler（evaluateCondition 求值） | ✅ 通过 graph-service.spec |
| **S8** | 审批门 fail-open | `ApprovalGateOptions.required`（默认 true=fail-closed）；YAML 加载默认 false | ✅ review-fixes.spec |
| **S9** | emit 事件不落盘 | artifactsRoot 传入时 trace 事件同步追加 `traces/<graphId>.jsonl` | ✅ 实机验证（1772B） |
| **S11** | 无出边静默当成功 | 发 warning 级 graph/error 事件（不改变成功语义） | ✅ |
| **S12** | atomic-merge 原型污染 | Object.create(null) 结果 + 显式跳过 `__proto__/constructor/prototype` | ✅ review-fixes.spec |
| **S13** | 可视化数据源断裂 | GraphNodeContext 加 `reportTokenUsage`/`reportRetry`；node-end 携带数据 | ✅ review-fixes.spec |

### M 系列（中等，修复 8 项）

| # | 问题 | 修复 |
|---|---|---|
| M1 | artifacts 浅合并名不副实 | 递归深合并 |
| M8 | maxIterations 无上限 | Schema `max(1000)` |
| M9 | 排队版 release 竞态 | 审查确认当前实现正确（先 active-- 再移交队首，净变化 0） |
| M11 | parallel 边静默失效 | 静态验证器报"MVP-2 不支持" |
| M13 | 80% 告警整数比较永不触发 | `Math.ceil(max * 0.8)` |
| M14 | mock handler retry_count 与 merge 冲突 | 返回增量 1 |
| M15 | renderAsciiGraph 多条 seq 无提示 | 分叉提示行 |

### WIN 系列

| # | 问题 | 修复 |
|---|---|---|
| WIN1 | checkpoint lastIndexOf('/') | `path.dirname` / `path.join` |
| WIN3 | 动态 import Windows 裸路径 | 静态 import evaluateCondition |

### 附带（L5/L10/L12）

- L5：loop-iteration 事件加 from/to
- L10：event-bus 从 node-start 提取 currentRole
- L12：同 WIN3，静态 import

## 二、未修复（按用户指示暂缓）

| 类别 | 项 | 理由 |
|---|---|---|
| **真实 subagent 跑图** | weave_graph_run / runGraphReal | **留给 MVP-3**（用户明确指示） |
| LOG 系列 | trace_id 贯穿/日志格式/级别/component 枚举 | 用户指示"日志问题先不管" |
| S2/S3/S10 | chain-runner signal/effect/超时 | MVP-1 遗留，MVP-3 消息总线改造时一并处理 |
| S5 | resolveNextNode 未被引擎复用 | 建议修，MVP-3 引擎重构时统一 |

## 三、实机验证记录

| 验证项 | 结果 |
|---|---|
| 全量测试 | ✅ 178 通过（新增 review-fixes.spec 10 用例） |
| typecheck | ✅ 0 error |
| trace 落盘（S9） | ✅ `productions/traces/graph-*.jsonl`（1772B，含全部事件类型） |
| weave_graph_watch（实机） | ✅ 图执行成功 + trace 生成 |

## 四、新增能力：任务进度观测

**S9 trace 落盘**使任务进度可 tail 观测：

```powershell
# 实时跟随最新 trace（每个节点的事件一行）
Get-ChildItem productions\traces\graph-*.jsonl | Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 | ForEach-Object { Get-Content $_.FullName -Encoding UTF8 -Wait -Tail 20 }
```

新增 `weave_graph_tail` 工具：web chat/headless 查看最近 N 条事件。

---
**关联**：`docs/MVP-2.5/代码审查修复.md`（问题清单）、`docs/MVP-3/MVP-2真实环境验收操作指南.md`（验收 + 进度观测）
