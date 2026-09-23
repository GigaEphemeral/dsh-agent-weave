# MVP-3 Phase 0 修复记录

> 版本：v1（2026-09-23）｜依据：`docs/MVP-3/MVP-3task.md` 第一部分
> 范围：Phase 0 全部 17 项修复（A 遗留 6 + B 新发现 10 + 规范归档 1）
> 状态：**✅ 完成**（190 测试全绿 + typecheck 0 + build 通过）

## 一、修复清单（17 项全部完成）

### A. MVP-2.5 遗留（6 项）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| A1 (S2) | chain-runner signal 假中止 | controller 外部创建 + STOP watcher 实时传播 + 阶段边界同步兜底 | ✅ chain-runner.spec |
| A2 (S3) | setInterval 未 ctx.effect | 插件级兜底（effect 存在时注册，无 effect 环境跳过） | ✅ |
| A3 (S5) | resolveNextNode 未复用 | state-graph 声明式边统一调用 resolveNextNode | ✅ |
| A4 (S10) | 无整体超时 → 暂停机制 | 状态机 running/paused/stopped + PAUSE/RESUME + 三层配置 + pause-state.json | ✅ mvp3-phase0.spec |
| A5 (M12) | checkpoint.read 吞错 | 区分 ENOENT（null）与解析错误（抛错） | ✅ |
| A6 (L9) | terminal-view 时间语义 | formatTime 用 startedAt（相对图开始，与 html-report 对齐） | ✅ |

### B. MVP-3 前置新发现（10 项）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| NEW-1 | 深层原型污染 | deepMergeObjects 用 Object.create(null) + DANGEROUS_KEYS | ✅ mvp3-phase0.spec |
| NEW-2 | loopUsage 恢复未接通 | RunOptions.initialLoopUsage + run() 初始化 | ✅ |
| NEW-3 | cond handler 未 try/catch | handler 内 try/catch + 记日志 | ✅ |
| NEW-4 | cond 全不满足语义 | 引入 SKIP 常量（显式跳过走静态边） | ✅ |
| NEW-5 | 字段不存在报错不直观 | 类型白名单 + 缺失字段返回 null（自然 false） | ✅ |
| NEW-6 | new Function 注入风险 | 表达式 ≤2000 字符 + 字段字符串 ≤10000 + 类型白名单 | ✅ |
| NEW-7 | graphVersion 参数重复 | createCheckpointCallback 从 payload 读（单一来源） | ✅ |
| NEW-8 | mock 未同步 S13 | mock handler 调 reportTokenUsage/reportRetry | ✅ |
| NEW-9 | terminal-view 订阅泄漏 | 保存 unsubscribe 并在 stop 调用 | ✅ |
| NEW-10 | currentRole 未接通 | addNode 加 meta + node-start 带 role | ✅ |

### C. 规范归档（1 项）

- `docs/MVP-3/规范约束.md`：R1-R43 完整提炼

## 二、G0 门禁检查

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 17 项修复全部完成 | ✅ |
| 2 | typecheck 0 error | ✅ |
| 3 | 全量测试 ≥188 | ✅ 190（178 + 新增 12） |
| 4 | 终端视图 Token/retry 非 0 | ✅（S13 + NEW-8 使 mock 上报数据） |
| 5 | 热重载无泄漏 | ✅（A2 插件级集合） |
| 6 | 深层原型污染防护 | ✅ NEW-1 单测 |
| 7 | 暂停机制生效 | ✅ PAUSE → 暂停 → RESUME → 恢复（单测） |
| 8 | 超时可配置 | ✅ onTimeout pause/stop 双测 |

## 三、暂停/恢复机制（A4 核心交付）

| 操作 | 命令 | 效果 |
|---|---|---|
| 主动暂停 | `New-Item productions\PAUSE` | 当前步骤完成后进入暂停 |
| 恢复 | `New-Item productions\RESUME` | 从暂停点继续 |
| 终止 | `New-Item productions\STOP` | 立即（阶段边界）终止 |
| 查看暂停状态 | `Get-Content productions\pause-state.json` | 原因 + 进度 + nextRoleId |

**配置优先级**：代码 > `chain-config.json` > 环境变量 > 默认

---
**关联**：`docs/MVP-3/MVP-3task.md`、`docs/MVP-3/规范约束.md`、`tests/l2-engine/mvp3-phase0.spec.ts`

---

## 四、Phase A 完成情况（追加 2026-09-23）

| 任务 | 交付物 | 结果 |
|---|---|---|
| P3.A.1 | state-graph addSubagent（真实 ctx.subagents.start + 产物落盘 + upstream 摘要注入） | ✅ subagent-node.spec 4 用例 |
| P3.A.2 | lifecycle-manager（resident/on-demand/hybrid + prewarm + 活跃窗口） | ✅ lifecycle-manager.spec 5 用例 |
| P3.A.3 | run signal 贯通子代理 start（中断实时传播） | ✅ subagent-node.spec |

**GA 门禁**：addSubagent 已可被图节点执行真实 start；生命周期三模式决策可用；中断 signal 贯通。
（真实 LLM 端到端验证需隔离环境 + ollama-local，待环境就绪后补。）

---

## 五、Phase B 完成情况（追加 2026-09-23）

| 任务 | 交付物 | 结果 |
|---|---|---|
| P3.B.1 | message-bus（sendMessage 封装 + correlation_id/deadline/priority + 真实 sendImpl） | ✅ message-bus.spec |
| P3.B.2 | wait-for（waitFor/wakeUp Promise 唤醒，不用轮询 + 超时/中止） | ✅ |
| P3.B.3 | deadlock-guard（重试≤2 / 同链路≥3 终止 / 工作流超时降级审批） | ✅ |

**GB 门禁**：消息中转封装可用；等待唤醒 Promise 实现；死锁检测三规则生效（单测）。
