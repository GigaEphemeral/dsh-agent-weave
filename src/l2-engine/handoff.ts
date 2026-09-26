/**
 * 交接单：读写 + 合并 + prompt 注入（MVP-5B B1 重写）。
 *
 * 方案 B（MVP-5planB）：把"路径清单"升级为"结构化交接单"。
 * 依赖方向严格单向（E8）：本文件只导入 handoff-schema.js，禁止导入 project-memory.js。
 *
 * 模块职责（§4）：
 * - parseHandoffFromMarkdown：md 文本 → 完整 envelope（补全 path/hash/sizeBytes/source）
 * - mergeEnvelopes：合并上游累积 envelope 与当前节点（冲突标记/累积规则）
 * - buildHandoffSection：生成下游 prompt 注入段
 * - IO：handoffJsonPath / writeHandoffJson / readHandoffJson（handoff.json 由引擎写，LLM 不写）
 *
 * 兼容层（§9.1 E1/E2/E3 + §4.6）：
 * - 旧四字段 Handoff / createHandoff / isValidHandoff / handoffToText 保留为 deprecated
 * - artifactsAsPaths / openIssuesAsStrings：新结构 → 旧 string[] 形态
 * - fromLegacyHandoff：旧 Handoff → 新 HandoffEnvelope
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  parseFrontMatter,
  validateEnvelope,
  type ArtifactRef,
  type HandoffEnvelope,
  type OpenIssue,
  type ProjectFact,
  type UnmetRequirement,
  type VerifiedFact,
} from './handoff-schema.js'

// ─── 兼容层：旧四字段 Handoff（deprecated） ──────────────────

/**
 * @deprecated 用 HandoffEnvelope（MVP-5B：结构化交接单）。
 * 保留旧 API 供既有调用方渐进迁移（§9.1 E3）。
 */
export interface Handoff {
  /** 给下游的紧凑摘要。 */
  summary: string
  /** 产出物引用列表（art:// 或路径）。 */
  artifacts: string[]
  /** 遗留问题/待处理项。 */
  openIssues: string[]
  /** 来源追踪。 */
  provenance: {
    roleId: string
    nodeId: string
    at: number
    graphId: string
    graphVersion: string
  }
}

/** @deprecated 用 parseHandoffFromMarkdown（引擎解析 front-matter）。 */
export function createHandoff(input: {
  summary: string
  artifacts?: string[]
  openIssues?: string[]
  roleId: string
  nodeId: string
  graphId: string
  graphVersion: string
}): Handoff {
  return {
    summary: input.summary,
    artifacts: input.artifacts ?? [],
    openIssues: input.openIssues ?? [],
    provenance: {
      roleId: input.roleId,
      nodeId: input.nodeId,
      at: Date.now(),
      graphId: input.graphId,
      graphVersion: input.graphVersion,
    },
  }
}

/** @deprecated 用 validateEnvelope（Zod 校验）。 */
export function isValidHandoff(h: unknown): h is Handoff {
  if (typeof h !== 'object' || h === null) return false
  const x = h as Record<string, unknown>
  return (
    typeof x.summary === 'string' &&
    Array.isArray(x.artifacts) &&
    Array.isArray(x.openIssues) &&
    typeof x.provenance === 'object' &&
    x.provenance !== null &&
    typeof (x.provenance as Record<string, unknown>).roleId === 'string'
  )
}

/** @deprecated 用 buildHandoffSection（结构化注入段）。 */
export function handoffToText(h: Handoff): string {
  const lines = [
    `【交接：${h.provenance.roleId}】`,
    `摘要：${h.summary}`,
    `产物：${h.artifacts.join(', ') || '（无）'}`,
    `遗留：${h.openIssues.join('; ') || '（无）'}`,
  ]
  return lines.join('\n')
}

// ─── E1/E2：新结构 → 旧 string[] 形态 ───────────────────────

/** E1：artifacts 从 ArtifactRef[] → path 列表（旧调用方迁移用）。 */
export function artifactsAsPaths(env: HandoffEnvelope): string[] {
  return env.artifacts.map((a) => a.path)
}

/** E2：openIssues 从 OpenIssue[] → summary 列表（旧调用方迁移用）。 */
export function openIssuesAsStrings(env: HandoffEnvelope): string[] {
  return env.openIssues.map((i) => i.summary)
}

/** E3：旧四字段 Handoff → 新 HandoffEnvelope（适配器）。 */
export function fromLegacyHandoff(legacy: Handoff): HandoffEnvelope {
  return {
    schemaVersion: '1.0',
    graphId: legacy.provenance.graphId,
    nodeId: legacy.provenance.nodeId,
    roleRef: legacy.provenance.roleId,
    at: legacy.provenance.at,
    artifacts: legacy.artifacts.map((p) => ({
      path: p,
      kind: 'doc',
      summary: '',
      hash: '',
      sizeBytes: 0,
    })),
    facts: [],
    environment: { verified: [], unmet: [] },
    openIssues: legacy.openIssues.map((s, i) => ({
      id: `legacy-${i}`,
      severity: 'warning' as const,
      summary: s,
      evidence: '',
      suggestedOwner: 'user',
      blocking: [],
    })),
    handoff: { upstream: [], downstream: [], completed: true },
  }
}

// ─── 解析：md → 完整 envelope ───────────────────────────────

export interface ParseHandoffOptions {
  graphId: string
  nodeId: string
  roleRef: string
  /** 产物根目录（path 相对此目录补全）。 */
  artifactsRoot: string
  /** 本节点产物文件绝对路径（自引用 artifact + 相对路径基准）。 */
  artifactAbsolutePath: string
}

function sha256OfFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/**
 * 从 markdown 文本生成完整 envelope（§4.2）。
 *
 * 引擎补全：artifacts 的 path（相对 artifactsRoot）/hash/sizeBytes、facts/verified 的 source。
 * 本文件自身不在 front-matter artifacts 中声明时，自动补一条自引用。
 * 无 front-matter → 返回合法空 shell（验收 10.1#1，不崩）。
 */
export function parseHandoffFromMarkdown(
  content: string,
  opts: ParseHandoffOptions,
): HandoffEnvelope {
  const fm = parseFrontMatter(content)

  // 补全 artifacts：路径转相对、算 hash/sizeBytes
  const artifacts: ArtifactRef[] = (fm?.artifacts ?? []).map((a) => {
    const abs = join(dirname(opts.artifactAbsolutePath), a.path)
    return {
      path: relative(opts.artifactsRoot, abs).replace(/\\/g, '/'),
      kind: a.kind,
      summary: a.summary,
      ...(a.contract !== undefined ? { contract: a.contract } : {}),
      hash: existsSync(abs) ? sha256OfFile(abs) : '',
      sizeBytes: existsSync(abs) ? statSync(abs).size : 0,
    }
  })

  // 若本文件不在 artifacts 里，引擎自动补一条（自引用）
  const selfPath = relative(opts.artifactsRoot, opts.artifactAbsolutePath).replace(/\\/g, '/')
  if (!artifacts.some((a) => a.path === selfPath)) {
    artifacts.unshift({
      path: selfPath,
      kind: 'doc',
      summary: '',
      hash: existsSync(opts.artifactAbsolutePath) ? sha256OfFile(opts.artifactAbsolutePath) : '',
      sizeBytes: existsSync(opts.artifactAbsolutePath) ? statSync(opts.artifactAbsolutePath).size : 0,
    })
  }

  // 补全 facts / environment.verified 的 source
  const facts: ProjectFact[] = (fm?.facts ?? []).map((f) => ({ ...f, source: opts.roleRef }))
  const verified: VerifiedFact[] = (fm?.environment?.verified ?? []).map((v) => ({
    ...v,
    at: Date.now(),
    source: opts.roleRef,
  }))

  return {
    schemaVersion: '1.0',
    graphId: opts.graphId,
    nodeId: opts.nodeId,
    roleRef: opts.roleRef,
    at: Date.now(),
    artifacts,
    facts,
    environment: {
      verified,
      unmet: fm?.environment?.unmet ?? [],
    },
    openIssues: fm?.openIssues ?? [],
    handoff: { upstream: [], downstream: [], completed: false },
  }
}

// ─── 合并：prev（累积）+ curr（当前节点） ─────────────────────

function mergeFacts(prev: ProjectFact[], curr: ProjectFact[]): ProjectFact[] {
  const map = new Map(prev.map((f) => [f.key, f]))
  for (const f of curr) {
    const old = map.get(f.key)
    if (old && old.value !== f.value) {
      // E7：仅值不同才标 conflict；否则保留 LLM 原 confidence
      map.set(f.key, {
        ...f,
        confidence: 'conflict',
        summary: f.summary
          ? `${f.summary}（与 ${old.source} 的 "${old.value}" 冲突）`
          : `与 ${old.source} 的 "${old.value}" 冲突`,
      })
    } else {
      map.set(f.key, f)
    }
  }
  return [...map.values()]
}

function mergeVerified(prev: VerifiedFact[], curr: VerifiedFact[]): VerifiedFact[] {
  const map = new Map(prev.map((v) => [v.key, v]))
  for (const v of curr) map.set(v.key, v)
  return [...map.values()]
}

function mergeOpenIssues(prev: OpenIssue[], curr: OpenIssue[]): OpenIssue[] {
  // 约定：curr 里同 id 出现视为"关闭"（覆盖 prev）
  const currIds = new Set(curr.map((i) => i.id))
  return [...prev.filter((i) => !currIds.has(i.id)), ...curr]
}

/**
 * 合并上游累积 envelope 与当前节点 envelope（§4.3）。
 *
 * 语义：
 * - facts：同 key 值不同 → 标 conflict（E7）
 * - verified：同 key 保留最新
 * - unmet：**累积式**（用户决策）——prev 未解决的 unmet 继续传递，
 *   仅当 curr 已验证同 key（视为解决）才移除；curr 新声明的 unmet 同样校验
 * - openIssues：curr 同 id 视为关闭
 * - handoff.upstream：累积 + prev.nodeId
 */
export function mergeEnvelopes(
  prev: HandoffEnvelope | null,
  curr: HandoffEnvelope,
): HandoffEnvelope {
  if (!prev) return { ...curr, handoff: { ...curr.handoff, upstream: [] } }

  const currVerifiedKeys = new Set(curr.environment.verified.map((v) => v.key))
  const stillUnmet = (u: UnmetRequirement): boolean => !currVerifiedKeys.has(u.key)

  return {
    ...curr,
    facts: mergeFacts(prev.facts, curr.facts),
    environment: {
      verified: mergeVerified(prev.environment.verified, curr.environment.verified),
      // 累积式：prev 未解决 + curr 新声明（均排除已被 curr 验证解决的 key）
      unmet: [...prev.environment.unmet.filter(stillUnmet), ...curr.environment.unmet.filter(stillUnmet)],
    },
    openIssues: mergeOpenIssues(prev.openIssues, curr.openIssues),
    handoff: {
      upstream: [...new Set([...prev.handoff.upstream, prev.nodeId])],
      downstream: curr.handoff.downstream,
      completed: true,
    },
  }
}

// ─── prompt 注入 ────────────────────────────────────────────

/**
 * 生成下游 prompt 注入段（§4.4）。
 *
 * 只显示 suggestedOwner === myRole 的 openIssues（精确指派，不打扰无关角色）。
 */
export function buildHandoffSection(env: HandoffEnvelope, myRole: string): string {
  const lines: string[] = ['【上游交接单】']

  if (env.artifacts.length > 0) {
    lines.push('\n## 你必须读取的产物')
    for (const a of env.artifacts) {
      lines.push(`- [${a.kind}] ${a.path}`)
      if (a.summary) lines.push(`  ${a.summary}`)
      if (a.contract) {
        lines.push('  契约：')
        for (const l of a.contract.split('\n')) lines.push(`    ${l}`)
      }
    }
  }

  if (env.environment.verified.length > 0) {
    lines.push('\n## 已确认的事实（禁止重复探测）')
    for (const v of env.environment.verified) {
      lines.push(`✓ ${v.key} = ${v.value}  （来自 ${v.source}，命令：${v.cmd}）`)
    }
  }

  if (env.environment.unmet.length > 0) {
    lines.push('\n## 已知未满足（遇到必须停）')
    for (const u of env.environment.unmet) {
      lines.push(`⚠ ${u.key} 需 ${u.required} → ${u.suggestion}`)
      if (u.blocking.length > 0) lines.push(`  阻塞：${u.blocking.join(', ')}`)
    }
  }

  const mine = env.openIssues.filter((i) => i.suggestedOwner === myRole)
  if (mine.length > 0) {
    lines.push(`\n## 指派给你的问题（${myRole}）`)
    for (const i of mine) {
      lines.push(`[${i.severity}] ${i.summary}`)
      if (i.evidence) lines.push(`  证据：${i.evidence}`)
    }
  }

  lines.push(`
【行为约束】
- 读上面列出的产物后再动手
- 不要重复探测"已确认的事实"里列出的内容
- 遇到"已知未满足"必须停止（ask_user_question 或 update_goal(blocked)）
- 处理"指派给你的问题"里列出的项
`)
  return lines.join('\n')
}

// ─── IO：handoff.json（引擎写，LLM 不写；决策 #1） ────────────

/** handoff.json 路径（<nodeDir>/handoff.json）。 */
export function handoffJsonPath(nodeDir: string): string {
  return join(nodeDir, 'handoff.json')
}

/** 写 handoff.json（目录不存在时创建）。 */
export function writeHandoffJson(nodeDir: string, env: HandoffEnvelope): void {
  mkdirSync(nodeDir, { recursive: true })
  writeFileSync(handoffJsonPath(nodeDir), JSON.stringify(env, null, 2), 'utf8')
}

/** 读 handoff.json（不存在或非法返回 null）。 */
export function readHandoffJson(nodeDir: string): HandoffEnvelope | null {
  const file = handoffJsonPath(nodeDir)
  if (!existsSync(file)) return null
  try {
    return validateEnvelope(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

// 类型仅作 re-export 便利（供调用方一处导入）
export type { UnmetRequirement }
