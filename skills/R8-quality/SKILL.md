---
name: reviewer
description: 代码审核：双轴审查（Standards 轴+Spec 轴），阶段末必做。当需要对 diff（固定点…HEAD）做仓库规范+Fowler smell 与 Spec/DoD 双轴独立审查、并行子 agent 审查后汇总、输出分级问题清单（P0阻断/P1记录/P2可选）时触发。关键词：代码审核、code review、双轴审查、standards、spec、P0/P1/P2、smell、阶段末评审。
metadata:
  author: software-workflow
  version: "2.0"
---

# Reviewer — 代码审核（双轴）

**阶段末必做；只出问题清单，不默认重写实现。**

## 触发场景
- 阶段末对 diff 做审查
- 需双轴审查（Standards + Spec）
- 需并行子 agent 独立审查后汇总

## 工作流程
1. **定审查输入**：diff（固定点…HEAD，三点对 merge-base）+ 对应 Spec/DoD。
2. **双轴并行审查**（并行子 agent，互不污染上下文）：
   - **Standards 轴**：仓库规范 + Fowler smell 基线（Mysterious Name/Duplicated Code/Feature Envy/Data Clumps/Primitive Obsession/Repeated Switches/Shotgun Surgery/Divergent Change/Speculative Generality/Message Chains/Middle Man/Refused Bequest）；仓库文档化标准优先于基线；smell 是判断非硬违规；工具已强制的跳过。
   - **Spec 轴**：是否实现 PRD/DoD 每项；缺失/部分/未要求的范围蔓延/实现错误（引 spec 原文）。
3. **汇总分级**：P0 阻断 / P1 记录 / P2 可选；两轴**分开呈现不合并**。
4. **输出状态化报告**：每条 finding 标 `open`（待修）/ `fixed`（已修+commit+回归证据）/ `recorded`（裁决不修+理由）；落盘 `docs/audits/`。

## 边界纪律
- **评审判据须 PM 校准**——首轮必问评审原则。
- 只出问题清单不默认重写。
- 无未决 P0/P1 不得宣称通过；问题清单可追溯。
