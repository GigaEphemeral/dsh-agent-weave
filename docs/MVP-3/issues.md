# MVP-3 遗留问题清单（issues）

> 版本：v1（2026-09-23）｜来源：`3-ParseBtestFix.md` 处理结果 + 后续规划

## 已处理（问题 1-4）

| # | 问题 | 处理 | 状态 |
|---|---|---|---|
| 1 | 角色注册/图加载混淆 | 澄清：注册一次性；图加载每次（YAML 可变）；"重复"是 spawn 等待日志 | ✅ 已答 |
| 2 | 无真实图执行入口 | 新增 `weave_run_graph` 工具（loadGraphSpec→validate→addSubagent→run） | ✅ P0 已修 |
| 3 | 日志 UTC | chainLog 改东八区 ISO 带偏移（R44）；内部仍 epoch | ✅ P0 已修 |
| 4 | 产物落 cwd | `weave_run_graph` 支持 `output_dir` 显式参数；默认 cwd 兜底（R45） | ✅ P0 已修 |

## 规划中（问题 5：节点活动日志——"在干什么"）

### 已落地（通道 C：prompt 行为约束）

- `addSubagent` 默认 prompt 增加行为约束：子代理每次调用工具前输出 `[动作] 正在 <做什么>（工具: <toolName>）`
- 零成本、实时（流式输出可见）；缺点：模型不一定严格遵守、占少量 token

### 规划项（通道 B：tail 子代理 session 事件，P3.A.5 后置）

- **目标**：从子代理 session 日志（`session.v3.jsonl.zstd`）读取 `tool/call` / `assistant/message` 事件，
  转成人类可读 activity 行写入 `chain.log` 或 trace：
  ```
  [18:30:16] 💭 R6 思考中（输入 1500 tok）
  [18:30:18] 🔧 R6 调用 glob（搜索 *.py）
  [18:30:19] ✓ glob 返回 5 个文件
  [18:30:22] 🔧 R6 调用 read（读取 design.md）
  ```
- **难点**：需定位子代理 session 文件路径 + zstd 解压 + 增量 tail；有延迟（session 落盘后）
- **预估**：1.5d
- **价值**：让用户判断"正常工作中 / 卡死（活动不变超5min）/ 跑偏（工具不符角色）"

### 规划项（通道 A：全局事件订阅，备选）

- DSH 全局事件总线有 `tool/call` 事件（agent-loop 触发），但当前未确认 declare module 类型；
  session 事件通道（B）更可靠（FIX.4 已实测 session 结构）
- 若 B 落地后信息不足，再评估 A

## 规范补充

- **R44**：内部时间统一 epoch ms；展示层才转时区。日志时间戳用东八区 ISO 8601 带偏移。
- **R45**：禁止 `process.cwd()` 作为产物根。产物根优先级：显式参数 > `exec.workspace`（若可用）> `ctx` 会话工作区 > 兜底。

---
**关联**：`docs/MVP-3/3-ParseBtestFix.md`（问题来源）、`docs/MVP-3/规范约束.md`
