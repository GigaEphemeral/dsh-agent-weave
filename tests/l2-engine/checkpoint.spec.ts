/**
 * checkpoint.ts 单测（MVP-2 T5 Exit Gate：7 用例全绿）。
 *
 * 覆盖：写入 7 字段 / 序列化失败记日志不抛 / 写入失败记日志不抛 /
 * 无 checkpoint→null / 版本相同→恢复 / 版本不同→VERSION_MISMATCH / 损坏 state→fail-fast。
 * 用内存 store（零磁盘依赖）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createCheckpointCallback,
  restoreFromLatestCheckpoint,
  type CheckpointRecord,
  type CheckpointStore,
} from '../../src/l2-engine/checkpoint'

/** 内存 checkpoint store。 */
class MemoryStore implements CheckpointStore {
  records = new Map<string, CheckpointRecord>()
  failWrites = false

  dir(graphId: string): string {
    return `mem://checkpoints/${graphId}`
  }

  list(graphId: string): string[] {
    const prefix = `${this.dir(graphId)}/`
    return [...this.records.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort()
  }

  read(fullPath: string): CheckpointRecord | null {
    return this.records.get(fullPath) ?? null
  }

  write(fullPath: string, record: CheckpointRecord): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('disk full'))
    this.records.set(fullPath, record)
    return Promise.resolve()
  }
}

describe('T5 checkpoint 契约', () => {
  it('写入 7 字段完整落盘', async () => {
    const store = new MemoryStore()
    const cb = createCheckpointCallback(store, 'graph-1', '0.1.0', 'a1b2c3d4e5f6')
    await cb({
      graphId: 'graph-1',
      graphVersion: '0.1.0',
      graphSchemaHash: 'a1b2c3d4e5f6',
      node: 'dev',
      state: { v: 1 },
      iteration: 2,
      timestamp: 1700000000000,
    })
    const rec = [...store.records.values()][0]
    expect(rec).toBeDefined()
    expect(rec?.graphId).toBe('graph-1')
    expect(rec?.graphVersion).toBe('0.1.0')
    expect(rec?.graphSchemaHash).toBe('a1b2c3d4e5f6')
    expect(rec?.node).toBe('dev')
    expect(rec?.state).toBe('{"v":1}')
    expect(rec?.iteration).toBe(2)
    expect(rec?.timestamp).toBe(1700000000000)
  })

  it('序列化失败（循环引用）记日志不抛', async () => {
    const store = new MemoryStore()
    const logger = { error: vi.fn() }
    const cb = createCheckpointCallback(store, 'graph-1', logger)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(
      cb({
        graphId: 'graph-1',
        graphVersion: '0.1.0',
        graphSchemaHash: 'hash',
        node: 'dev',
        state: circular,
        iteration: 1,
        timestamp: 1,
      }),
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
    expect(store.records.size).toBe(0)
  })

  it('写入失败（store 抛错）记日志不抛', async () => {
    const store = new MemoryStore()
    store.failWrites = true
    const logger = { error: vi.fn() }
    const cb = createCheckpointCallback(store, 'graph-1', logger)
    await expect(
      cb({
        graphId: 'graph-1',
        graphVersion: '0.1.0',
        graphSchemaHash: 'hash',
        node: 'dev',
        state: { v: 1 },
        iteration: 1,
        timestamp: 1,
      }),
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })

  it('无 checkpoint → null', async () => {
    const store = new MemoryStore()
    const result = await restoreFromLatestCheckpoint(store, 'graph-nothing', '0.1.0')
    expect(result).toBeNull()
  })

  it('版本相同 → 恢复最新迭代', async () => {
    const store = new MemoryStore()
    // 手动写入两个不同迭代的 checkpoint（同一版本）
    const dir = store.dir('graph-1')
    await store.write(`${dir}/1-dev.json`, {
      graphId: 'graph-1',
      graphVersion: '0.1.0',
      graphSchemaHash: 'h',
      node: 'dev',
      state: '{"v":1}',
      iteration: 1,
      timestamp: 1,
    })
    await store.write(`${dir}/2-test.json`, {
      graphId: 'graph-1',
      graphVersion: '0.1.0',
      graphSchemaHash: 'h',
      node: 'test',
      state: '{"v":2}',
      iteration: 2,
      timestamp: 2,
    })
    const result = await restoreFromLatestCheckpoint<{ v: number }>(store, 'graph-1', '0.1.0')
    expect(result).toEqual({ state: { v: 2 }, iteration: 2, node: 'test' })
  })

  it('版本不同 → VERSION_MISMATCH', async () => {
    const store = new MemoryStore()
    const dir = store.dir('graph-1')
    await store.write(`${dir}/1-dev.json`, {
      graphId: 'graph-1',
      graphVersion: '0.0.9',
      graphSchemaHash: 'h',
      node: 'dev',
      state: '{"v":1}',
      iteration: 1,
      timestamp: 1,
    })
    const result = await restoreFromLatestCheckpoint(store, 'graph-1', '0.1.0')
    expect(result).toMatchObject({ error: 'VERSION_MISMATCH', storedVersion: '0.0.9', currentVersion: '0.1.0' })
  })

  it('损坏的 state → fail-fast 抛错', async () => {
    const store = new MemoryStore()
    const dir = store.dir('graph-1')
    await store.write(`${dir}/1-dev.json`, {
      graphId: 'graph-1',
      graphVersion: '0.1.0',
      graphSchemaHash: 'h',
      node: 'dev',
      state: '{broken json',
      iteration: 1,
      timestamp: 1,
    })
    await expect(restoreFromLatestCheckpoint(store, 'graph-1', '0.1.0')).rejects.toThrow(/反序列化错误/)
  })
})
