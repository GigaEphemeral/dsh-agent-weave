/**
 * 运行历史/恢复点（MVP-4 P4.B.6）。
 *
 * 从 productions/traces/*.jsonl 读取运行历史；checkpoint 从 store 读取。
 * 单图模式补充：历史读盘，不依赖内存 registry。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RunHistoryEntry {
  graphId: string
  status: string
  startedAt: number
  artifactsRoot: string
}

export interface CheckpointEntry {
  iteration: number
  node: string
  timestamp: number
}

/** 列出运行历史（traces/*.jsonl，按起始时间倒序）。 */
export function listRuns(productionsRoot: string): RunHistoryEntry[] {
  const tracesDir = join(productionsRoot, 'traces')
  try {
    return readdirSync(tracesDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const graphId = f.replace('.jsonl', '')
        try {
          const lines = readFileSync(join(tracesDir, f), 'utf8').split('\n').filter(Boolean)
          const first = JSON.parse(lines[0] ?? '{}') as { timestamp?: number }
          const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { type?: string }
          return {
            graphId,
            status: last.type === 'graph/end' ? 'completed' : 'running',
            startedAt: first.timestamp ?? 0,
            artifactsRoot: productionsRoot,
          }
        } catch {
          return { graphId, status: 'unknown', startedAt: 0, artifactsRoot: productionsRoot }
        }
      })
      .sort((a, b) => b.startedAt - a.startedAt)
  } catch {
    return []
  }
}

/** 从 checkpoint 存储读取恢复点（兼容最小 store 形态）。 */
export function listCheckpoints(
  store: { dir(graphId: string): string; list(graphId: string): string[]; read(path: string): { iteration: number; node: string; timestamp: number } | null } | undefined,
  graphId: string,
): CheckpointEntry[] {
  if (!store) return []
  const files = store.list(graphId)
  return files
    .map((f) => store.read(`${store.dir(graphId)}/${f}`))
    .filter((r): r is { iteration: number; node: string; timestamp: number } => r !== null)
    .sort((a, b) => a.iteration - b.iteration)
}
