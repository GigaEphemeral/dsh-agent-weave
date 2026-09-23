/**
 * MVP-1 演示链定义（P1.2.1）。
 *
 * 六角色串行：R1 需求 → R2 架构 → R4 详细设计 → R6 开发 → R7 测试 → R8 质量审核。
 * 每步 prompt 只携带上游「摘要 + 文件路径」，不传全文（记忆隔离 + 上下文控制）。
 *
 * 🐛 修复记录（2026-09-22）：原 prompt 硬编码「核心代码实现（TypeScript）」+
 *    「直接输出 Markdown 文档内容」，导致 R6 走 TS 工程流程（反复勘察
 *    node/npm/tsc 环境，5+ 步无产出、11 万 token）。现改为：
 *    ① 技术栈中性（按上游设计的技术选型）
 *    ② 强行为约束（禁止探索环境/列目录/检查工具链/跑构建命令）
 *    ③ 产物形态明确（R6 产出可运行 index.html）
 *    ④ 单轮完成（适配慢速本地模型，避免多轮工具往返）
 */
import type { ChainStep } from './chain-runner.js'

/** 所有角色共用的硬性行为约束（防跑偏 + 省 token，适配慢模型）。 */
const HARD_RULES = `
【硬性约束（必须遵守）】
- 直接产出内容，一次性完成；不要分多步、不要反复推敲。
- 禁止探索环境：不要列目录、不要读项目源码、不要检查工具链版本（node/npm/tsc/git 等）。
- 禁止运行构建/测试命令；禁止无谓的工具调用。
- 只输出产物本身，不要输出「已保存到…」「以下是…」之类的说明性文字。`

/** 构造 MVP-1 演示链。 */
export function buildMvp1Chain(): readonly ChainStep[] {
  return [
    {
      roleId: 'R1-requirement',
      artifactName: 'prd.md',
      phase: '需求分析',
      prompt: ({ userInput }) => `你是 R1 需求分析师。

用户需求（原话）：
${userInput}

请直接产出需求分析（PRD），包含：
1. 目标与范围（In / Out）
2. 核心功能清单（逐条可验收）
3. 验收基线（可量化）
4. 边界条件与假设
${HARD_RULES}

直接输出 Markdown 文档内容。`,
    },
    {
      roleId: 'R2-architect',
      artifactName: 'arch.md',
      phase: '架构设计',
      prompt: ({ upstream }) => {
        const prd = upstream.find((u) => u.roleId === 'R1-requirement')
        return `你是 R2 架构师。

PRD 摘要：
${prd?.summary ?? '（无上游产物）'}
完整 PRD 路径：${prd?.path ?? 'N/A'}

请直接产出架构方案，包含：
1. 技术选型（按需求确定，不要预设技术栈）
2. 模块/结构划分与职责
3. 关键数据模型或状态设计
4. 风险与缓解
${HARD_RULES}

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

架构摘要：
${arch?.summary ?? '（无上游产物）'}
完整架构路径：${arch?.path ?? 'N/A'}

请直接产出详细设计，包含：
1. 实现要点与关键接口/函数签名
2. 测试要点（正常/边界/异常）
3. 验收对照（对应 PRD 验收基线）
${HARD_RULES}

直接输出 Markdown 文档内容。`
      },
    },
    {
      roleId: 'R6-developer',
      artifactName: 'index.html',
      phase: '开发实现',
      prompt: ({ upstream }) => {
        const design = upstream.find((u) => u.roleId === 'R4-designer')
        return `你是 R6 开发者。

设计摘要：
${design?.summary ?? '（无上游产物）'}
完整设计路径：${design?.path ?? 'N/A'}

请直接产出**核心可运行的 Python 后端代码**（按上游设计确定的技术形态），重点：
- 输出 ${'`'}backend.py${'`'}：一个自包含 Python 3 标准库后端（http.server + sqlite3 + urllib），
  实现全部 REST API（/api/etfs、/api/sync/today、/api/history/init、/api/history/status、
  /api/screen、/api/calendar、/api/backfill、/api/kline）+ 静态文件服务。
- 数据源：东方财富 push2 拉 ETF 全列表（fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024，fields=f12,f14,f2,f15,f16,f17,f18），
  腾讯 qt.gtimg.cn 实时行情（GBK，字段3=收盘、5=开盘），腾讯 web.ifzq.gtimg.cn 历史日K（qfqday 数组）。
- SQLite 表：etf_meta(code,name,market) + etf_daily(code,trade_date,open,close)。
- 规则引擎：JSON 规则 {type: consecutive_up|consecutive_down|up_then_down, n, lookback}，内存计算连涨/连跌。
- 输出纯代码，**不要用 Markdown 代码块包裹**，不要任何说明文字；单文件、可直接 python 运行。
${HARD_RULES}

现在直接输出代码。`
      },
    },
    {
      roleId: 'R7-tester',
      artifactName: 'report.md',
      phase: '测试验证',
      prompt: ({ upstream }) => {
        const dev = upstream.find((u) => u.roleId === 'R6-developer')
        return `你是 R7 测试员。

实现摘要：
${dev?.summary ?? '（无上游产物）'}
完整实现路径：${dev?.path ?? 'N/A'}

请直接产出测试报告，包含：
1. 测试用例清单（正常 / 边界 / 异常）
2. 预期结果与判定依据
3. 验收基线对照（对应 PRD）
4. 结论（通过 / 不通过 + 理由）
${HARD_RULES}

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

测试报告摘要：
${test?.summary ?? '（无上游产物）'}
完整测试报告路径：${test?.path ?? 'N/A'}

请直接产出质量审核报告，包含：
1. 问题清单（P0 阻断 / P1 记录 / P2 可选）
2. 门禁判定（通过 / 不通过）
3. 结论与建议
${HARD_RULES}

直接输出 Markdown 文档内容。`
      },
    },
  ]
}
