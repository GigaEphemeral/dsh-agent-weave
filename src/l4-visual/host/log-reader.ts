/**
 * 结构化日志读取（MVP-5 Phase G）。
 *
 * 引擎已把轨迹事件流式落盘到 <artifactsRoot>/traces/<graphId>.jsonl，
 * 这里提供按图读取/过滤/搜索的只读接口。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrajectoryEvent } from '../../l2-engine/types.js'

export interface LogQuery {
  limit?: number | undefined
  level?: string | undefined
  search?: string | undefined
}

export interface TraceLogEntry {
  seq: number
  event: TrajectoryEvent
}

/** 读取某图的轨迹日志（jsonl 逐行解析；文件不存在返回空数组）。 */
export function readTraceLogs(
  artifactsRoot: string,
  graphId: string,
  query: LogQuery = {},
): TraceLogEntry[] {
  const file = join(artifactsRoot, 'traces', graphId + '.jsonl')
  if (!existsSync(file)) return []

  const raw = readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const entries: TraceLogEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    try {
      entries.push({ seq: i + 1, event: JSON.parse(line) as TrajectoryEvent })
    } catch {
      // 跳过损坏行
    }
  }

  const limit = query.limit ?? 500
  const level = query.level
  const search = query.search?.toLowerCase()
  let result = entries
  if (level) {
    result = result.filter((e) => e.event.type.includes(level))
  }
  if (search) {
    result = result.filter((e) =>
      JSON.stringify(e.event).toLowerCase().includes(search),
    )
  }
  return result.slice(-limit)
}
