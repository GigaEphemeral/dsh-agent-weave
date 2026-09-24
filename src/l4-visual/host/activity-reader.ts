/**
 * 节点活动日志读取（MVP-4 P4.B.8）。
 *
 * 从 traces/<graphId>.jsonl 解析某节点的活动行（开始/完成/回退）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ActivityLine {
  timestamp: number
  icon: string
  text: string
}

/** 读取某节点最近活动行（从 trace 文件解析，缺省 20 行）。 */
export function readNodeActivity(
  productionsRoot: string,
  graphId: string,
  nodeId: string,
  limit = 20,
): ActivityLine[] {
  const traceFile = join(productionsRoot, 'traces', `${graphId}.jsonl`)
  if (!existsSync(traceFile)) return []
  let lines: string[]
  try {
    lines = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const activities: ActivityLine[] = []
  for (const line of lines) {
    let evt: { node?: string; type?: string; timestamp?: number; durationMs?: number; data?: { from?: string; to?: string } }
    try {
      evt = JSON.parse(line) as typeof evt
    } catch {
      continue
    }
    if (evt.node !== nodeId) continue
    if (evt.type === 'graph/node-start') {
      activities.push({ timestamp: evt.timestamp ?? 0, icon: '▶', text: `${nodeId} 开始` })
    } else if (evt.type === 'graph/node-end') {
      activities.push({ timestamp: evt.timestamp ?? 0, icon: '✓', text: `${nodeId} 完成 (${evt.durationMs ?? 0}ms)` })
    } else if (evt.type === 'graph/loop-iteration') {
      activities.push({ timestamp: evt.timestamp ?? 0, icon: '⚠', text: `回退 ${evt.data?.from ?? ''} → ${evt.data?.to ?? ''}` })
    } else if (evt.type === 'graph/node-activity') {
      // 实时活动（tool-call/result/assistant/thinking）
      const d = evt.data as { kind?: string; tool?: string; args?: string; result?: string; text?: string } | undefined
      const kind = d?.kind ?? ''
      const icon = kind === 'tool-call' ? '🔧' : kind === 'tool-result' ? '✓' : kind === 'thinking' ? '💭' : '💬'
      const text =
        kind === 'tool-call' ? `调用 ${d?.tool ?? 'tool'}(${d?.args ?? ''})`
        : kind === 'tool-result' ? `${d?.tool ?? 'tool'} 返回: ${d?.result ?? ''}`
        : d?.text ?? ''
      activities.push({ timestamp: evt.timestamp ?? 0, icon, text })
    }
  }
  return activities.slice(-limit)
}
