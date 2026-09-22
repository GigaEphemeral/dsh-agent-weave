# MVP-1 过程文档索引

> 用途：MVP-1 阶段的过程管理文档总入口｜更新：2026-09-22
> 状态：**MVP-1 ✅ 完成**（12 任务 + 四项门禁全部通过）

## 📌 先读这两份

| 文档 | 内容 |
|---|---|
| **[MVP-1阶段总结与遗留.md](MVP-1阶段总结与遗留.md)** | 完成情况 / 交付物索引 / **遗留坑 7 条** / 给 MVP-2 的输入 |
| **[MVP-1测试记录-井字棋.md](MVP-1测试记录-井字棋.md)** | 真实 LLM 端到端测试记录（时间线/产物/token/门禁验收） |

## 📚 全部文档

### 设计与实现
| 文档 | 内容 |
|---|---|
| [实现逻辑总览.md](实现逻辑总览.md) | 主线六步、模块职责、关键契约（D-001）、工具最小权限、可观测性、产物形态 |

### 环境与操作
| 文档 | 内容 |
|---|---|
| [隔离环境启动手册.md](隔离环境启动手册.md) | mock / 真实 LLM 两种模式启动、打包安装、常见问题 7 条 |
| [验证操作指南.md](验证操作指南.md) | 人工验收步骤（发消息 → 观察节点树 → 检查产物） |
| [链执行监控与停止.md](链执行监控与停止.md) | **用户自助**：实时日志、心跳判读、STOP 中止 |

### 测试
| 文档 | 内容 |
|---|---|
| [自测逻辑说明.md](自测逻辑说明.md) | 56 单测矩阵、隔离环境验证层次、门禁复验流程 |
| [MVP-1测试记录-井字棋.md](MVP-1测试记录-井字棋.md) | 端到端实测记录 |

### 复盘
| 文档 | 内容 |
|---|---|
| [踩坑记录.md](踩坑记录.md) | **12 条坑**（症状 → 根因 → 解决 → 教训） |

## 🗂 相关（process/ 之外）

| 文档 | 位置 |
|---|---|
| 验证报告（四项门禁） | `docs/MVP-1/验证报告-单链闭环.md` |
| 契约决策记录 | `docs/decisions/D-001-subagent-provider-contract.md` |
| 环境验证报告 | `docs/env-verification.md` |
| MVP-1 设计 / 任务清单 | `docs/MVP-1/0-设计.md`、`docs/MVP-1/1-DevTask.md` |

## 🚦 快速上手（复验用）

```powershell
# 1. 启动隔离 web（详见 隔离环境启动手册）
$creds = Get-Content "D:\dsharness\data\.credentials.yaml" -Raw
$env:HUOSHAN_186_API_KEY = [regex]::Match($creds, 'HUOSHAN_186_API_KEY:\s*(\S+)').Groups[1].Value
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-test --no-open --port 3081

# 2. 另开窗口看实时日志（零 token）
& 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\watch-chain.ps1'

# 3. 需要中止时
& 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\stop-chain.ps1'
```

产物位置：`D:\dsharness\agentDev\softwareEngnieering\productions\<角色ID>\`
（R6 产出 `index.html`，可直接双击运行）
