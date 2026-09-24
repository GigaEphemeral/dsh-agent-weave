/**
 * CLI 图命令（MVP-2 T4）。
 *
 * 注册 3 个 DSH 工具：
 *   - weave_graph_validate：校验 YAML 图（Schema + 静态验证）
 *   - weave_graph_show：显示 ASCII 图结构
 *   - weave_graph_help：命令帮助
 *
 * 工具名遵守 provider 规范 `^[a-zA-Z0-9_-]{1,128}$`（P3-坑7）。
 */
import { isAbsolute, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { computeGraphSchemaHash, parseGraphDefinitionYaml } from '../l2-engine/graph-definition.js'
import { validateGraph, type ValidationResult } from '../l2-engine/static-validator.js'
import type { GraphDefinitionSpec, GraphEdgeSpec } from '../l2-engine/types.js'

/**
 * 从工具执行上下文解析会话工作区（问题 3：图文件路径基准不再用 process.cwd()）。
 *
 * 来源链（均为可选，运行时存在性检查）：
 * 1. exec.workspace（DSH 工具运行时注入的会话工作区）
 * 2. exec.agent.session.header.cwd（Session 持久字段）
 * 3. 回退 process.cwd()（兜底）
 */
export function resolveExecWorkspace(exec: unknown): string | undefined {
  if (!exec || typeof exec !== 'object') return undefined
  const e = exec as { workspace?: unknown; agent?: unknown }
  if (typeof e.workspace === 'string' && e.workspace) return e.workspace
  const agent = e.agent as { session?: { header?: { cwd?: unknown } } } | undefined
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd) return cwd
  return undefined
}

/**
 * 把用户给的图路径解析为绝对路径（问题 3：相对路径基于会话工作区，非 process.cwd()）。
 * 绝对路径原样返回；相对路径 join(workspace ?? process.cwd(), filePath)。
 */
export function resolveGraphPath(filePath: string, workspace?: string): string {
  return isAbsolute(filePath) ? filePath : join(workspace ?? process.cwd(), filePath)
}

/** 读取并解析图 YAML 文件（问题 3：错误路径展示解析后的绝对路径）。 */
export function loadGraphSpec(filePath: string, workspace?: string): GraphDefinitionSpec {
  const abs = resolveGraphPath(filePath, workspace)
  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (error) {
    throw new Error(`图文件读取失败: ${abs}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseGraphDefinitionYaml(raw, abs)
}

/** 构建 validate 文本输出。 */
export function formatValidation(
  filePath: string,
  spec: GraphDefinitionSpec,
  result: ValidationResult,
): string {
  const hash = computeGraphSchemaHash(spec)
  if (result.valid) {
    return [
      `✅ 图校验通过: ${filePath}`,
      `   · Schema 校验：通过`,
      `   · 静态验证：通过`,
      `   · 5 项检查：全部通过`,
      `   · graphSchemaHash: ${hash}`,
    ].join('\n')
  }
  const lines = [`❌ 图校验失败: ${filePath}`, `   · 发现 ${result.errors.length} 处问题：`]
  for (const e of result.errors) {
    lines.push(`   · ${e.path}: ${e.message}`)
  }
  return lines.join('\n')
}

/** 渲染 ASCII 图结构（线性布局：入口 → ... → 末端，标注 loop/cond 边）。 */
export function renderAsciiGraph(spec: GraphDefinitionSpec): string {
  const lines: string[] = []
  const outgoing = new Map<string, GraphEdgeSpec[]>()
  for (const edge of spec.edges) {
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }

  lines.push(`图版本: ${spec.graphVersion} (schema ${spec.graphSchemaHash})`)
  lines.push(`入口: ${spec.entryPoint}`)
  lines.push(`节点数: ${spec.nodes.length} | 边数: ${spec.edges.length} | 最大迭代: ${spec.maxIterations ?? 25}`)
  lines.push('')

  // 主链：从 entryPoint 沿 seq 边线性走；cond/loop/分叉另行列示
  const visited = new Set<string>()
  const chain: string[] = []
  const branchHints: string[] = []
  let current: string | undefined = spec.entryPoint
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    chain.push(current)
    const seqs = outgoing.get(current)
    const seqEdges = seqs?.filter((e) => e.type === 'seq') ?? []
    // M15 修复：多条 seq 出边时标注分叉提示（MVP-2 只取第一条）
    if (seqEdges.length > 1) {
      branchHints.push(`      ⑂ 分叉提示: ${current} 有多条 seq 出边（${seqEdges.map((e) => e.to).join(', ')}），MVP-2 只取第一条`)
    }
    const seq: GraphEdgeSpec | undefined = seqEdges[0]
    current = seq?.to
  }

  const chainLine = chain.map((id) => `[${id}]`).join('──→')
  lines.push(`  ${chainLine}`)
  for (const hint of branchHints) lines.push(hint)

  // 分支与循环标注
  for (const edge of spec.edges) {
    if (edge.type === 'loop') {
      lines.push(`      ↑ 回退: ${edge.from} ──loop (maxIter=${edge.maxIter})──→ ${edge.to}`)
    } else if (edge.type === 'cond') {
      lines.push(`      ↓ 条件: ${edge.from} ──when: ${edge.when}──→ ${edge.to}`)
    }
  }

  lines.push('')
  lines.push('节点详情:')
  for (const node of spec.nodes) {
    const desc = node.nodeType === 'role' ? `role: ${node.roleRef ?? '(未指定角色)'}` : node.nodeType
    lines.push(`  · ${node.id} (${desc})`)
  }
  return lines.join('\n')
}

/** 注册 3 个 CLI 图命令，返回注销函数。 */
export function registerGraphCommands(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_validate',
        description:
          '校验 YAML 图定义：Schema 校验（节点 ID 正则/边类型/cond 有 when/loop 有 maxIter/自环约束）' +
          '+ 静态验证（roleRef 注册/条件字段白名单/入口可达/环检测）。返回校验结果与 graphSchemaHash。',
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
          const workspace = resolveExecWorkspace(exec)
          const spec = loadGraphSpec(args.path, workspace)
          const roles = new Set(ctx.subagents.list())
          const result = validateGraph(spec, { registeredRoles: roles })
          return formatValidation(resolveGraphPath(args.path, workspace), spec, result)
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_show',
        description: '显示 YAML 图定义的 ASCII 结构：入口、节点/边数、主链、loop/cond 标注、节点详情。',
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
          const workspace = resolveExecWorkspace(exec)
          const spec = loadGraphSpec(args.path, workspace)
          return renderAsciiGraph(spec)
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_help',
        description: '显示 MVP-2 图命令帮助：validate / show 的用途与参数。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute() {
          return [
            'MVP-4 图命令（dsh-agent-weave）:',
            '',
            '  weave_graph_validate path=<yaml>   校验图（Schema + 静态验证 + schemaHash）',
            '  weave_graph_show path=<yaml>       显示 ASCII 图结构',
            '  weave_run_graph path=<yaml> user_input=<需求> [output_dir=] [initial_state=]',
            '                                    启动图执行（异步）：校验 → 后台跑真实子代理 → 立即返回 graphId',
            '  weave_graph_status                 查看最近一次图执行状态快照',
            '  weave_graph_tail [lines=N]         查看最近一次图执行的 trace 事件流',
            '  weave_graph_watch path=<yaml>      运行图（mock，零 LLM）并输出终端实时视图',
            '  weave_graph_report path=<yaml>     运行图（mock）并生成 HTML 报告',
            '  weave_graph_resume graph_id=<id> [additional_context=] [output_dir=]',
            '                                    从暂停快照恢复图执行（异步），复用同一子代理',
            '',
            '图 YAML 结构：version / graphVersion / graphSchemaHash / entryPoint /',
            '  maxIterations / nodes[] / edges[] / checkpoint / metadata / observers?',
            '',
            '## ⚠️ 运行图时必读',
            '',
            '1. **禁止探测插件源码**：不要读取/搜索 dsh-agent-weave 插件的源码（lib/、src/、node_modules/ 下的实现文件）',
            '   来"理解"工具行为。工具契约以本 help 与工具参数描述为准；探测源码浪费 token 且违反使用约定。',
            '2. **调用 weave_run_graph 后**：工具会立即返回 graphId（status=started），图在后台异步执行。',
            '   向用户报告"图已启动 + graphId"，不要等待图跑完才回复。',
            '3. **图出错时**：如果 weave_run_graph / weave_graph_resume 返回错误，或图在运行中暂停，',
            '   调用本工具（weave_graph_help）查看各工具的用途与参数，再决定下一步（如 weave_graph_resume）。',
            '',
            '## 暂停处理契约（主 agent 必读）',
            '',
            '收到 graph 暂停（节点失败 / 权限不足 / 依赖缺失等，图返回 status=paused 或错误含"暂停"）时：',
            '',
            '✅ **应该做**：',
            '  1. 向用户报告：图在哪个节点暂停、为什么（错误信息）、建议怎么处理',
            '  2. 等用户明确指示（授权 / 补上下文 / 跳过）',
            '  3. 按用户指示调 weave_graph_resume graph_id=<id> [additional_context=...]',
            '',
            '❌ **禁止做**：',
            '  1. 不要自动调 weave_run_graph 重跑整个图（会重复消耗 token）',
            '  2. 不要猜用户意图直接 resume',
            '  3. 不要忽略暂停继续做别的事',
            '  4. 不要报告"图已完成"',
            '',
            '**为什么**：重跑会重复消耗 token；用户明确要求"从断点继续"。',
          ].join('\n')
        },
      }),
    ),
  )

  return () => {
    for (const d of disposers) d()
  }
}
