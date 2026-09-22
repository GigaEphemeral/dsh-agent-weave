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
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { computeGraphSchemaHash, parseGraphDefinitionYaml } from '../l2-engine/graph-definition.js'
import { validateGraph, type ValidationResult } from '../l2-engine/static-validator.js'
import type { GraphDefinitionSpec, GraphEdgeSpec } from '../l2-engine/types.js'

/** 读取并解析图 YAML 文件（错误 → 抛带路径的 Error）。 */
export function loadGraphSpec(filePath: string): GraphDefinitionSpec {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`图文件读取失败: ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseGraphDefinitionYaml(raw, filePath)
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

  // 主链：从 entryPoint 沿 seq 边线性走；cond/loop 边另行列示
  const visited = new Set<string>()
  const chain: string[] = []
  let current: string | undefined = spec.entryPoint
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    chain.push(current)
    const seqs = outgoing.get(current)
    const seq: GraphEdgeSpec | undefined = seqs?.find((e) => e.type === 'seq')
    current = seq?.to
  }

  const chainLine = chain.map((id) => `[${id}]`).join('──→')
  lines.push(`  ${chainLine}`)

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
        async execute(args) {
          const spec = loadGraphSpec(args.path)
          const roles = new Set(ctx.subagents.list())
          const result = validateGraph(spec, { registeredRoles: roles })
          return formatValidation(args.path, spec, result)
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
        async execute(args) {
          const spec = loadGraphSpec(args.path)
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
            'MVP-2 图命令（dsh-agent-weave）:',
            '',
            '  weave_graph_validate path=<yaml>  校验图（Schema + 静态验证 + schemaHash）',
            '  weave_graph_show path=<yaml>      显示 ASCII 图结构',
            '',
            '图 YAML 结构：version / graphVersion / graphSchemaHash / entryPoint /',
            '  maxIterations / nodes[] / edges[] / checkpoint / metadata / observers?',
          ].join('\n')
        },
      }),
    ),
  )

  return () => {
    for (const d of disposers) d()
  }
}
