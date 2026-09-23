# MVP-2 真实环境可视化验收测试操作指南

> 状态：**真实测试环境已启动** ｜ 2026-09-23
> 目标：在**隔离的 DSH web 环境**（ollama-local 本地模型，零真实 token 成本）可视化验收
>       StateGraph 引擎的图执行过程——看到**每个节点跑的情况**
> 环境：隔离 `test-env/dsh-home`，与主环境 `D:\dsharness\data` 完全隔离

## 一、环境信息（当前已就绪）

| 项 | 值 |
|---|---|
| **web 访问地址** | `http://127.0.0.1:3081/?token=KuOkAghMhtnYTZTW0KV5Fxc5dWCBHL_ogxA5ERb4qVQ` |
| 隔离 DSH_HOME | `3pluginCode/test-env/dsh-home`（主环境零写入） |
| profile | `weave-test`（web 全量） |
| **模型** | **ollama-local / Qwen3.5:9B**（本地 `localhost:11434`，**零真实 token 成本**） |
| 插件 | `dsh-agent-weave@0.1.0`（已清理重装，含 6 个 weave 工具） |
| 工作流样例 | `workflows/mvp2-loop-demo.yaml`（含循环）、`workflows/visual-demo.yaml`（可视化验收） |
| 已注册角色 | 6 个（R1/R2/R4/R6/R7/R8；本轮 spawn 缺失时跳过，图命令不受影响） |

> 已确认 ollama 运行中（`http://localhost:11434/api/tags` 200，含 Qwen3.5:9B）。
> web 已启动且 6 个图命令注册成功（boot 日志见 `MVV-2 图引擎与命令就绪`）。

## 二、可视化验收要看的核心（用户目标）

**"看到图里每个节点跑的情况"** —— 三种观测通道，任选：

| 通道 | 形式 | 能看到什么 | 适合 |
|---|---|---|---|
| **A. web chat** | 浏览器对话 | 工具调用卡片 + 返回的完整事件流文本 | 交互式验收 |
| **B. tail 日志** | PowerShell 窗口 | 会话日志实时滚动（每节点事件一行） | 后台持续观测 |
| **C. 终端直跑** | PowerShell | `weave_graph_watch` 直接输出节点事件流 | 快速验证 |

每种通道都能看到：**当前节点 / 迭代次数 / retry / 耗时 / Token / checkpoint / 熔断告警**。

## 三、通道 A：web chat 可视化验收（推荐）

### 第 1 步：打开 web 界面

浏览器打开上方访问地址。侧栏应显示隔离测试环境（weave-test）。

### 第 2 步：触发图执行（发送消息）

在 chat 输入框发送（**明确要求调用工具**）：

```
请调用 weave_graph_watch 工具，参数 path 为 workflows/visual-demo.yaml，并完整输出工具返回的终端视图文本
```

> 主 Agent 使用 ollama-local（本地模型）驱动工具调用，**不消耗真实 token**。

### 第 3 步：观察节点执行情况

预期在回复中看到完整事件流（每个节点一行）：

```
当前节点: (启动中) | 迭代: 0/25 | retry: 0/3 | 耗时: 0s | Token: 0 [running]
  [00:00] · 图开始: graph-xxxx
  [00:00] 💾 checkpoint 已写入 @start iter=1
  [00:00] ✓ start 完成 (0.3s, 508 tokens)
  [00:00] 💾 checkpoint 已写入 @build iter=2
  [00:00] ✓ build 完成 (0.3s, 458 tokens)
  [00:00] ⚠ 回退到 check (2/3)          ← loop 回退
  ...
  [00:00] ✓ done 完成 (0.3s, 570 tokens)
✅ 图执行成功
```

**观察点**：

| 观察点 | 说明 |
|---|---|
| ① 每个节点 | `▶ 节点开始` → `✓ 节点完成`，含耗时与 Token |
| ② checkpoint | 每节点 `💾 checkpoint 已写入 @<节点> iter=<n>` |
| ③ 循环回退 | `⚠ 回退到 <节点> (x/maxIter)` |
| ④ 熔断告警 | 80% 黄色 `⚠` / 100% 红色 `✗` |
| ⑤ 状态头 | 当前节点 / 迭代 / retry / 耗时 / Token 实时更新 |

### 第 4 步：生成 HTML 复盘报告

```
请调用 weave_graph_report 工具，参数 path 为 workflows/visual-demo.yaml，并输出报告路径
```

然后浏览器打开返回的 `reports/graph-*.html`：
- **执行摘要**：状态 / 迭代 / 耗时 / Token
- **图结构**：SVG 节点按状态染色（绿=完成 黄=运行 红=失败 灰=闲置）
- **事件时间线**：完整事件流
- **Token 分账**：按节点输入/输出/缓存/合计

## 四、通道 B：tail 日志实时观测（任务进度）

**引擎每次图执行都会把事件流落盘到 `productions/traces/graph-<id>.jsonl`**（S9 修复），
这是**任务进度最直接的观测点**——每个节点的开始/完成/回退/checkpoint 都是独立 JSON 行。

### 方式 1：tail -f 实时跟随（推荐）

在**另一个 PowerShell 窗口**运行（零 token，纯读日志）：

```powershell
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
# 实时跟随最新 trace 文件（图执行时逐行追加）
Get-ChildItem productions\traces\graph-*.jsonl | Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 | ForEach-Object { Get-Content $_.FullName -Encoding UTF8 -Wait -Tail 20 }
```

**预期看到**（每个节点一行）：
```
{"type":"graph/node-start","graphId":"graph-xxx","node":"start",...}
{"type":"graph/node-end","graphId":"graph-xxx","node":"start","durationMs":300,"data":{"tokenUsed":508},...}
{"type":"graph/checkpoint-written","graphId":"graph-xxx","node":"start",...}
{"type":"graph/loop-iteration","graphId":"graph-xxx","node":"check","data":{"iteration":1,"from":"check","to":"done"},...}
```

### 方式 2：weave_graph_tail 工具（web chat / headless）

```
请调用 weave_graph_tail 工具，参数 lines 为 20，原样输出结果
```
返回最近 N 条事件 + 文件路径。

### 方式 3：看 web 启动窗口日志

web 启动窗口（后台 job）的实时日志会打印每次图执行的引擎事件。

> **进度观测要点**：`node-start` 出现 = 该节点开始工作；`node-end` 出现 = 完成（含耗时/Token）；
> `loop-iteration` = 回退发生；`checkpoint-written` = 状态已落盘（可恢复）。

## 五、通道 C：终端直跑（快速验证）

无需浏览器，直接 PowerShell 跑（ollama-local 驱动主 Agent 调用工具）：

```powershell
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
$dshBin = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode

# ① 校验图
node $dshBin --profile weave-headless "请调用 weave_graph_validate 工具，参数 path 为 workflows/visual-demo.yaml，原样输出结果"

# ② 查看 ASCII 图结构
node $dshBin --profile weave-headless "请调用 weave_graph_show 工具，参数 path 为 workflows/visual-demo.yaml，原样输出结果"

# ③ 实时执行视图（核心：看每个节点跑的情况）
node $dshBin --profile weave-headless "请调用 weave_graph_watch 工具，参数 path 为 workflows/visual-demo.yaml，原样输出结果"

# ④ HTML 报告
node $dshBin --profile weave-headless "请调用 weave_graph_report 工具，参数 path 为 workflows/visual-demo.yaml，原样输出结果"
```

## 六、验收对照表（5 项用户门禁）

| # | 门禁 | 验证动作 | 通过标准 | 签署 |
|---|---|---|---|---|
| 1 | **图可编辑** | 通道 A/C 步骤①② | YAML 编辑 + validate + show 可用 | ☐ |
| 2 | **图支持循环与条件分叉** | 通道 A 步骤③ | 看到 loop 回退 ⚠ + cond 升级 | ☐ |
| 3 | **死循环控制** | 造 test-infinite.yaml 后 watch | 80% 黄告警 + 100% 红熔断 + 终止 | ☐ |
| 4 | **实时可视化** | 通道 A 步骤③ | 终端/web 实时显示当前节点/迭代/retry/耗时/Token | ☐ |
| 5 | **复盘可视化** | 通道 A 步骤④ | HTML 报告 4 section 完整 | ☐ |

```
验收日期：2026-____-____
验收人：_____________
结论：☐ 全部通过 / ☐ 有条件通过 / ☐ 未通过
备注：_____________
```

## 七、死循环告警专项验证

```powershell
# 造死循环图
Copy-Item workflows\visual-demo.yaml workflows\test-infinite.yaml
# 编辑 test-infinite.yaml：loop 边 maxIter 改 100，maxIterations 改 100

# web chat 或终端：
# "请调用 weave_graph_watch 工具，参数 path 为 workflows/test-infinite.yaml，原样输出结果"
```

**预期**：

```
⚠ 全局迭代已达 20/25（80%），疑似循环    ← 80% 黄色
✗ 全局迭代熔断：已达上限 25，执行终止      ← 100% 红色 + 终止
❌ 迭代次数超过上限...
```

## 八、问题排查

| 现象 | 原因/处理 |
|---|---|
| web 打不开 / 401 | token 需完整复制；确认后台 job 在运行（`job_list`） |
| 图校验报「角色未注册」 | 隔离 profile 缺 spawn provider（角色未注册）；这是**预期正确行为**。用 `visual-demo.yaml`（无 roleRef）验收；role 子代理执行属 MVP-3 |
| 主 Agent 不调用工具 | 明确说「请调用 weave_graph_watch 工具」；ollama 本地模型响应较慢（几十秒），请耐心等待 |
| ollama 模型响应慢/超时 | 本地 9B 模型推理需要时间；可换 `qwen2.5:14b`（settings 允许列表内）或减少节点数 |
| 想停止测试环境 | 告诉我，我 kill 后台 job（数据保留） |

## 九、隔离性保证

- 环境用独立 `DSH_HOME`（`test-env/dsh-home`），主环境零写入
- **模型 = ollama-local 本地推理，零真实 token 成本**
- 测试数据（sessions/、reports/、workflows/）保留不清理

---
**关联**：`docs/MVP-3/MVP-2阶段总结.md`、`docs/MVP-3/MVP-2验收测试操作指南.md`（mock 版）、`docs/MVP-2/0-详细设计.md`
