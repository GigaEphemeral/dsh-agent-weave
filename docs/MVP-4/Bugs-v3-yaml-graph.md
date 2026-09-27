# 完整方案：让主 agent 完美创建图 + 其他问题照常修复

## 〇、问题本质

主 agent 是 LLM，它在写 YAML 时**不知道**以下 6 件事：

1. `artifactName` 应当**省略**（角色 YAML 已声明文件名）
2. 节点 id 应当用**有意义的词**（`requirement` 而非 `r1`）
3. `version` / `graphVersion` 必须是**字符串**（不是数字）
4. `edges[].type` 只能填 `seq`（不是 `next`）
5. `checkpoint` / `metadata` **必填**
6. `graphSchemaHash` 填 `placeholder` 即可（引擎会重算）

**这 6 条信息缺失，是主 agent 反复失败的根源。**

---

## 一、三层防御（缺一不可）

```
层 1：内置默认图 ─────→ 99% 场景"不写 YAML"
层 2：help 给模板 ────→ 要写 YAML 时"复制模板"
层 3：主 agent 约束 ──→ 明确"什么时候写、写什么"
```

---

## 二、层 1：内置默认图（`weave_run_graph` 的 `path` 可选）

### 新增 `src/l2-engine/default-graph.ts`

```typescript
/**
 * 内置默认图（Bugs-V4：让主 agent 99% 场景不用写 YAML）。
 *
 * 节点 id 用**有意义的词**（requirement/architecture/design/develop/test/quality），
 * **不写 artifactName**（让角色 YAML 决定：prd.md / arch.md / design.md / ...）。
 */

export const DEFAULT_GRAPH_YAML = `version: "1"
graphVersion: "1.0.0"
graphSchemaHash: "placeholder"
entryPoint: requirement
maxIterations: 25
nodes:
  - { id: requirement,  roleRef: R1-requirement, nodeType: role }
  - { id: architecture, roleRef: R2-architect,   nodeType: role }
  - { id: design,       roleRef: R4-designer,    nodeType: role }
  - { id: develop,      roleRef: R6-developer,   nodeType: role }
  - { id: test,         roleRef: R7-tester,      nodeType: role }
  - { id: quality,      roleRef: R8-quality,     nodeType: role }
edges:
  - { from: requirement,  to: architecture, type: seq }
  - { from: architecture, to: design,       type: seq }
  - { from: design,       to: develop,      type: seq }
  - { from: develop,      to: test,         type: seq }
  - { from: test,         to: quality,      type: seq }
checkpoint: { strategy: node-level, storage: fs }
metadata:
  source: yaml
  createdAt: "2026-09-24T00:00:00Z"
  updatedAt: "2026-09-24T00:00:00Z"
`

export const DEFAULT_GRAPH_FILENAME = 'weave-default.yaml'

export function isPlaceholderHash(hash: string | undefined): boolean {
  return !hash || hash === 'placeholder' || hash === 'demo' || hash === ''
}
```

---

## 三、层 2：`weave_graph_help` —— 给完整模板 + 常见错误

**`src/cli/graph-commands.ts`** 里 `weave_graph_help` 的 `execute()` 返回**整段替换**为：

```typescript
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
}
```

---

## 四、层 3：主 agent skill 约束（加一段）

**主 agent 的 skill 或 system prompt 里，加**：

```markdown
## 调用 weave 的最短路径

**用户说"用 weave 创建 <X>"**：

✅ **正确**（1 次工具调用）：
```
weave_run_graph user_input="<X 的完整描述>"
```

❌ **错误**（20+ 次工具调用）：
```
weave_graph_help → Glob **/*.yaml → 读 README → 读 workflows/ → 读 roles/
→ 写 YAML → validate 失败 → 改 YAML → validate 失败 → ...
```

**不要**：
- ❌ 调 `weave_graph_help` 找用法（工具描述已足够）
- ❌ Glob `**/*.yaml` 找示例
- ❌ 读 README / docs / workflows / roles
- ❌ 自己写 YAML（除非用户明确要求自定义图）

**只在用户明确说**"改图/加循环/加条件/换角色"时，才：
1. 调 `weave_graph_help`（拿模板）
2. 或调 `weave_graph_init`（生成模板文件）
3. 编辑后 `weave_run_graph path=<yaml>`
```

---

## 五、其他问题完整修复

### 修复 1：`buildRoleBoundaryBlock` 加第三参数

**`src/l3-roles/role-prompt.ts` 整个函数替换**：

```typescript
/**
 * 构建角色 Prompt 边界块。
 *
 * @param actualArtifactName 引擎解析出的实际文件名（YAML > role_boundary > <nodeId>.md）。
 *        传入时覆盖 role_boundary.artifact.name，避免 prompt 里出现两个名字。
 */
export function buildRoleBoundaryBlock(
  role: RoleDefinition | undefined,
  provider: string,
  actualArtifactName?: string,
): string {
  const lines: string[] = []
  const boundary = role?.role_boundary
  const responsibilities = boundary?.responsibilities ?? role?.capabilities ?? ['完成分配的任务']

  lines.push(`【你的角色】${provider}`)
  lines.push(`【你的职责】`)
  for (const r of responsibilities) lines.push(`  · ${r}`)

  const forbidden = boundary?.forbidden ?? deriveDefaultForbidden(role)
  if (forbidden.length > 0) {
    lines.push(`【你禁止做的事（违反即任务失败）】`)
    for (const f of forbidden) lines.push(`  ✗ ${f}`)
  }

  const artifact = boundary?.artifact
  if (artifact) {
    lines.push(`【你的产物要求】`)
    // ★ 优先用引擎解析出的实际文件名
    const displayName = actualArtifactName ?? artifact.name
    lines.push(`  · 文件名: ${displayName}`)
    lines.push(`  · 类型: ${artifact.type}`)
    if (artifact.required_sections.length > 0) {
      lines.push(`  · 必须包含章节（缺一即失败）:`)
      for (const s of artifact.required_sections) lines.push(`    - ## ${s}`)
    }
  }

  lines.push(HANDOFF_BLOCK_TEMPLATE)
  lines.push(PROBE_COLLAB_RULES)
  lines.push(ASYNC_SUBAGENT_RULES)

  return lines.join('\n')
}
```

### 修复 2：`graph-run-commands.ts` — artifactName 优先级链 + path 可选

**在 `runGraphRealTool` 里 `registerGraph` 之前插入**：

```typescript
  // ★ Bugs-V4：artifactName 优先级链（YAML > role_boundary > <nodeId>.md）
  // 并把解析结果写回 spec，供 resume 时复用
  for (const node of spec.nodes) {
    if (node.nodeType === 'role' && node.roleRef && !node.artifactName) {
      const role = roles.find((r) => r.id === node.roleRef)
      const resolved = role?.role_boundary?.artifact?.name ?? `${node.id}.md`
      ;(node as { artifactName?: string }).artifactName = resolved
    }
  }
```

**`addSubagent` 调用改为**：

```typescript
      graph.addSubagent(node.id, {
        provider: node.roleRef,
        artifactName: node.artifactName ?? `${node.id}.md`,
        role: node.roleRef,
        ...(workspace !== undefined ? { workspace } : {}),   // ★ 新增：传 workspace
        ...(node.promptTemplate !== undefined ? { promptTemplate: node.promptTemplate } : {}),
        ...(role && role.quality_gate.length > 0 ? { qualityGate: role.quality_gate } : {}),
        ...(role !== undefined ? { roleDefinition: role as never } : {}),
        ...(defaultGate !== undefined ? { inputGate: defaultGate } : {}),
      })
```

**工具描述 + path 可选**：

```typescript
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
```

**execute 里 path 可选**：

```typescript
        async execute(args, exec) {
          const workspace = resolveExecWorkspace(exec)
          // ★ Bugs-V4：path 可选
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
              ctx, spec, args.user_input, exec.agent, args.output_dir,
              args.initial_state as Record<string, unknown> | undefined,
              workspace, exec.signal, rolesDir,
          )
          return [
            `✅ ${r.message}`,
            `图 ID: ${r.graphId}`,
            `图来源: ${sourceDesc}`,
            `产物目录: ${r.artifactsRoot}`,
            `进度 trace: ${r.tracesDir}/graph-*.jsonl`,
            `（图在后台异步执行，前端看板经 graphId 订阅实时进展）`,
          ].join('\n')
        },
```

**顶部 import 补**：

```typescript
import { computeGraphSchemaHash, parseGraphDefinitionYaml } from '../l2-engine/graph-definition.js'
import { DEFAULT_GRAPH_YAML, isPlaceholderHash } from '../l2-engine/default-graph.js'
```

**`runGraphRealTool` 开头补 hash 自动重算**：

```typescript
  // ★ Bugs-V4：占位 hash 自动重算
  if (isPlaceholderHash(spec.graphSchemaHash)) {
    const realHash = computeGraphSchemaHash(spec)
    ;(spec as { graphSchemaHash: string }).graphSchemaHash = realHash
    ctx.logger.info('weave', 'graphSchemaHash 自动重算', { realHash })
  }
```

### 修复 3：`state-graph.ts` — prompt 给相对路径 + 多候选查找

**顶部 import 改为**：

```typescript
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
```

**`SubagentNodeOptions` 加字段**：

```typescript
export interface SubagentNodeOptions {
  // ...（原字段）
  /** ★ Bugs-V4：workspace 根（用于相对路径 + 多候选查找）。 */
  workspace?: string
}
```

**prompt 构建替换**：

```typescript
        // ★ Bugs-V4：计算产物相对路径
        const relativeArtifactPath = (() => {
          if (!options.artifactName || !artifactsRoot || !options.workspace) return null
          try {
            const rel = relative(options.workspace, artifactsRoot).replace(/\\/g, '/')
            return `${rel}/graph-artifacts/${name}/${options.artifactName}`
          } catch {
            return null
          }
        })()

        const artifactInstruction = relativeArtifactPath
          ? `【你的产出】（严格遵守，违反即失败）
你必须使用 **write 工具**把产物写到这个**相对路径**（相对你的工作目录）：
  ${relativeArtifactPath}

**只写这一个文件**，不要写其他位置（不要写工作目录根的裸文件名如 ${options.artifactName}）。
文件内容就是产物本体（不是"我完成了"之类的报告或总结）。
写完即结束，不要在产物外附加说明性文字。`
          : `【你的产出】
文件名：{{artifactName}}
写完即结束，不要在产物外附加说明性文字。`

        const defaultTemplate = `你是 {{provider}}，请完成下列**单一职责**任务。

【用户原始需求】（这是整个工作流的输入，不是你一个人的任务）
{{user_input}}

【上游产物】（你只需基于这些内容工作）
{{upstream}}

【你的任务】
仅完成 {{provider}} 角色职责范围内的产出。**不要越权做其他角色的工作**。

${artifactInstruction}

【行为约束】
每次调用工具前，先输出一行 "[动作] 正在 <做什么>（工具: <toolName>）"。`

        // ...（原 hasSeqUpstream / userInputForPrompt / prompt 构建）
        const prompt = (options.promptTemplate ?? defaultTemplate)
          .replaceAll('{{provider}}', options.provider)
          .replaceAll('{{user_input}}', userInputForPrompt)
          .replaceAll('{{upstream}}', upstreamSummary)
          .replaceAll('{{artifactName}}', options.artifactName ?? `${name}.md`)

        // ★ 边界块传 artifactName
        const boundaryBlock = buildRoleBoundaryBlock(
          options.roleDefinition as never,
          options.provider,
          options.artifactName,
        )
```

**产物落盘替换**（多候选查找 + copy）：

```typescript
        if (options.artifactName && artifactsRoot) {
          const nodeDir = join(artifactsRoot, 'graph-artifacts', name)
          mkdirSync(nodeDir, { recursive: true })
          const canonicalFile = join(nodeDir, options.artifactName)

          // ★ 多候选查找
          const candidates: string[] = [canonicalFile]
          if (options.workspace) {
            candidates.push(
              join(options.workspace, options.artifactName),
              join(options.workspace, 'productions', options.artifactName),
              join(options.workspace, 'productions', 'graph-artifacts', name, options.artifactName),
              join(options.workspace, 'graph-artifacts', name, options.artifactName),
            )
          }
          candidates.push(join(artifactsRoot, options.artifactName))

          let foundFile: string | null = null
          let foundSize = 0
          for (const c of candidates) {
            try {
              const st = statSync(c)
              if (st.size >= 100) { foundFile = c; foundSize = st.size; break }
            } catch { /* 继续 */ }
          }

          if (foundFile) {
            if (foundFile === canonicalFile) {
              logger.info('weave-addsubagent', '产物由子代理写入规范路径，引擎不覆盖', {
                node: name, file: canonicalFile, size: foundSize,
              })
              patch.artifacts = { [name]: canonicalFile }
            } else {
              try {
                copyFileSync(foundFile, canonicalFile)
                logger.info('weave-addsubagent', '子代理写到非规范位置，已复制到规范路径', {
                  node: name, from: foundFile, to: canonicalFile, size: foundSize,
                })
                patch.artifacts = { [name]: canonicalFile }
              } catch (err) {
                logger.warn('weave-addsubagent', '复制失败，使用原位置', {
                  node: name, from: foundFile,
                  error: err instanceof Error ? err.message : String(err),
                })
                patch.artifacts = { [name]: foundFile }
              }
            }
          } else {
            logger.warn('weave-addsubagent', '子代理未产出有效文件，引擎用 output text 兜底', {
              node: name, canonicalFile, fallbackSize: text.length,
              candidatesChecked: candidates,
            })
            writeFileSync(canonicalFile, text, 'utf8')
            patch.artifacts = { [name]: canonicalFile }
          }
        }
```

### 修复 4：`graph-resume-commands.ts` 传 workspace

**addSubagent 调用改为**：

```typescript
      graph.addSubagent(node.id, {
        provider: node.roleRef,
        artifactName: node.artifactName ?? `${node.id}.md`,
        role: node.roleRef,
        ...(workspace !== undefined ? { workspace } : {}),   // ★ 新增
        ...(node.promptTemplate !== undefined ? { promptTemplate: node.promptTemplate } : {}),
        ...(node.inputGate !== undefined ? { inputGate: node.inputGate } : {}),
      })
```

### 修复 5：`weave_graph_init` 新增（生成模板）

**`src/cli/graph-commands.ts` 末尾追加**：

```typescript
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
          render(_args, value) { return [{ type: 'text', text: value as string }] },
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
```

**顶部 import 补**：

```typescript
import { DEFAULT_GRAPH_YAML, DEFAULT_GRAPH_FILENAME } from '../l2-engine/default-graph.js'
```

---

## 六、落地步骤

### 1. 改 5 个文件

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/l2-engine/default-graph.ts` | **新增** |
| 2 | `src/l3-roles/role-prompt.ts` | `buildRoleBoundaryBlock` 加第三参数 |
| 3 | `src/cli/graph-commands.ts` | help 重写 + `weave_graph_init` + import |
| 4 | `src/cli/graph-run-commands.ts` | path 可选 + artifactName 优先级 + workspace 传递 + hash 重算 |
| 5 | `src/l2-engine/state-graph.ts` | prompt 相对路径 + 多候选查找 + SubagentNodeOptions.workspace |
| 6 | `src/cli/graph-resume-commands.ts` | addSubagent 传 workspace |

### 2. 编译 + 打包 + 重装

```powershell
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
pnpm build
npm pack --pack-destination ./dist
dsh plugin --profile weave-test add ./dist/dsh-agent-weave-*.tgz
```

### 3. 重启 + 浏览器 Ctrl+Shift+R

### 4. 清掉污染

```powershell
Remove-Item -Recurse -Force D:\dsharness\agentDev\softwareEngnieering\testMVP8\productions -ErrorAction SilentlyContinue
Remove-Item -Force D:\dsharness\agentDev\softwareEngnieering\testMVP8\prd.md -ErrorAction SilentlyContinue
Remove-Item -Force D:\dsharness\agentDev\softwareEngnieering\testMVP8\r1.md -ErrorAction SilentlyContinue
```

### 5. 验证

| # | 期望 |
|---|---|
| 1 | 调 `weave_graph_help` → 看到完整模板 + 三条铁律 + 角色清单 |
| 2 | `weave_run_graph user_input="创建俄罗斯方块"` **不传 path** → 返回 `图来源: <builtin-default>` |
| 3 | 命令行日志有 `使用内置默认图（未传 path）` + `graphSchemaHash 自动重算` |
| 4 | R1 的 prompt 里含相对路径 `productions/graph-artifacts/requirement/prd.md` |
| 5 | 日志有 `产物由子代理写入规范路径，引擎不覆盖`（或 `已复制到规范路径`） |
| 6 | `productions/graph-artifacts/requirement/prd.md` 是 11KB 左右 |
| 7 | 质量门通过，图继续跑 R2 |

---

## 七、效果对比

| 环节 | 改前 | 改后 |
|---|---|---|
| 主 agent 调用次数 | 26 次（Glob/Read/写 YAML/validate 反复失败） | **1-2 次**（直接 `weave_run_graph user_input=...`） |
| YAML 报错可见性 | "图定义校验失败"（7 字） | 带明细（几处/哪里/为什么） |
| artifactName | 主 agent 机械填 `r1.md` | **不填**，角色 YAML 决定（`prd.md`） |
| 产物路径 | 子代理写到 workspace 根，引擎用 69 字节覆盖 | 引擎多候选查找 + 复制到规范路径 |
| Token 消耗 | ~766K | 预计 <100K |
| 自定义图 | 主 agent 每次重写 | `weave_graph_help` 给完整模板 + `weave_graph_init` 一键生成 |

---

## 八、一句话总结

**核心是三条信息**，主 agent 缺的就是它：

1. **`artifactName` 不写**（角色 YAML 已声明）
2. **节点 id 用有意义的词**（`requirement` 不是 `r1`）
3. **`version`/`graphVersion` 是字符串**（`"1"` 不是 `1`）

**三层防御**：
- **不写 YAML** → 内置默认图（`path` 可选）
- **要写 YAML** → help 给模板 + `weave_graph_init` 一键生成
- **主 agent skill** → 明确"99% 场景不要写 YAML"

**其他修复**：`artifactName` 优先级链 + prompt 相对路径 + 产物多候选查找 + 双文件名冲突。

**要我把这 6 个文件的完整版（不只是 diff）都写出来吗？** 说一声，我直接输出可直接替换的完整代码。