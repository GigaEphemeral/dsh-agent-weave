/**
 * weave_graph_resume 工具（MVP-4 问题五修复 4）。
 *
 * 读暂停快照 → 重建图（复用 spec + childSessions）→ 从 resumeFrom 续跑（异步）。
 * 用户可在 resume 前追加上下文（additional_context）发给暂停节点的子代理。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { createStateGraph, SKIP } from '../l2-engine/state-graph.js'
import { evaluateCondition } from '../l2-engine/condition-edge.js'
import { setGlobalBus } from '../l4-visual/host/shared-bus.js'
import { resolveArtifactsRoot } from '../l4-visual/host/artifacts-root.js'
import { getGraph } from '../l4-visual/host/spec-registry.js'
import { getGlobalTokens } from '../l4-visual/host/visual-runtime.js'
import { getGlobalLedger } from './graph-run-commands.js'
import { readPauseSnapshot, removePauseSnapshot } from '../l2-engine/pause-snapshot.js'
import { resolveExecWorkspace } from './graph-commands.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bugs-V1 §10.2：构建恢复通知（失败原因 + 继续要求 + 读回上次产物）。 */
function buildResumePrompt(
  snapshot: { pausedNode: string; pauseReason: string; pauseDetails?: { error?: string; suggestedAction?: string }; state: Record<string, unknown> },
  root: string,
  additionalContext?: string,
): string {
  const lines = [
    `[恢复通知] 你（节点 ${snapshot.pausedNode}）上次执行被中断，原因如下：`,
    ``,
    `暂停原因: ${snapshot.pauseReason}`,
  ]
  const d = snapshot.pauseDetails ?? {}
  if (d.error) lines.push(`错误信息: ${d.error}`)
  if (d.suggestedAction) lines.push(`建议动作: ${d.suggestedAction}`)
  lines.push(``)
  lines.push(`【继续要求】`)
  lines.push(`1. 复盘上述失败原因，不要重复同样的动作。`)
  lines.push(`2. 若上次在写产物时失败，先读回已写内容，再补齐缺失部分（不要从零重写）。`)
  lines.push(`3. 若上次在探测时失败，先查共享发现池（可能已有其他节点的探测结果）。`)
  lines.push(`4. 完成后在产物末尾附 <!-- weave-handoff --> 块。`)
  if (additionalContext) {
    lines.push(``)
    lines.push(`[用户补充]`)
    lines.push(additionalContext)
  }
  // 附上次产物前 2000 字（防上下文丢失）
  const artifacts = snapshot.state.artifacts as Record<string, string> | undefined
  const prevPath = artifacts?.[snapshot.pausedNode]
  if (prevPath) {
    const abs = join(root, prevPath)
    try {
      if (existsSync(abs)) {
        const text = readFileSync(abs, 'utf8').slice(0, 2000)
        lines.push(``)
        lines.push(`【你上次的产物（前 2000 字）】`)
        lines.push(text)
      }
    } catch {
      // 读回失败忽略
    }
  }
  return lines.join('\n')
}

/** 从暂停快照恢复图（异步后台跑）。 */
export async function resumeGraphRealTool(
  ctx: Context,
  graphId: string,
  parent: unknown,
  workspace?: string,
  additionalContext?: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string; graphId?: string; resumeFrom?: string }> {
  const root = resolveArtifactsRoot({ workspace })
  const snapshot = readPauseSnapshot<Record<string, unknown>>(root, graphId)
  if (!snapshot) {
    return { ok: false, message: `未找到 graph ${graphId} 的暂停快照（pauses/${graphId}.json）——该图未暂停或快照已清理` }
  }
  const entry = getGraph(graphId)
  const spec = entry?.spec
  if (!spec) {
    return { ok: false, message: `graph ${graphId} 未注册（spec 不可得），无法重建图` }
  }

  // Bugs-V1 §10.2：恢复通知发给暂停节点的子代理（含失败原因 + 继续要求 + 读回产物）
  if (snapshot.childSessions[snapshot.pausedNode]) {
    const childId = snapshot.childSessions[snapshot.pausedNode]
    const resumePrompt = buildResumePrompt(snapshot, root, additionalContext)
    try {
      await ctx.subagents.sendMessage(
        parent as never,
        childId as never,
        [{ type: 'text', text: resumePrompt }],
        { signal: signal ?? new AbortController().signal },
      )
      ctx.logger.info('weave', '已向暂停节点子代理发送恢复通知', { graphId, node: snapshot.pausedNode })
    } catch (error) {
      ctx.logger.warn('weave', '发送恢复通知失败（继续恢复）', {
        graphId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 重建图（复用 spec + 恢复 childSessions）
  const bus = setGlobalBus(graphId)
  bus.handle({ type: 'graph/start', graphId, timestamp: Date.now() })
  const graph = createStateGraph<Record<string, unknown>>(
    ctx,
    spec.maxIterations ?? 25,
    4,
    root,
    (evt) => bus.handle(evt),
    getGlobalLedger(),
    getGlobalTokens(),
  )

  for (const node of spec.nodes) {
    if (node.nodeType === 'role' && node.roleRef) {
      graph.addSubagent(node.id, {
        provider: node.roleRef,
        artifactName: node.artifactName ?? `${node.id}.md`,
        role: node.roleRef,
        ...(node.promptTemplate !== undefined ? { promptTemplate: node.promptTemplate } : {}),
        ...(node.inputGate !== undefined ? { inputGate: node.inputGate } : {}),
      })
    } else if (node.nodeType === 'approval') {
      graph.addApprovalGate(node.id, {
        toolName: `weave_approve_${node.id}`,
        reason: `节点 ${node.id} 需审批`,
        required: false,
      })
    } else {
      graph.addNode(node.id, async () => ({}) as Record<string, unknown>, { role: node.nodeType })
    }
  }

  // 边（seq/loop/cond）
  const condEdgesByFrom = new Map<string, Array<{ when: string; to: string; maxIter?: number }>>()
  for (const edge of spec.edges) {
    if (edge.type === 'seq') graph.addEdge(edge.from, edge.to)
    else if (edge.type === 'loop' && edge.maxIter !== undefined) graph.addLoopEdge(edge.from, edge.to, edge.maxIter)
    else if (edge.type === 'cond' && edge.when !== undefined) {
      const list = condEdgesByFrom.get(edge.from) ?? []
      list.push({ when: edge.when, to: edge.to, ...(edge.maxIter !== undefined ? { maxIter: edge.maxIter } : {}) })
      condEdgesByFrom.set(edge.from, list)
    }
  }
  for (const [from, condEdges] of condEdgesByFrom) {
    const maxIter = Math.max(...condEdges.map((e) => e.maxIter ?? 1))
    graph.addConditionalEdge(
      from,
      async (state) => {
        for (const edge of condEdges) {
          try {
            if (evaluateCondition(edge.when, state as Record<string, unknown>)) return edge.to
          } catch (error) {
            ctx.logger.warn('graph', '条件求值失败，跳过', {
              from, to: edge.to, when: edge.when,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        return SKIP
      },
      maxIter,
    )
  }

  // 异步续跑：从暂停节点 + 快照状态 + 恢复 childSessions
  void graph
    .run({ ...snapshot.state }, {
      checkpoint: async () => {},
      graphVersion: spec.graphVersion,
      graphSchemaHash: spec.graphSchemaHash,
      agent: parent as never,
      ...(signal !== undefined ? { signal } : {}),
      graphId,
      startFrom: snapshot.resumeFrom,
      initialIteration: snapshot.iteration,
      initialLoopUsage: snapshot.loopUsage,
      restoredChildSessions: snapshot.childSessions,
      completedNodes: snapshot.completedNodes,
    })
    .then((result) => {
      // Bugs-V1 §10.3：成功且未再次暂停才删快照；失败/再暂停保留供二次恢复
      if (result.success && !result.data?.paused) {
        removePauseSnapshot(root, graphId)
        ctx.logger.info('weave', '恢复成功，快照已清理', { graphId })
      } else {
        ctx.logger.info('weave', '恢复后再次暂停/失败，保留快照', { graphId, success: result.success })
      }
    })
    .catch((err) => {
      ctx.logger.error('weave', '恢复执行失败，保留快照供二次恢复', err instanceof Error ? err : new Error(String(err)), { graphId })
      // 不删快照
    })

  return { ok: true, message: `图已从暂停点恢复（异步执行中）`, graphId, resumeFrom: snapshot.resumeFrom }
}

/** 注册 weave_graph_resume 工具。 */
export function registerGraphResumeCommand(ctx: Context): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'weave_graph_resume',
      description:
        '从暂停快照恢复图执行（**异步**）：读 pauses/<graphId>.json → 重建图 → 从暂停节点续跑，复用同一子代理。' +
        '参数 graph_id=暂停的图ID, additional_context=可选补充上下文（先发给暂停节点的子代理）。' +
        '返回值 status="resumed" 表示已启动恢复。' +
        '注意：若图未暂停或快照已清理，返回错误说明。',
      parameters: {
        graph_id: { type: 'string', required: true, description: '暂停的图 ID（graph-xxx）' },
        additional_context: { type: 'string', description: '可选：恢复前发给暂停节点子代理的补充上下文' },
        output_dir: { type: 'string', description: '可选产物目录（默认 workspace/productions）' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: value }]
        },
      },
      async execute(args, exec) {
        const r = await resumeGraphRealTool(
          ctx,
          args.graph_id,
          exec.agent,
          resolveExecWorkspace(exec),
          args.additional_context,
          exec.signal,
        )
        return r.ok
          ? `✅ ${r.message}\n图 ID: ${r.graphId}\n恢复点: ${r.resumeFrom}`
          : `❌ ${r.message}`
      },
    }),
  )
}
