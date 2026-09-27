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
import { DEFAULT_GRAPH_YAML, DEFAULT_GRAPH_FILENAME } from '../l2-engine/default-graph.js'
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
          '校验 YAML 图定义（path 可省略，缺省校验内置默认图）：Schema 校验 + 静态验证。' +
          '返回校验结果与 graphSchemaHash。',
        parameters: {
          path: { type: 'string', description: '图 YAML 文件路径（缺省=内置默认图）' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args, exec) {
          const workspace = resolveExecWorkspace(exec)
          // ★ Bugs-v3：path 可选（缺省用内置默认图）
          const spec = args.path
            ? loadGraphSpec(args.path, workspace)
            : parseGraphDefinitionYaml(DEFAULT_GRAPH_YAML, '<builtin-default>')
          const roles = new Set(ctx.subagents.list())
          const result = validateGraph(spec, { registeredRoles: roles })
          const displayPath = args.path ? resolveGraphPath(args.path, workspace) : '<builtin-default>'
          return formatValidation(displayPath, spec, result)
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_show',
        description: '显示 YAML 图定义的 ASCII 结构（path 可省略，缺省显示内置默认图）。',
        parameters: {
          path: { type: 'string', description: '图 YAML 文件路径（缺省=内置默认图）' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args, exec) {
          const workspace = resolveExecWorkspace(exec)
          // ★ Bugs-v3：path 可选（缺省用内置默认图）
          const spec = args.path
            ? loadGraphSpec(args.path, workspace)
            : parseGraphDefinitionYaml(DEFAULT_GRAPH_YAML, '<builtin-default>')
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
            '══════════════════════════════════════════════════════════',
            '  weave 图命令帮助',
            '══════════════════════════════════════════════════════════',
            '',
            '## ⚡ 快速开始（99% 场景：直接跑默认图，不要写 YAML）',
            '',
            '  weave_run_graph user_input="<用户需求原话>"',
            '',
            '  引擎内置六角色串行图（R1→R2→R4→R6→R7→R8）。',
            '  **默认不要传 path**。不要读 README / docs / workflows / roles 找图格式——已内置。',
            '',
            '## 🚫 禁止行为（违反浪费时间）',
            '',
            '  1. **禁止探测插件源码**：不读 dsh-agent-weave 的 lib/、src/、node_modules/ 实现。',
            '  2. **禁止为找图格式去读 README / docs / workflows / roles**——本 help 已给完整模板。',
            '  3. **禁止 Glob **/*.yaml 找示例**——没有示例，用下面的模板。',
            '  4. **调用 weave_run_graph 后**：立即向用户报告 graphId，不要等图跑完。',
            '',
            '──────────────────────────────────────────────────────────',
            '## 📋 参考模板（仅在用户明确要求自定义图时使用）',
            '──────────────────────────────────────────────────────────',
            '',
            '**最小可用模板**（复制即可，不需要改任何字段）：',
            '',
            '```yaml',
            'version: "1"',
            'graphVersion: "1.0.0"',
            'graphSchemaHash: "placeholder"',
            'entryPoint: requirement',
            'maxIterations: 25',
            'nodes:',
            '  - { id: requirement,  roleRef: R1-requirement, nodeType: role }',
            '  - { id: architecture, roleRef: R2-architect,   nodeType: role }',
            '  - { id: design,       roleRef: R4-designer,    nodeType: role }',
            '  - { id: develop,      roleRef: R6-developer,   nodeType: role }',
            '  - { id: test,         roleRef: R7-tester,      nodeType: role }',
            '  - { id: quality,      roleRef: R8-quality,     nodeType: role }',
            'edges:',
            '  - { from: requirement,  to: architecture, type: seq }',
            '  - { from: architecture, to: design,       type: seq }',
            '  - { from: design,       to: develop,      type: seq }',
            '  - { from: develop,      to: test,         type: seq }',
            '  - { from: test,         to: quality,      type: seq }',
            'checkpoint: { strategy: node-level, storage: fs }',
            'metadata:',
            '  source: yaml',
            '  createdAt: "2026-09-24T00:00:00Z"',
            '  updatedAt: "2026-09-24T00:00:00Z"',
            '```',
            '',
            '**★★★ 三条铁律（违反必失败）**：',
            '',
            '  ① **不要写 `artifactName`**！',
            '     角色 YAML 已经声明了自己产什么文件（prd.md / arch.md / design.md / ...）。',
            '     你写 `artifactName: r1.md` 会覆盖它，导致产出机械命名（r1.md）而不是 prd.md。',
            '     ✅ 正确：`- { id: requirement, roleRef: R1-requirement, nodeType: role }`',
            '     ❌ 错误：`- { id: r1, roleRef: R1-requirement, nodeType: role, artifactName: r1.md }`',
            '',
            '  ② **节点 id 必须用有意义的词**（不是 r1/r2）。',
            '     推荐：requirement / architecture / design / develop / test / quality',
            '     必须匹配 `^[a-z][a-z0-9_-]*$`（小写字母开头，只含小写/数字/下划线/连字符）。',
            '',
            '  ③ **version / graphVersion 必须是字符串**（带引号）。',
            '     ✅ `version: "1"`   ❌ `version: 1`（YAML 会解析为数字，Schema 拒绝）',
            '',
            '──────────────────────────────────────────────────────────',
            '## 🎭 可用角色（roleRef 只能填以下 6 个）',
            '──────────────────────────────────────────────────────────',
            '',
            '  R1-requirement  需求分析师  → 产出 prd.md',
            '  R2-architect    架构师      → 产出 arch.md',
            '  R4-designer     详细设计师  → 产出 design.md',
            '  R6-developer    开发者      → 产出 develop.md（唯一允许写代码/跑命令的角色）',
            '  R7-tester       测试员      → 产出 report.md',
            '  R8-quality      质量审核员  → 产出 review.md',
            '',
            '  其他 roleRef → 校验失败「角色未注册」',
            '',
            '──────────────────────────────────────────────────────────',
            '## ⚠️ 常见错误（对照自查）',
            '──────────────────────────────────────────────────────────',
            '',
            '  ❌ `version: 1`               → 必须是字符串 `"1"`',
            '  ❌ `graphVersion: 1`          → 必须是字符串 `"1.0.0"`',
            '  ❌ 缺 `graphSchemaHash`       → 必填；填 `"placeholder"` 即可（引擎自动重算）',
            '  ❌ 缺 `checkpoint`            → 必填：`{ strategy: node-level, storage: fs }`',
            '  ❌ 缺 `metadata`              → 必填（source/createdAt/updatedAt）',
            '  ❌ `edges[].type: next`       → 只能是 `seq` / `cond` / `loop` / `parallel`',
            '  ❌ `cond` 边缺 `when`         → cond 边必须有 when 字段',
            '  ❌ `loop` 边缺 `maxIter`      → loop 边必须有 maxIter（正整数）',
            '  ❌ `node.id: R1`（大写）       → 必须 `^[a-z][a-z0-9_-]*$`',
            '  ❌ node 缺 `nodeType`         → 必填：`role` / `condition` / `approval`',
            '  ❌ `entryPoint` 指向不存在    → 必须指向已定义节点',
            '',
            '──────────────────────────────────────────────────────────',
            '## 🔧 命令清单',
            '──────────────────────────────────────────────────────────',
            '',
            '  weave_run_graph [path=<yaml>] user_input=<需求> [output_dir=]',
            '                                   启动图执行。**path 可省略**（用内置默认图）。',
            '  weave_graph_validate [path=<yaml>]   校验图（path 可省略）',
            '  weave_graph_show [path=<yaml>]       显示 ASCII 图结构（path 可省略）',
            '  weave_graph_init [filename=] [force=]',
            '                                   生成默认图 YAML 模板（自定义图入口）',
            '  weave_graph_status                   查看最近一次执行状态',
            '  weave_graph_tail [lines=N]           查看最近一次 trace 事件流',
            '  weave_graph_resume graph_id=<id> [additional_context=]',
            '                                   从暂停快照恢复图执行',
            '',
            '──────────────────────────────────────────────────────────',
            '## ⏸ 暂停处理契约（主 agent 必读）',
            '──────────────────────────────────────────────────────────',
            '',
            '收到 graph 暂停时：',
            '',
            '✅ 应该做：',
            '  1. 向用户报告：哪个节点暂停、为什么、建议怎么处理',
            '  2. 等用户明确指示',
            '  3. 按用户指示调 weave_graph_resume graph_id=<id> [additional_context=...]',
            '',
            '❌ 禁止做：',
            '  1. 不要自动 weave_run_graph 重跑整图（重复 token）',
            '  2. 不要猜用户意图直接 resume',
            '  3. 不要忽略暂停继续做别的事',
            '  4. 不要报告"图已完成"',
          ].join('\n')
        },
      }),
    ),
  )

  // ─── 4. weave_graph_init ───
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'weave_graph_init',
        description:
          '在当前工作目录生成默认图 YAML 模板。**仅在用户明确要求自定义图时使用**；' +
          '普通需求直接 weave_run_graph user_input=... 即可（不传 path）。',
        parameters: {
          filename: { type: 'string', description: `输出文件名（默认 ${DEFAULT_GRAPH_FILENAME}）` },
          force: { type: 'boolean', description: '覆盖已存在文件（默认 false）' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value as string }]
          },
        },
        async execute(args, exec) {
          const { writeFileSync, existsSync } = await import('node:fs')
          const { join } = await import('node:path')
          const workspace = resolveExecWorkspace(exec) ?? process.cwd()
          const filename = args.filename ?? DEFAULT_GRAPH_FILENAME
          const target = join(workspace, filename)
          if (existsSync(target) && args.force !== true) {
            return `⚠ 文件已存在: ${target}\n加 force=true 覆盖`
          }
          writeFileSync(target, DEFAULT_GRAPH_YAML, 'utf8')
          return [
            `✅ 默认图模板已生成: ${target}`,
            '',
            '编辑后使用:',
            `  weave_graph_validate path=${filename}`,
            `  weave_run_graph path=${filename} user_input="..."`,
            '',
            '⚠ 三条铁律（违反必失败）：',
            '  ① 不要写 artifactName（角色 YAML 已声明）',
            '  ② 节点 id 用有意义的词（requirement 不是 r1）',
            '  ③ version/graphVersion 用字符串（"1" 不是 1）',
          ].join('\n')
        },
      }),
    ),
  )

  return () => {
    for (const d of disposers) d()
  }
}
