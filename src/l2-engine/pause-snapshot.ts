/**
 * 暂停快照读写（MVP-4 问题五修复 3/4）。
 *
 * 落盘到 `<artifactsRoot>/pauses/<graphId>.json`；weave_graph_resume 读取恢复。
 * 与 chain-runner 的 pause-state.json（单链）区分——这里是图级快照。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PauseSnapshot } from './types.js'

export function pauseSnapshotPath(artifactsRoot: string, graphId: string): string {
  return join(artifactsRoot, 'pauses', `${graphId}.json`)
}

/** 写暂停快照（含 state/loopUsage/childSessions/completedNodes）。 */
export function writePauseSnapshot<T>(artifactsRoot: string, snapshot: PauseSnapshot<T>): void {
  const file = pauseSnapshotPath(artifactsRoot, snapshot.graphId)
  mkdirSync(join(artifactsRoot, 'pauses'), { recursive: true })
  writeFileSync(file, JSON.stringify(snapshot), 'utf8')
}

/** 读暂停快照（不存在返回 null）。 */
export function readPauseSnapshot<T = Record<string, unknown>>(artifactsRoot: string, graphId: string): PauseSnapshot<T> | null {
  const file = pauseSnapshotPath(artifactsRoot, graphId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PauseSnapshot<T>
  } catch {
    return null
  }
}

/** 删除暂停快照（恢复成功后清理）。 */
export function removePauseSnapshot(artifactsRoot: string, graphId: string): void {
  rmSync(pauseSnapshotPath(artifactsRoot, graphId), { force: true })
}
