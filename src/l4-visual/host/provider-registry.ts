/**
 * Provider / Capabilities / Tools 探测注册表（MVP-5B B6）。
 *
 * 角色编辑器需要动态候选值，不硬编码（planB §5.4/§6.3）。三个来源按可信度降级：
 * - dynamic   ：从 ctx.subagents 反射（运行时真实 provider，最可信）
 * - yaml-scan ：从 roles/*.yaml 聚合出现过的 provider/model（灰色标记）
 * - static    ：内置兜底列表（黄色标记 + tooltip）
 *
 * source 语义（planB §5.1）：
 *   dynamic    → 无标记（最可信）
 *   yaml-scan  → 灰色标记
 *   static     → 黄色标记 + tooltip
 */
import type { Context } from '@deepseek-ai/cordis'
import { loadRoleDefinitions } from '../../l3-roles/role-loader.js'
import { getRolesDir } from './role-library.js'

export type ProviderSource = 'dynamic' | 'yaml-scan' | 'static'

export interface ProviderInfo {
  id: string
  name: string
  models: string[]
  defaultModel: string
  source: ProviderSource
}

export interface ProvidersResponse {
  providers: ProviderInfo[]
  probedAt: number
  overallSource: ProviderSource
  /** 功能问题1 §3：非 dynamic 时给前端的降级警告。 */
  warning?: string
}

/** static 兜底 Provider 列表（仅当 dynamic 与 yaml-scan 均为空时启用）。 */
const STATIC_PROVIDERS: readonly ProviderInfo[] = []

interface ProviderLike {
  name?: string
  agentRouteDefaults?: { provider?: string; model?: string }
}

/** 从 ctx.subagents 反射已注册 provider（dynamic）。 */
function probeDynamic(ctx: Context): ProviderInfo[] {
  try {
    const list = ctx.subagents?.list?.()
    if (!Array.isArray(list) || list.length === 0) return []
    const map = new Map<string, ProviderInfo>()
    for (const name of list) {
      if (!name) continue
      const provider = ctx.subagents?.getProvider?.(name) as ProviderLike | undefined
      const route = provider?.agentRouteDefaults
      const id = route?.provider ?? name
      const model = route?.model
      const entry = map.get(id) ?? {
        id,
        name: id,
        models: [],
        defaultModel: '',
        source: 'dynamic' as const,
      }
      if (model && !entry.models.includes(model)) entry.models.push(model)
      if (model && !entry.defaultModel) entry.defaultModel = model
      map.set(id, entry)
    }
    return [...map.values()]
  } catch {
    return []
  }
}

/** 从 roles/*.yaml 聚合 provider/model（yaml-scan）。 */
function probeYamlScan(): ProviderInfo[] {
  try {
    const roles = loadRoleDefinitions(getRolesDir())
    const map = new Map<string, ProviderInfo>()
    for (const role of roles) {
      const { provider, model } = role.model
      if (!provider || !model) continue
      const entry = map.get(provider) ?? {
        id: provider,
        name: provider,
        models: [],
        defaultModel: '',
        source: 'yaml-scan' as const,
      }
      if (!entry.models.includes(model)) entry.models.push(model)
      if (!entry.defaultModel) entry.defaultModel = model
      map.set(provider, entry)
    }
    return [...map.values()]
  } catch {
    return []
  }
}

/**
 * 探测 Provider 列表（dynamic → yaml-scan → static 三级降级）。
 * overallSource = 最高可信度来源。
 */
export function probeProviders(ctx: Context): ProvidersResponse {
  const dynamic = probeDynamic(ctx)
  const yamlScan = probeYamlScan()
  const overallSource: ProviderSource = dynamic.length > 0
    ? 'dynamic'
    : yamlScan.length > 0
      ? 'yaml-scan'
      : 'static'

  // 合并：dynamic 优先；yaml-scan 补齐 dynamic 中缺失的 provider
  const byId = new Map<string, ProviderInfo>()
  for (const p of dynamic) byId.set(p.id, p)
  for (const p of yamlScan) {
    const existing = byId.get(p.id)
    if (!existing) {
      byId.set(p.id, p)
    } else if (existing.source === 'dynamic') {
      // dynamic 已覆盖：只补模型（保持 dynamic 标记）
      for (const m of p.models) if (!existing.models.includes(m)) existing.models.push(m)
    }
  }
  let providers = [...byId.values()]
  if (providers.length === 0) providers = [...STATIC_PROVIDERS]

  const warning = overallSource !== 'dynamic'
    ? `Provider 列表来源：${overallSource}（非实时探测），实际可用 provider 以 DSH 环境为准`
    : undefined

  return { providers, probedAt: Date.now(), overallSource, ...(warning !== undefined ? { warning } : {}) }
}

/** Capabilities 枚举（固定平台值；功能问题1 §2.5：带 label）。 */
export const DEFAULT_CAPABILITIES: readonly { id: string; label: string }[] = [
  { id: 'read', label: '读取' },
  { id: 'analyze', label: '分析/设计' },
  { id: 'write-doc', label: '撰写文档' },
  { id: 'write-code', label: '编写代码' },
  { id: 'run-cmd', label: '执行命令' },
  { id: 'run-tests', label: '运行测试' },
  { id: 'review', label: '独立评审' },
  { id: 'spawn', label: '派生 subagent' },
]

/** Capabilities 枚举（返回 { id, label }[]）。 */
export function listCapabilities(): Array<{ id: string; label: string }> {
  return DEFAULT_CAPABILITIES.map((c) => ({ ...c }))
}

/**
 * subagent 工具白名单（功能问题1 §2.3 修复）：
 * 角色（subagent）能用的工具是 toolFilter 白名单——固定枚举，
 * 不是主 agent 的 ctx.tools（那批是 CLI 命令）。
 */
export const SUBAGENT_TOOLS: readonly { id: string; label: string; desc: string }[] = [
  { id: 'read', label: '读取文件', desc: '读取工作区文件内容' },
  { id: 'glob', label: '文件搜索', desc: '按 glob 模式搜索文件' },
  { id: 'grep', label: '内容搜索', desc: '按正则搜索文件内容' },
  { id: 'write', label: '写入文件', desc: '创建/覆盖文件' },
  { id: 'edit', label: '编辑文件', desc: '修改已有文件' },
  { id: 'pwsh', label: '执行命令', desc: '运行 shell 命令' },
  { id: 'ask_user_question', label: '询问用户', desc: '向用户提问' },
]

/** 角色工具白名单（固定；不反射主 agent 工具表）。 */
export function listSubagentTools(): Array<{ id: string; label: string; desc: string }> {
  return SUBAGENT_TOOLS.map((t) => ({ ...t }))
}

/** @deprecated 用 listSubagentTools（原反射主 agent ctx.tools，内容错误）。 */
export function probeTools(_ctx: Context): { tools: string[]; source: ProviderSource } {
  return { tools: SUBAGENT_TOOLS.map((t) => t.id), source: 'static' }
}
