/**
 * MVP-1 演示链定义（P1.2.1）。
 *
 * 六角色串行：R1 需求 → R2 架构 → R4 详细设计 → R6 开发 → R7 测试 → R8 质量审核。
 * 每步 prompt 只携带上游「摘要 + 文件路径」，不传全文（记忆隔离 + 上下文控制）。
 */
import type { ChainStep } from './chain-runner.js'

/** 构造 MVP-1 演示链。 */
export function buildMvp1Chain(): readonly ChainStep[] {
  return [
    {
      roleId: 'R1-requirement',
      artifactName: 'prd.md',
      phase: '需求分析',
      prompt: ({ userInput }) => `你是 R1 需求分析师。
用户需求：${userInput}

请产出需求分析文档（PRD），包含：
1. 目标与范围（In/Out）
2. 核心功能清单
3. 验收基线（可量化）
4. 边界条件与假设

直接输出 Markdown 文档内容。`,
    },
    {
      roleId: 'R2-architect',
      artifactName: 'arch.md',
      phase: '架构设计',
      prompt: ({ upstream }) => {
        const prd = upstream.find((u) => u.roleId === 'R1-requirement')
        return `你是 R2 架构师。
基于 PRD 设计架构方案。

PRD 摘要：${prd?.summary ?? '（无上游产物）'}
完整 PRD 见：${prd?.path ?? 'N/A'}

请产出架构文档，包含：
1. 模块划分与职责
2. 核心数据模型/类型
3. 关键接口契约
4. 风险与缓解

直接输出 Markdown 文档内容。`
      },
    },
    {
      roleId: 'R4-designer',
      artifactName: 'design.md',
      phase: '详细设计',
      prompt: ({ upstream }) => {
        const arch = upstream.find((u) => u.roleId === 'R2-architect')
        return `你是 R4 详细设计师。
基于架构方案细化设计。

架构摘要：${arch?.summary ?? '（无上游产物）'}
完整架构见：${arch?.path ?? 'N/A'}

请产出详细设计文档，包含：
1. 接口签名与参数边界
2. 测试方案（L1-L4 分层 + golden case）
3. 异常与边界处理

直接输出 Markdown 文档内容。`
      },
    },
    {
      roleId: 'R6-developer',
      artifactName: 'README.md',
      phase: '开发实现',
      prompt: ({ upstream }) => {
        const design = upstream.find((u) => u.roleId === 'R4-designer')
        return `你是 R6 开发者。
按详细设计实现功能。

设计摘要：${design?.summary ?? '（无上游产物）'}
完整设计见：${design?.path ?? 'N/A'}

请产出实现产物，包含：
1. 核心代码实现（TypeScript）
2. 关键文件说明
3. 构建与运行方式

直接输出 Markdown 文档内容。`
      },
    },
    {
      roleId: 'R7-tester',
      artifactName: 'report.md',
      phase: '测试验证',
      prompt: ({ upstream }) => {
        const dev = upstream.find((u) => u.roleId === 'R6-developer')
        return `你是 R7 测试员。
对开发产物执行测试验证。

实现摘要：${dev?.summary ?? '（无上游产物）'}
完整实现见：${dev?.path ?? 'N/A'}

请产出测试报告，包含：
1. 测试范围与用例清单
2. 执行结果（通过/失败）
3. 失败复现路径
4. 回归基线对比

直接输出 Markdown 文档内容。`
      },
    },
    {
      roleId: 'R8-quality',
      artifactName: 'review.md',
      phase: '质量审核',
      prompt: ({ upstream }) => {
        const test = upstream.find((u) => u.roleId === 'R7-tester')
        return `你是 R8 质量审核员。
对整个交付物链做最终质量审核。

测试报告摘要：${test?.summary ?? '（无上游产物）'}
完整测试报告见：${test?.path ?? 'N/A'}

请产出质量审核报告，包含：
1. P0/P1/P2 分级问题清单
2. 门禁判定（通过/不通过）
3. 结论与建议

直接输出 Markdown 文档内容。`
      },
    },
  ]
}
