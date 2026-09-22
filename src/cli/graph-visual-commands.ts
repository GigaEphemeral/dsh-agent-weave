/**
 * CLI 可视化命令（MVP-2 T12/T13/T14 集成）。
 *
 * 注册 3 个 DSH 工具：
 *   - weave_graph_watch：运行图（mock 节点）+ 终端实时视图 + 循环告警
 *   - weave_graph_report：运行图 + 生成 HTML 执行报告（reports/<graphId>.html）
 *   - weave_graph_status：查看最近一次图执行状态快照
 *
 * 执行模式：MVP-2 引擎先跑纯 handler 节点；role 节点用 mock 子代理
 * （异步延迟 + 固定产出，零 LLM 消耗，供可视化验收）。MVP-3 接入真实 subagent。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { loadGraphSpec } from './graph-commands.js'
import { validateGraph } from '../l2-engine/static-validator.js'
import { createStateGraph } from '../l2-engine/state-graph.js'
import { createEventBus } from '../l4-visual/host/event-bus.js'
import { createTerminalView, formatStatusHeader } from '../l4-visual/host/terminal-view.js'
import { renderHtmlReport } from '../l4-visual/host/html-report.js'
import { createLoopDetector } from '../l4-visual/host/loop-detector.js'
import type { GraphDefinitionSpec } from '../l2-engine/types.js'

/** 最近一次执行的快照（供 status 工具查询）。 */
let lastSnapshot: ReturnType<typeof createEventBus>['getSnapshot'] extends () => infer S ? S : never = null as never

/** mock 延迟（毫秒）：模拟子代理执行耗时，便于观察实时视图。 */
const MOCK_NODE_DELAY_MS = 300

/**
 * 运行图（mock 模式）：解析 → 校验 → 构建引擎 → 执行 → 返回结果 + 轨迹。
 * 同时向传入的 bus 推送事件。
 */
export async function runGraphMock(ctx: Context, spec: GraphDefinitionSpec, bus: ReturnType<typeof createEventBus>) {
  const validation = validateGraph(spec, { registeredRoles: new Set(ctx.subagents.list()) })
  if (!validation.valid) {
    return { ok: false, message: `图校验失败:\n${validation.errors.map((e) => `  · ${e.path}: ${e.message}`).join('\n')}` }
  }

  const graph = createStateGraph<Record<string, unknown>>(
    ctx,
    spec.maxIterations ?? 25,
    8,
  )

  // 注册节点：role/condition 用 mock handler；approval 用审批门
  for (const node of spec.nodes) {
    if (node.nodeType === 'approval') {
      graph.addApprovalGate(node.id, { toolName: `weave_approve_${node.id}`, reason: `节点 ${node.id} 需审批` })
    } else {
      const nodeId = node.id
      const role = node.roleRef ?? node.nodeType
      graph.addNode(nodeId, async (state) => {
        await new Promise((r) => setTimeout(r, MOCK_NODE_DELAY_MS))
        const retryCount = ((state.retry_count as number | undefined) ?? 0) + 1
        return {
          messages: [{ role: 'mock', node: nodeId, at: Date.now() }],
          retry_count: retryCount,
          active_agent: role,
        }
      })
    }
  }

  // 边：seq/loop 走 addEdge；cond 转条件函数（基于 when 表达式字符串用 evaluateCondition）
  for (const edge of spec.edges) {
    if (edge.type === 'seq') {
      graph.addEdge(edge.from, edge.to)
    } else if (edge.type === 'loop') {
      graph.addEdge(edge.from, edge.to)
    } else if (edge.type === 'cond' && edge.when) {
      // cond 边：经 evaluateCondition 求值（从声明式 when 构建条件函数）
      const when = edge.when
      const to = edge.to
      graph.addConditionalEdge(edge.from, async (state) => {
        // 轻量求值：state.x 替换后 Function 求值（与 condition-edge.ts 白名单一致）
        const { evaluateCondition } = await import('../l2-engine/condition-edge.js')
        return evaluateCondition(when, state as Record<string, unknown>) ? to : '__END__'
      })
    }
  }

  // 事件桥接：引擎 emit 的 graph/* 事件 → 总线
  const checkpoint = async (payload: { graphId: string; graphVersion: string; graphSchemaHash: string; node: string; state: Record<string, unknown>; iteration: number; timestamp: number }) => {
    bus.handle({
      type: 'graph/checkpoint-written',
      graphId: payload.graphId,
      node: payload.node,
      timestamp: payload.timestamp,
      data: { iteration: payload.iteration, graphVersion: payload.graphVersion },
    })
    const tokens = Math.floor(Math.random() * 500) + 200
    bus.handle({
      type: 'graph/node-end',
      graphId: payload.graphId,
      node: payload.node,
      timestamp: payload.timestamp,
      durationMs: MOCK_NODE_DELAY_MS,
      data: { tokenUsed: tokens, retryCount: ((payload.state.retry_count as number | undefined) ?? 0) },
    })
  }

  const result = await graph.run({ messages: [], retry_count: 0, max_iterations: spec.maxIterations ?? 25 } as Record<string, unknown>, {
    checkpoint,
  })

  lastSnapshot = bus.getSnapshot()
  return { ok: result.success, message: result.error?.message ?? '图执行成功', graphId: result.graphId }
}

/** 注册 3 个可视化命令。 */
export function registerVisualCommands(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_watch',
        description:
          '运行 YAML 图（mock 节点，零 LLM）并输出终端实时视图：当前节点/迭代/retry/耗时/Token + 事件流 + 循环告警。',
        parameters: {
          path: { type: 'string', required: true, description: '图 YAML 文件路径' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args) {
          const spec = loadGraphSpec(args.path)
          const bus = createEventBus({ graphId: `graph-${Date.now()}`, maxIterations: spec.maxIterations ?? 25 })
          const detector = createLoopDetector()
          const output: string[] = []
          const capture = (line: string) => output.push(line)
          const view2 = createTerminalView(bus, capture)
          view2.start()
          detector.start(bus, (a) => capture(a.message))

          bus.handle({ type: 'graph/start', graphId: `graph-${Date.now()}`, timestamp: Date.now() })
          const r = await runGraphMock(ctx, spec, bus)
          view2.stop()

          const header = formatStatusHeader(bus.getSnapshot(), false)
          return [...output, '', header, '', r.ok ? `✅ ${r.message}` : `❌ ${r.message}`].join('\n')
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_report',
        description: '运行 YAML 图（mock）并生成 HTML 执行报告到 reports/<graphId>.html（4 section：摘要/SVG 图/时间线/Token 分账）。',
        parameters: {
          path: { type: 'string', required: true, description: '图 YAML 文件路径' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args) {
          const spec = loadGraphSpec(args.path)
          const graphId = `graph-${Date.now()}`
          const bus = createEventBus({ graphId, maxIterations: spec.maxIterations ?? 25 })
          bus.handle({ type: 'graph/start', graphId, timestamp: Date.now() })
          const r = await runGraphMock(ctx, spec, bus)
          const snap = bus.getSnapshot()
          const html = renderHtmlReport(snap, spec.edges.map((e) => ({ from: e.from, to: e.to })))
          const reportsDir = join(process.cwd(), 'reports')
          mkdirSync(reportsDir, { recursive: true })
          const file = join(reportsDir, `${graphId}.html`)
          writeFileSync(file, html, 'utf8')
          return `✅ 报告已生成: ${file}\n${r.ok ? '' : `⚠ 图执行未完全成功: ${r.message}\n`}（用浏览器打开查看 4 个 section）`
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_status',
        description: '查看最近一次图执行的状态快照：当前节点/迭代/retry/耗时/Token/状态。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute() {
          if (!lastSnapshot) return '（尚无图执行记录，先运行 weave_graph_watch / weave_graph_report）'
          return formatStatusHeader(lastSnapshot, false)
        },
      }),
    ),
  )

  return () => {
    for (const d of disposers) d()
  }
}
