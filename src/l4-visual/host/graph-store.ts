/**
 * 图保存与复用（MVP-5 Phase B）。
 *
 * 存储布局（用户数据根）：
 *   <root>/weave/graphs/<id>.yaml       图 DSL
 *   <root>/weave/graphs/<id>.meta.json  元数据（graphSchemaHash / 更新时间等）
 *
 * 支持：保存（校验+哈希）、列表、读取、删除、复制、模板（复用 task-store 模板）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { computeGraphSchemaHash, parseGraphDefinition } from '../../l2-engine/graph-definition.js'
import type { GraphDefinitionSpec } from '../../l2-engine/types.js'

let graphsDir: string | null = null

export function setGraphsDir(dir: string): void {
  graphsDir = dir
}

export function getGraphsDir(): string {
  return graphsDir ?? join(process.cwd(), 'weave', 'graphs')
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export interface GraphMeta {
  id: string
  graphSchemaHash: string
  createdAt: string
  updatedAt: string
  name?: string | undefined
  description?: string | undefined
}

export interface SavedGraph {
  id: string
  spec: GraphDefinitionSpec
  meta: GraphMeta
}

function yamlPath(id: string): string {
  return join(getGraphsDir(), `${id}.yaml`)
}

function metaPath(id: string): string {
  return join(getGraphsDir(), `${id}.meta.json`)
}

function readMeta(id: string): GraphMeta | null {
  const file = metaPath(id)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as GraphMeta
  } catch {
    return null
  }
}

/** 保存图（校验 + 计算 schema hash + 落盘 YAML/meta）。 */
export function saveGraph(
  id: string,
  input: GraphDefinitionSpec,
  meta: { name?: string; description?: string } = {},
): { ok: true; id: string; graphSchemaHash: string } {
  const parsed = parseGraphDefinition(input)
  const hash = computeGraphSchemaHash(parsed)
  const spec = { ...parsed, graphSchemaHash: hash }
  const now = new Date().toISOString()
  ensureDir(getGraphsDir())
  writeFileSync(yamlPath(id), yamlDump(spec), 'utf8')
  const existing = readMeta(id)
  writeFileSync(
    metaPath(id),
    JSON.stringify({
      id,
      graphSchemaHash: hash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(meta.name !== undefined ? { name: meta.name } : {}),
      ...(meta.description !== undefined ? { description: meta.description } : {}),
    } satisfies GraphMeta, null, 2),
    'utf8',
  )
  return { ok: true, id, graphSchemaHash: hash }
}

/** 列出已保存的图（不含 spec 内容，仅元数据）。 */
export function listSavedGraphs(): GraphMeta[] {
  const dir = getGraphsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => f.slice(0, -'.meta.json'.length))
    .map((id) => readMeta(id))
    .filter((m): m is GraphMeta => m !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 读取已保存图（含 spec + meta）。 */
export function loadSavedGraph(id: string): SavedGraph | null {
  const file = yamlPath(id)
  if (!existsSync(file)) return null
  try {
    const spec = parseGraphDefinition(yamlLoad(readFileSync(file, 'utf8')))
    const meta = readMeta(id) ?? { id, graphSchemaHash: spec.graphSchemaHash, createdAt: '', updatedAt: '' }
    return { id, spec, meta }
  } catch {
    return null
  }
}

/** 删除已保存图。 */
export function deleteSavedGraph(id: string): boolean {
  const yaml = yamlPath(id)
  if (!existsSync(yaml)) return false
  rmSync(yaml, { force: true })
  rmSync(metaPath(id), { force: true })
  return true
}

/** 复制已保存图到新 id（缺省 id-时间戳）。 */
export function cloneSavedGraph(id: string, newId?: string): { ok: boolean; id?: string; error?: string } {
  const graph = loadSavedGraph(id)
  if (!graph) return { ok: false, error: `graph not found: ${id}` }
  const targetId = newId ?? `${id}-clone-${Date.now()}`
  saveGraph(targetId, graph.spec, { name: (graph.meta.name ?? id) + ' (复制)' })
  return { ok: true, id: targetId }
}
