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
}

/** Capabilities 枚举（planB §5.4：8 个通用值，平台级不特化）。 */
export const DEFAULT_CAPABILITIES: readonly string[] = [
  'read', 'analyze', 'write-doc', 'write-code', 'run-cmd', 'run-tests', 'review', 'spawn',
]

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

  return { providers, probedAt: Date.now(), overallSource }
}

/** Capabilities 枚举（静态平台值）。 */
export function listCapabilities(): string[] {
  return [...DEFAULT_CAPABILITIES]
}

/** 从 ctx.tools 反射可用工具名（dynamic）；反射失败回退 yaml-scan 角色工具。 */
export function probeTools(ctx: Context): { tools: string[]; source: ProviderSource } {
  const dynamic = probeToolsDynamic(ctx)
  if (dynamic.length > 0) return { tools: dynamic, source: 'dynamic' }
  return { tools: probeToolsYamlScan(), source: 'yaml-scan' }
}

function probeToolsDynamic(ctx: Context): string[] {
  try {
    const schemas = ctx.tools?.schemas?.()
    if (!Array.isArray(schemas)) return []
    return schemas
      .map((s: { name?: string }) => s.name)
      .filter((n: string | undefined): n is string => typeof n === 'string' && n.length > 0)
      .sort()
  } catch {
    return []
  }
}

function probeToolsYamlScan(): string[] {
  try {
    const roles = loadRoleDefinitions(getRolesDir())
    const set = new Set<string>()
    for (const role of roles) for (const t of role.tools) if (t) set.add(t)
    return [...set].sort()
  } catch {
    return []
  }
}
