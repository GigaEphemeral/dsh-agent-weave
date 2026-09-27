/**
 * weave_run_graph 工具（MVP-3 问题 2：Phase A 收口——真实图执行入口）。
 *
 * 流程：loadGraphSpec → validateGraph → createStateGraph → role 节点 addSubagent /
 * condition 节点 pass-through / approval 门 → seq/loop/cond 边 → graph.run。
 * 返回执行结果 + trace 路径 + 产物目录。
 *
 * 问题一（看板实时）：
 * - 步骤 0：graphId 由外部生成并传入 graph.run（统一 graphId，bus/registry/引擎一致）
 * - 步骤 1：工具改异步，秒返回 graphId，图在后台跑
 *
 * 问题四（图容错）：
 * - rolesDir 由 index.ts 单一真相源传入（不再本文件自己算 PACKAGE_ROOT，
 *   避免编译产物 lib/cli/graph-run-commands.js 上跳一级算成 lib/ 导致 lib/roles ENOENT）
 */
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { loadGraphSpec, resolveExecWorkspace } from './graph-commands.js'
import { computeGraphSchemaHash, parseGraphDefinitionYaml } from '../l2-engine/graph-definition.js'
import { DEFAULT_GRAPH_YAML, isPlaceholderHash } from '../l2-engine/default-graph.js'
import { validateGraph } from '../l2-engine/static-validator.js'
import { createStateGraph, SKIP } from '../l2-engine/state-graph.js'
import { evaluateCondition } from '../l2-engine/condition-edge.js'
import { setGlobalBus } from '../l4-visual/host/shared-bus.js'
import { resolveArtifactsRoot } from '../l4-visual/host/artifacts-root.js'
import { registerGraph } from '../l4-visual/host/spec-registry.js'
import { getGlobalTokens } from '../l4-visual/host/visual-runtime.js'
import { createRunLedger, type RunLedger } from '../l5-observability/run-ledger.js'
import { loadRoleDefinitions } from '../l3-roles/role-loader.js'
import type { GraphDefinitionSpec, GraphNodeSpec } from '../l2-engine/types.js'

/** v2.0 Phase D：默认 inputGate——显式配置优先，否则用 seq 上游（空则 undefined）。 */
function buildDefaultInputGate(
  node: GraphNodeSpec,
  seqUpstreamByNode: Map<string, string[]>,
): { requires: string[] } | undefined {
  if (node.inputGate !== undefined) return node.inputGate
  const upstream = seqUpstreamByNode.get(node.id)
  if (upstream && upstream.length > 0) return { requires: upstream }
  return undefined
}

/** 全局 RunLedger（消息流桥接 + 审计；惰性创建）。 */
let globalLedger: RunLedger | null = null
export function getGlobalLedger(): RunLedger {
  if (!globalLedger) globalLedger = createRunLedger()
  return globalLedger
}

/**
 * 运行真实图（role 节点接真实 subagent）。返回结构化结果。
 *
 * @param rolesDir 角色定义目录（由 index.ts 传入，单一真相源）
 */
export async function runGraphRealTool(
    ctx: Context,
    spec: GraphDefinitionSpec,
    userInput: string,
    parent: unknown,
    outputDir?: string,
    initialState?: Record<string, unknown>,
    workspace?: string,
    signal?: AbortSignal,
    rolesDir?: string,
) {
  const roles = rolesDir ? loadRoleDefinitions(rolesDir) : []

  // ★ Bugs-v3 修复2a：占位 hash 自动重算（graphSchemaHash: "placeholder" → 真实值）
  if (isPlaceholderHash(spec.graphSchemaHash)) {
    const realHash = computeGraphSchemaHash(spec)
    ;(spec as { graphSchemaHash: string }).graphSchemaHash = realHash
    ctx.logger.info('weave', 'graphSchemaHash 自动重算', { realHash })
  }

  // ★ Bugs-v3 修复2b：artifactName 优先级链（YAML > role_boundary > <nodeId>.md）
  // 并把解析结果写回 spec，供 resume 时复用
  for (const node of spec.nodes) {
    if (node.nodeType === 'role' && node.roleRef && !node.artifactName) {
      const role = roles.find((r) => r.id === node.roleRef)
      const resolved = role?.role_boundary?.artifact?.name ?? `${node.id}.md`
      ;(node as { artifactName?: string }).artifactName = resolved
    }
  }

  const validation = validateGraph(spec, { registeredRoles: new Set(ctx.subagents.list()) })
  if (!validation.valid) {
    return {
      ok: false,
      message: `图校验失败:\n${validation.errors.map((e) => `  · ${e.path}: ${e.message}`).join('\n')}`,
    }
  }

  // 问题 3：产物根优先 output_dir，其次 workspace/productions，最后 cwd/productions
  const root = resolveArtifactsRoot({ explicit: outputDir, workspace })

  // 问题一步骤 0：graphId 一次生成，全程复用（bus/registry/graph.run 同一值）
  const graphId = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const bus = setGlobalBus(graphId)
  bus.handle({ type: 'graph/start', graphId, timestamp: Date.now() })

  const graph = createStateGraph<Record<string, unknown>>(
      ctx,
      spec.maxIterations ?? 25,
      4,
      root,
      (evt) => bus.handle(evt), // P4.0.1：引擎事件 → 全局 bus
      getGlobalLedger(),        // P1-1：RunLedger
      getGlobalTokens(),        // P1-2：Token 分账（真实数值）
  )

  // P4.A.4：注册 spec/roleMap 供 REST 读取
  const roleMap: Record<string, string> = {}
  for (const n of spec.nodes) roleMap[n.id] = n.roleRef ?? n.nodeType
  registerGraph(graphId, { spec, roleMap, artifactsRoot: root })

  // 问题四：从角色 YAML 的 quality_gate 接入节点产物验证（产物空 → 整图停）
  // rolesDir 由 index.ts 单一真相源传入；未传则降级为不加载 quality_gate（不崩）
  // （roles 已在函数开头加载，供 hash 重算 + artifactName 优先级链）

  // ★ v2.0 Phase D：默认 inputGate——从 seq 边推导上游（缺省即要求上游产物非空）
  const seqUpstreamByNode = new Map<string, string[]>()
  for (const edge of spec.edges) {
    if (edge.type !== 'seq') continue
    const list = seqUpstreamByNode.get(edge.to) ?? []
    list.push(edge.from)
    seqUpstreamByNode.set(edge.to, list)
  }

  // 节点：role → addSubagent；condition/approval → pass-through/门
  for (const node of spec.nodes) {
    if (node.nodeType === 'role' && node.roleRef) {
      const role = roles.find((r) => r.id === node.roleRef)
      const defaultGate = buildDefaultInputGate(node, seqUpstreamByNode)
      graph.addSubagent(node.id, {
        provider: node.roleRef,
        // P4.0.6：artifactName 支持（缺省 <nodeId>.md）
        artifactName: node.artifactName ?? `${node.id}.md`,
        role: node.roleRef,
        // ★ Bugs-v3 修复2c：传 workspace（相对路径 + 多候选查找）
        ...(workspace !== undefined ? { workspace } : {}),
        ...(node.promptTemplate !== undefined ? { promptTemplate: node.promptTemplate } : {}),
        ...(role && role.quality_gate.length > 0 ? { qualityGate: role.quality_gate } : {}),
        // v2.0 Phase C：角色定义（Prompt 边界块注入）
        ...(role !== undefined ? { roleDefinition: role as never } : {}),
        // 问题三 D1 + v2.0：默认 inputGate（seq 上游），显式配置优先
        ...(defaultGate !== undefined ? { inputGate: defaultGate } : {}),
      })
    } else if (node.nodeType === 'approval') {
      graph.addApprovalGate(node.id, {
        toolName: `weave_approve_${node.id}`,
        reason: `节点 ${node.id} 需审批`,
        required: false,
      })
    } else {
      // condition 或未指定 roleRef 的 role 节点 → 空 handler（由边驱动路由）
      // graph.addNode(node.id, async () => ({}) as Record<string, unknown>, { role: node.roleType ?? node.nodeType })
      graph.addNode(node.id, async () => ({}) as Record<string, unknown>, { role: node.roleRef ?? node.nodeType })
    }
  }

  // 边：seq/loop/cond
  const condEdgesByFrom = new Map<string, Array<{ when: string; to: string; maxIter?: number }>>()
  for (const edge of spec.edges) {
    if (edge.type === 'seq') {
      graph.addEdge(edge.from, edge.to)
    } else if (edge.type === 'loop' && edge.maxIter !== undefined) {
      graph.addLoopEdge(edge.from, edge.to, edge.maxIter)
    } else if (edge.type === 'cond' && edge.when !== undefined) {
      const list = condEdgesByFrom.get(edge.from) ?? []
      const entry: { when: string; to: string; maxIter?: number } = { when: edge.when, to: edge.to }
      if (edge.maxIter !== undefined) entry.maxIter = edge.maxIter
      list.push(entry)
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
                from,
                to: edge.to,
                when: edge.when,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          return SKIP
        },
        maxIter,
    )
  }

  // checkpoint 回调：引擎 emit 已经 eventSink 桥接 checkpoint-written 到 bus，此处占位
  const checkpoint = async () => {}

  // ★ 问题一步骤 1：图在后台跑（不 await），工具立即返回 graphId
  const initialStateFull = {
    messages: [],
    retry_count: 0,
    max_iterations: spec.maxIterations ?? 25,
    user_input: userInput,
    ...(initialState ?? {}),
  } as Record<string, unknown>

  void graph
      .run(initialStateFull, {
        checkpoint,
        graphVersion: spec.graphVersion,
        graphSchemaHash: spec.graphSchemaHash ?? computeGraphSchemaHash(spec),
        agent: parent as never,
        ...(signal !== undefined ? { signal } : {}),
        graphId, // ★ 问题一步骤 0：统一 graphId（外部指定）
      })
      .then((result) => {
        ctx.logger.info('weave', '图执行结束', {
          graphId,
          success: result.success,
          iterations: result.iterations,
        })
      })
      .catch((err) => {
        ctx.logger.error('weave', '图执行失败', err instanceof Error ? err : new Error(String(err)), { graphId })
      })

  return {
    ok: true,
    status: 'started' as const, // ★ 问题一步骤 1：图已启动未完成
    message: '图已启动（异步执行中）',
    graphId,
    artifactsRoot: root,
    tracesDir: join(root, 'traces'),
  }
}

/**
 * 注册 weave_run_graph 工具。
 *
 * @param options.rolesDir 角色目录（由 index.ts 传入，供 quality_gate 加载）
 */
export function registerGraphRunCommand(
    ctx: Context,
    options: { rolesDir?: string } = {},
): () => void {
  const rolesDir = options.rolesDir

  return ctx.tools.register(
      defineTool({
        name: 'weave_run_graph',
        description:
            '启动图执行（**异步**），立即返回 graphId。' +
            '\n\n★★★ 99% 情况只需传 user_input，**不要传 path** ★★★' +
            '\n- ✅ 正确：weave_run_graph user_input="<用户需求原话>"' +
            '\n- ❌ 错误：找 YAML 示例/读 README/读 workflows/读 roles → 自己写 YAML → 再调用' +
            '\n\n【内置默认图（不传 path 时自动使用）】' +
            '\n六角色串行链：R1 需求 → R2 架构 → R4 设计 → R6 开发 → R7 测试 → R8 质量。' +
            '\n\n【只有用户明确要求自定义图时才用 path】' +
            '\n1. weave_graph_init 生成模板 → 2. 编辑 → 3. weave_run_graph path=<yaml> user_input="..."' +
            '\n\n【禁止行为】' +
            '\n- ❌ 读 README / docs / workflows / roles 找图格式' +
            '\n- ❌ Glob **/*.yaml 找示例' +
            '\n- ❌ 调用 weave_graph_validate / weave_graph_show 校验默认图（自动校验）' +
            '\n\n【user_input 传参规范】' +
            '\n只传**用户需求内容本身**。不要传"请按图链依次完成..."之类的执行指令。' +
            '\n\n【启动后】立即向用户报告 graphId；出错/暂停时先调 weave_graph_help。',
        parameters: {
          path: {
            type: 'string',
            description:
              '【默认不要传】图 YAML 路径。**省略时自动使用内置默认六角色图**。' +
              '仅在用户明确要求自定义图时才传。',
          },
          user_input: { type: 'string', required: true, description: '用户一句话需求' },
          output_dir: { type: 'string', description: '可选产物目录（默认 <workspace>/productions）' },
          initial_state: {
            type: 'object',
            additionalProperties: true,
            description: '初始状态字段（可选）',
          },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args, exec) {
          // 问题 3：图路径与产物默认基准用会话工作区（非 process.cwd()）
          const workspace = resolveExecWorkspace(exec)
          // ★ Bugs-v3 修复2d：path 可选（省略 → 内置默认图）
          let spec: GraphDefinitionSpec
          let sourceDesc: string
          if (args.path) {
            spec = loadGraphSpec(args.path, workspace)
            sourceDesc = `自定义图: ${args.path}`
          } else {
            spec = parseGraphDefinitionYaml(DEFAULT_GRAPH_YAML, '<builtin-default>')
            sourceDesc = '<builtin-default>（内置六角色串行图 R1→R2→R4→R6→R7→R8）'
            ctx.logger.info('weave', '使用内置默认图（未传 path）', {
              entryPoint: spec.entryPoint,
              nodes: spec.nodes.map((n) => n.id),
            })
          }
          const r = await runGraphRealTool(
              ctx,
              spec,
              args.user_input,
              exec.agent,
              args.output_dir,
              args.initial_state as Record<string, unknown> | undefined,
              workspace,
              exec.signal,
              rolesDir, // ★ 单一真相源：由 index.ts 传入
          )
          return [
            `✅ ${r.message}`,
            `图 ID: ${r.graphId}`,
            `图来源: ${sourceDesc}`,
            `产物目录: ${r.artifactsRoot}`,
            `进度 trace: ${r.tracesDir}/graph-*.jsonl（tail 观测：Get-Content -Wait）`,
            `（图在后台异步执行，前端看板经 graphId 订阅实时进展）`,
          ].join('\n')
        },
      }),
  )
}