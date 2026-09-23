/**
 * CLI 可视化命令（MVP-2 T12/T13/T14 + 审查修复）。
 *
 * 注册 3 个 DSH 工具：
 *   - weave_graph_watch：运行图（mock 节点）+ 终端实时视图 + 循环告警
 *   - weave_graph_report：运行图 + 生成 HTML 执行报告（reports/<graphId>.html）
 *   - weave_graph_status：查看最近一次图执行状态快照
 *
 * 审查修复：
 * - M14：mock handler retry_count 返回增量（与 merge 累加一致）
 * - WIN3/L12：静态 import 替代动态 import
 * - S1：run() 传 graphVersion/graphSchemaHash
 * - S9：trace 事件落盘（artifactsRoot）
 *
 * ⚠️ 真实 subagent 跑图（weave_graph_run / runGraphReal）留给 MVP-3，不在本阶段实现。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { loadGraphSpec, resolveExecWorkspace } from './graph-commands.js'
import { computeGraphSchemaHash } from '../l2-engine/graph-definition.js'
import { validateGraph } from '../l2-engine/static-validator.js'
import { createStateGraph, END } from '../l2-engine/state-graph.js'
import { evaluateCondition } from '../l2-engine/condition-edge.js'
import { createEventBus } from '../l4-visual/host/event-bus.js'
import { setGlobalBus } from '../l4-visual/host/shared-bus.js'
import { resolveArtifactsRoot } from '../l4-visual/host/artifacts-root.js'
import { registerGraph } from '../l4-visual/host/spec-registry.js'
import { getGlobalTokens } from '../l4-visual/host/visual-runtime.js'
import { getGlobalLedger } from './graph-run-commands.js'
import { createTerminalView, formatStatusHeader } from '../l4-visual/host/terminal-view.js'
import { renderHtmlReport } from '../l4-visual/host/html-report.js'
import { createLoopDetector } from '../l4-visual/host/loop-detector.js'
import { readPauseState, pauseStatePath } from '../l2-engine/chain-runner.js'
import type { GraphDefinitionSpec } from '../l2-engine/types.js'

/** 最近一次执行的快照（供 status 工具查询）。 */
let lastSnapshot: ReturnType<typeof createEventBus>['getSnapshot'] extends () => infer S ? S : never = null as never

/** mock 延迟（毫秒）：模拟子代理执行耗时，便于观察实时视图。 */
const MOCK_NODE_DELAY_MS = 300

/**
 * 运行图（mock 模式）：解析 → 校验 → 构建引擎 → 执行 → 返回结果 + 轨迹。
 * 同时向传入的 bus 推送事件。
 */
export async function runGraphMock(ctx: Context, spec: GraphDefinitionSpec, bus: ReturnType<typeof createEventBus>, artifactsRoot?: string) {
  const validation = validateGraph(spec, { registeredRoles: new Set(ctx.subagents.list()) })
  if (!validation.valid) {
    return { ok: false, message: `图校验失败:\n${validation.errors.map((e) => `  · ${e.path}: ${e.message}`).join('\n')}` }
  }

  const root = resolveArtifactsRoot({ explicit: artifactsRoot })
  const graph = createStateGraph<Record<string, unknown>>(
    ctx,
    spec.maxIterations ?? 25,
    8,
    root, // P4.0.3：统一 artifactsRoot（不再用 cwd 硬编码）
    (evt) => bus.handle(evt), // P4.0.1：引擎事件 → 总线（替代手动 checkpoint 桥接）
    getGlobalLedger(),        // P1-1：RunLedger
    getGlobalTokens(),        // P1-2：Token 分账（mock 数值也入账，看板可显示）
  )
  // P4.A.4：注册 spec/roleMap 供 REST 读取
  const roleMap: Record<string, string> = {}
  for (const n of spec.nodes) roleMap[n.id] = n.roleRef ?? n.nodeType
  registerGraph(bus.getSnapshot().graphId || `graph-${Date.now()}`, { spec, roleMap, artifactsRoot: root })

  // 注册节点：role/condition 用 mock handler；approval 用审批门
  for (const node of spec.nodes) {
    if (node.nodeType === 'approval') {
      graph.addApprovalGate(node.id, {
        toolName: `weave_approve_${node.id}`,
        reason: `节点 ${node.id} 需审批`,
        required: false,
      })
    } else {
      const nodeId = node.id
      const role = node.roleRef ?? node.nodeType
      // NEW-8：mock handler 同步 S13 接口（reportTokenUsage/reportRetry）
      graph.addNode(
        nodeId,
        async (state, nodeCtx) => {
          await new Promise((r) => setTimeout(r, MOCK_NODE_DELAY_MS))
          const inputTokens = Math.floor(Math.random() * 400) + 200
          const outputTokens = Math.floor(Math.random() * 300) + 100
          nodeCtx.reportTokenUsage?.({ input: inputTokens, output: outputTokens, cacheRead: 0 })
          nodeCtx.reportRetry?.((state.retry_count as number | undefined) ?? 0)
          // M14：retry_count 返回增量 1（merge 是累加策略），messages 追加
          return {
            messages: [{ role: 'mock', node: nodeId, at: Date.now() }],
            retry_count: 1,
            active_agent: role,
          }
        },
        { role }, // NEW-10：节点 meta
      )
    }
  }

  // 边：seq 走 addEdge；loop 走 addLoopEdge；cond 转条件函数
  for (const edge of spec.edges) {
    if (edge.type === 'seq') {
      graph.addEdge(edge.from, edge.to)
    } else if (edge.type === 'loop' && edge.maxIter !== undefined) {
      graph.addLoopEdge(edge.from, edge.to, edge.maxIter)
    } else if (edge.type === 'cond' && edge.when) {
      // WIN3/L12 修复：静态 import evaluateCondition
      const when = edge.when
      const to = edge.to
      graph.addConditionalEdge(edge.from, async (state) => {
        return evaluateCondition(when, state as Record<string, unknown>) ? to : END
      })
    }
  }

  // checkpoint 回调：引擎 emit 已经 eventSink 桥接 checkpoint-written 到 bus，此处只做占位
  const checkpoint = async () => {}

  const result = await graph.run(
    { messages: [], retry_count: 0, max_iterations: spec.maxIterations ?? 25 } as Record<string, unknown>,
    {
      checkpoint,
      graphVersion: spec.graphVersion,
      graphSchemaHash: spec.graphSchemaHash ?? computeGraphSchemaHash(spec),
    },
  )

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
        async execute(args, exec) {
          // 问题 3：图路径与产物默认基准用会话工作区
          const workspace = resolveExecWorkspace(exec)
          const spec = loadGraphSpec(args.path, workspace)
          // P4.0.10：graphId 一次生成，全程复用（含全局共享 bus）
          const graphId = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          const bus = setGlobalBus(graphId)
          const detector = createLoopDetector()
          const output: string[] = []
          const capture = (line: string) => output.push(line)
          const view2 = createTerminalView(bus, capture)
          view2.start()
          detector.start(bus, (a) => capture(a.message))

          bus.handle({ type: 'graph/start', graphId, timestamp: Date.now() })
          const r = await runGraphMock(ctx, spec, bus, resolveArtifactsRoot({ workspace }))
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
        async execute(args, exec) {
          // 问题 3：图路径与产物默认基准用会话工作区
          const workspace = resolveExecWorkspace(exec)
          const spec = loadGraphSpec(args.path, workspace)
          const root = resolveArtifactsRoot({ workspace })
          const graphId = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          const bus = setGlobalBus(graphId)
          bus.handle({ type: 'graph/start', graphId, timestamp: Date.now() })
          const r = await runGraphMock(ctx, spec, bus, root)
          const snap = bus.getSnapshot()
          // P4.0.9：pause 状态传入 HTML 报告（暂停原因/下一角色/已完成步）
          const pauseState = readPauseState(pauseStatePath(root))
          const html = renderHtmlReport(
            snap,
            spec.edges.map((e) => ({ from: e.from, to: e.to })),
            pauseState
              ? {
                  pauseReason: pauseState.pauseReason,
                  nextRoleId: pauseState.resumeInfo.nextRoleId,
                  completedSteps: pauseState.resumeInfo.completedSteps,
                }
              : undefined,
          )
          const reportsDir = join(root, 'reports')
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

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_tail',
        description:
          '查看最近一次图执行的进度 trace 日志（productions/traces/graph-*.jsonl 事件流）。' +
          '返回最近 N 条事件；配合 Get-Content -Wait 可实时观测任务进度。',
        parameters: {
          lines: { type: 'integer', description: '返回最近多少条事件（默认 20）' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args, exec) {
          const { readdirSync, readFileSync, statSync } = await import('node:fs')
          const { join } = await import('node:path')
          // 问题 3：trace 目录基准用会话工作区
          const tracesDir = join(resolveArtifactsRoot({ workspace: resolveExecWorkspace(exec) }), 'traces')
          let files: string[]
          try {
            files = readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))
          } catch {
            return '（尚无 trace 日志，先运行 weave_graph_watch / weave_graph_report）'
          }
          if (files.length === 0) return '（traces 目录为空，先运行 weave_graph_watch / weave_graph_report）'
          // P4.0.5：按 mtime 取最新（mtimeMs 降序；stat 失败保序）
          files.sort((a, b) => {
            try {
              return statSync(join(tracesDir, b)).mtimeMs - statSync(join(tracesDir, a)).mtimeMs
            } catch {
              return 0
            }
          })
          const latest = files[0]
          if (!latest) return '（无 trace 文件）'
          const allLines = readFileSync(join(tracesDir, latest), 'utf8').split('\n').filter(Boolean)
          const n = Math.min(Math.max(1, args.lines ?? 20), allLines.length)
          const tail = allLines.slice(-n)
          return `最新 trace: ${latest}（共 ${allLines.length} 条事件）\n\n${tail.join('\n')}\n\n（实时观测：Get-Content -Wait "${join(tracesDir, latest)}"）`
        },
      }),
    ),
  )

  return () => {
    for (const d of disposers) d()
  }
}
