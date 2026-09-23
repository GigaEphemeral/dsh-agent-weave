# MVP-2 验收测试操作指南（人工验收）

> 状态：**MVP-2 开发完成，待人工验收** ｜ 2026-09-23
> 目标：验收 MVP-2 自研 StateGraph 引擎的 5 项用户门禁（G-FINAL）
> 环境：隔离运行（`test-env/dsh-home`），不污染主环境；**验收全程零 LLM 消耗**（mock 执行）

## 一、当前阶段与状态

| 项 | 状态 |
|---|---|
| **当前阶段** | MVP-2（自研 StateGraph 引擎）**已完成** ✅ |
| **下一步** | **你（验收人）进行 G-FINAL 手动验收** |
| 开发门禁 | GA/GB/GC/GD/GE 五阶段门禁全部通过（181 测试全绿 + 实机验证） |
| 一键脚本 | `test-env/verify-mvp2.ps1`（7/7 已通过） |
| 待你验收 | 下方 5 项用户门禁 |

## 二、环境信息

| 项 | 值 |
|---|---|
| 隔离 DSH_HOME | `3pluginCode/test-env/dsh-home`（主环境 `D:\dsharness\data` 零写入） |
| dsh bin | `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| profile | `weave-headless`（headless 一次性任务；验收无需浏览器） |
| LLM | **mock / 无**（图命令 `validate/show` 纯校验零 LLM；`watch/report` mock 执行零 LLM） |
| 工作流样例 | `workflows/mvp2-loop-demo.yaml`（含循环）、`workflows/visual-demo.yaml`（可视化验收） |

## 三、一键自动验收（先跑这个）

```powershell
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
.\test-env\verify-mvp2.ps1
```

**7 项自动检查**：

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 类型检查 | `tsc --noEmit` 0 error |
| 2 | 单元测试 | 168 用例全绿 |
| 3 | 集成测试 | 13 用例全绿（含循环端到端/版本恢复/热重载） |
| 4 | 构建 | `lib/` 生成无错误 |
| 5 | 零 LLM | 测试代码无 `ctx.llm.*` 调用 |
| 6 | 图校验命令 | `weave_graph_validate` 可用 |
| 7 | HTML 报告 | `reports/graph-*.html` 生成 |

## 四、手动验收 5 项（用户门禁）

### 第 1 项：图可编辑（YAML + CLI 校验/查看）

① 用记事本/VSCode 打开并编辑（可改 `maxIter` 或加节点）：

```powershell
notepad workflows\mvp2-loop-demo.yaml
```

② 校验（合法图应通过）：

```powershell
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
$dshBin = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $dshBin --profile weave-headless "请调用 weave_graph_validate 工具，参数 path 为 workflows/mvp2-loop-demo.yaml，原样输出结果"
# 预期：✅ 图校验通过（或明确列出错误：entryPoint 不存在/边引用缺失等）
```

③ 查看 ASCII 图：

```powershell
node $dshBin --profile weave-headless "请调用 weave_graph_show 工具，参数 path 为 workflows/mvp2-loop-demo.yaml，原样输出结果"
# 预期：入口/主链/loop 回退/cond 条件/节点详情
```

**通过标准**：YAML 编辑 + validate + show 全部可用；改坏文件时 validate 报错并指明位置。

### 第 2 项：图支持循环与条件分叉

```powershell
node $dshBin --profile weave-headless "请调用 weave_graph_watch 工具，参数 path 为 workflows/visual-demo.yaml，原样输出结果"
```

**预期看到**：

```
当前节点: ... | 迭代: x/25 | retry: x/3 | 耗时: x s | Token: xxx [running]
  [00:00] 💾 checkpoint 已写入 @start iter=1
  [00:00] ✓ start 完成 (0.3s, xxx tokens)
  [00:00] ✓ build 完成 ...
  [00:00] ⚠ 回退到 build (2/3)        ← loop 边回退
  ...
  [00:00] ✓ done 完成 ...
✅ 图执行成功
```

**通过标准**：看到节点推进、`loop` 回退（⚠）、`cond` 升级到 approval、最终 ✅ 成功——**循环与条件分叉均生效**。

### 第 3 项：死循环控制（三层熔断）

```powershell
# 造一个会死循环的图：把 maxIter 与 maxIterations 调大
Copy-Item workflows\mvp2-loop-demo.yaml workflows\test-infinite.yaml
# 编辑 test-infinite.yaml：loop 边 maxIter 改 100，maxIterations 改 100

node $dshBin --profile weave-headless "请调用 weave_graph_watch 工具，参数 path 为 workflows/test-infinite.yaml，原样输出结果"
```

**预期看到**：

```
⚠ 全局迭代已达 20/25（80%），疑似循环    ← 80% 黄色告警（T14）
✗ 全局迭代熔断：已达上限 25，执行终止      ← 100% 红色熔断（T9/T14）
❌ ... 迭代次数超过上限 ...
```

**通过标准**：达到 80% 出黄色告警；达到 100% 红色熔断 + 程序终止（**不死循环**）。

### 第 4 项：实时可视化（终端视图）

第 2 项中已覆盖。**重点观察**：

| 观察点 | 说明 |
|---|---|
| 当前节点 | 显示正在执行的节点（哪个 subagent 在工作） |
| 迭代 | `x/25` 实时更新 |
| retry_count | `x/3` 显示循环回退进度 |
| 耗时/Token | 累计执行时长与 token |
| 事件流 | ▶ 开始（绿）/ ✓ 完成（蓝）/ ⚠ 回退（黄）/ ✗ 错误（红）逐行滚动 |

**通过标准**：运行时能看到"现在是哪个节点 + 工作到什么程度"。

### 第 5 项：复盘可视化（HTML 报告）

```powershell
node $dshBin --profile weave-headless "请调用 weave_graph_report 工具，参数 path 为 workflows/visual-demo.yaml，原样输出结果"
start reports\graph-*.html
```

**预期看到 4 个 section**：

| Section | 内容 |
|---|---|
| **执行摘要** | 状态 / 迭代次数 / 总耗时 / 总 Token / retry |
| **图结构** | SVG 图，节点按状态染色（绿=完成 黄=运行 红=失败 灰=闲置） |
| **事件时间线** | 完整事件流（checkpoint/节点/回退）可滚动 |
| **Token 分账** | 按节点的输入/输出/缓存读/合计表 |

**通过标准**：浏览器打开报告，4 个 section 完整，图节点按状态染色。

## 五、验收对照表（G-FINAL 5 项）

| # | 门禁 | 验证方式 | 通过标准 | 签署 |
|---|---|---|---|---|
| 1 | **图可编辑** | 第 1 项 | YAML 编辑 + validate + show 全部可用 | ☐ |
| 2 | **图支持循环与条件分叉** | 第 2 项 | loop 边 + cond 边生效 | ☐ |
| 3 | **死循环控制** | 第 3 项 | 三层熔断生效 + 告警正确 | ☐ |
| 4 | **实时可视化** | 第 4 项 | 终端实时显示当前节点/迭代/retry/耗时/Token | ☐ |
| 5 | **复盘可视化** | 第 5 项 | HTML 报告 4 section 完整 | ☐ |

```
验收日期：2026-____-____
验收人：_____________
结论：☐ 全部通过 / ☐ 有条件通过 / ☐ 未通过
备注：_____________
```

## 六、验收记录（开发侧已跑通）

| 命令 | 结果（2026-09-23 实测） |
|---|---|
| `verify-mvp2.ps1` | ✅ 7/7 通过 |
| `weave_graph_validate` (visual-demo) | ✅ 图校验通过 |
| `weave_graph_show` | ✅ ASCII 图完整 |
| `weave_graph_watch` | ✅ 事件流 + 熔断告警 + 成功结束 |
| `weave_graph_report` | ✅ HTML 4 section 生成 |

> 完整开发验证记录见 `docs/MVP-3/MVP-2阶段总结.md` §三。

## 七、问题排查

| 现象 | 原因/处理 |
|---|---|
| 图校验报「角色未注册」 | 隔离 headless 缺 spawn provider（角色未注册）；这是**预期正确行为**（静态验证器检测到）。用 `workflows/visual-demo.yaml`（无 roleRef）验收循环/可视化；role 子代理执行属 MVP-3 |
| `weave_graph_watch` 输出为空 | 确认 profile 是 `weave-headless` 且插件已装（`dsh plugin add ./dist/dsh-agent-weave-0.1.0.tgz`） |
| HTML 报告未生成 | 检查 `reports/` 目录与输出路径；headless 环境限制时用 `weave_graph_report` 手动验证 |
| 想中止验证 | 告诉我，我停后台任务（产物保留） |

## 八、隔离性保证

- 环境使用独立 `DSH_HOME`（`test-env/dsh-home`），与主环境（`D:\dsharness\data`）完全隔离
- 验收全程 **mock / 零 LLM**（图命令纯校验 + mock 执行），不消耗 token
- 测试数据（session 日志、`reports/`、`workflows/`）按规则保留不清理

---
**关联**：`docs/MVP-3/MVP-2阶段总结.md`、`docs/MVP-2/0-详细设计.md`、`docs/MVP-2/1-DevTask.md`（第七部分一键验收）
