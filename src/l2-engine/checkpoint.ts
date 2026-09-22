/**
 * checkpoint 契约（MVP-2 T5，含 graphVersion / RES.8 §三）。
 *
 * 职责：
 * - createCheckpointCallback：节点补丁合并后落盘 checkpoint（7 字段）
 * - restoreFromLatestCheckpoint：版本感知恢复（相同→恢复 / 不同→VERSION_MISMATCH / 无→null）
 *
 * 存储抽象：CheckpointStore（可注入）。默认 FsCheckpointStore 用 node:fs 落盘到
 * 指定根目录（FIX.6：产物根路径从 ctx 传入，禁止 process.cwd()）。
 * 测试用内存 store，避免磁盘依赖。
 *
 * 关键约束：
 * - 写入回调不抛错（RES.10 §一.4：引擎吞掉记日志）
 * - 恢复时 state 反序列化失败 fail-fast（抛错）
 * - 存储句柄由调用方 ctx.effect() 管理（RES.4 检查清单第 2 项）
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { CheckpointCallback, CheckpointPayload } from './types.js'

/** checkpoint 记录（落盘 7 字段）。 */
export interface CheckpointRecord {
  graphId: string
  graphVersion: string
  graphSchemaHash: string
  node: string
  /** 序列化后的 state（JSON 字符串）。 */
  state: string
  iteration: number
  timestamp: number
}

/** checkpoint 存储抽象（可注入；默认 fs 实现）。 */
export interface CheckpointStore {
  /** checkpoint 根目录（graphId 之上）。 */
  dir(graphId: string): string
  /** 列出某 graphId 的全部 checkpoint 文件名（如 `2-test.json`，不含目录）。 */
  list(graphId: string): string[] | Promise<string[]>
  /** 读取一个 checkpoint 文件（完整路径）。 */
  read(fullPath: string): CheckpointRecord | null | Promise<CheckpointRecord | null>
  /** 写入一个 checkpoint 文件（完整路径）。 */
  write(fullPath: string, record: CheckpointRecord): Promise<void>
}

/** 结构化日志最小接口（避免依赖具体 logger）。 */
export interface CheckpointLogger {
  error(component: string, msg: string, error: Error, data?: Record<string, unknown>): void
}

/** 文件系统 checkpoint store：落盘到 `root/checkpoints/<graphId>/<iteration>-<node>.json`。 */
export class FsCheckpointStore implements CheckpointStore {
  constructor(private readonly root: string) {}

  dir(graphId: string): string {
    return `${this.root}/checkpoints/${graphId}`
  }

  list(graphId: string): string[] {
    try {
      return readdirSync(this.dir(graphId))
    } catch {
      return []
    }
  }

  read(fullPath: string): CheckpointRecord | null {
    try {
      const text = readFileSync(fullPath, 'utf8')
      return JSON.parse(text) as CheckpointRecord
    } catch {
      return null
    }
  }

  write(fullPath: string, record: CheckpointRecord): Promise<void> {
    const dir = fullPath.slice(0, fullPath.lastIndexOf('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(fullPath, JSON.stringify(record), 'utf8')
    return Promise.resolve()
  }
}

/** 创建 checkpoint 回调（写入不抛错，吞掉记日志）。 */
export function createCheckpointCallback<T>(
  store: CheckpointStore,
  graphId: string,
  graphVersion: string,
  graphSchemaHash: string,
  logger?: CheckpointLogger,
): CheckpointCallback<T> {
  return async (payload: CheckpointPayload<T>) => {
    let serialized: string
    try {
      serialized = JSON.stringify(payload.state)
    } catch (error) {
      // 序列化失败 → 记日志返回（回调不抛错）
      logger?.error('checkpoint', 'checkpoint 序列化失败', error as Error, {
        graphId,
        node: payload.node,
        iteration: payload.iteration,
      })
      return
    }
    try {
      const file = `${store.dir(graphId)}/${payload.iteration}-${payload.node}.json`
      await store.write(file, {
        graphId,
        graphVersion,
        graphSchemaHash,
        node: payload.node,
        state: serialized,
        iteration: payload.iteration,
        timestamp: payload.timestamp,
      })
    } catch (error) {
      logger?.error('checkpoint', 'checkpoint 写入失败', error as Error, {
        graphId,
        node: payload.node,
        iteration: payload.iteration,
      })
    }
  }
}

/** 版本不匹配错误信息。 */
export interface VersionMismatch {
  error: 'VERSION_MISMATCH'
  storedVersion: string
  currentVersion: string
}

/**
 * 从最近 checkpoint 恢复（版本感知，RES.8 §三.2 最小闭环）。
 *
 * 返回：
 *  - { state, iteration, node }：版本相同 → 恢复
 *  - { error: 'VERSION_MISMATCH', ... }：版本不同
 *  - null：无 checkpoint
 *
 * 注：恢复时 state 反序列化失败 fail-fast（抛错）。
 */
export async function restoreFromLatestCheckpoint<T>(
  store: CheckpointStore,
  graphId: string,
  currentGraphVersion: string,
): Promise<
  | { state: T; iteration: number; node: string }
  | VersionMismatch
  | null
> {
  const files = await store.list(graphId)
  if (files.length === 0) return null

  // 按文件名 `iteration-node.json` 的迭代号降序取最新
  const latest = files
    .slice()
    .sort((a, b) => {
      const iterA = Number.parseInt(a.split('-')[0] ?? '0', 10)
      const iterB = Number.parseInt(b.split('-')[0] ?? '0', 10)
      return iterB - iterA
    })[0]
  if (latest === undefined) return null

  const record = await store.read(`${store.dir(graphId)}/${latest}`)
  if (record === null) return null

  if (record.graphVersion !== currentGraphVersion) {
    return {
      error: 'VERSION_MISMATCH',
      storedVersion: record.graphVersion,
      currentVersion: currentGraphVersion,
    }
  }

  let state: T
  try {
    state = JSON.parse(record.state) as T
  } catch (error) {
    // fail-fast：反序列化失败抛错（记录损坏应暴露而非静默）
    throw new Error(
      `checkpoint 恢复失败: ${graphId}/${latest} state 反序列化错误: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { state, iteration: record.iteration, node: record.node }
}
