/**
 * version-restore 集成测试（MVP-2 T20：版本恢复 3 断言）。
 *
 * 场景：相同→恢复 / 不同→VERSION_MISMATCH / 无→null。
 * 用内存 checkpoint store（零磁盘），复用 T5 的 store 语义。
 */
import { describe, expect, it } from 'vitest'
import { createCheckpointCallback, restoreFromLatestCheckpoint, type CheckpointRecord, type CheckpointStore } from '../../src/l2-engine/checkpoint'

class MemoryStore implements CheckpointStore {
  records = new Map<string, CheckpointRecord>()

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
    this.records.set(fullPath, record)
    return Promise.resolve()
  }
}

describe('T20 graphVersion 恢复', () => {
  it('版本相同 → 恢复状态/迭代/节点', async () => {
    const store = new MemoryStore()
    const cb = createCheckpointCallback(store, 'graph-1', '0.1.0', 'hash')
    await cb({
      graphId: 'graph-1',
      graphVersion: '0.1.0',
      graphSchemaHash: 'hash',
      node: 'quality',
      state: { retry_count: 2, messages: ['a'] },
      iteration: 3,
      timestamp: 1000,
    })
    const restored = await restoreFromLatestCheckpoint<{ retry_count: number; messages: string[] }>(
      store,
      'graph-1',
      '0.1.0',
    )
    expect(restored).toEqual({ state: { retry_count: 2, messages: ['a'] }, iteration: 3, node: 'quality' })
  })

  it('版本不同 → VERSION_MISMATCH', async () => {
    const store = new MemoryStore()
    const cb = createCheckpointCallback(store, 'graph-1', '0.0.9', 'hash')
    await cb({
      graphId: 'graph-1',
      graphVersion: '0.0.9',
      graphSchemaHash: 'hash',
      node: 'dev',
      state: { retry_count: 1 },
      iteration: 1,
      timestamp: 1000,
    })
    const restored = await restoreFromLatestCheckpoint(store, 'graph-1', '0.1.0')
    expect(restored).toMatchObject({ error: 'VERSION_MISMATCH', storedVersion: '0.0.9', currentVersion: '0.1.0' })
  })

  it('无 checkpoint → null', async () => {
    const store = new MemoryStore()
    const restored = await restoreFromLatestCheckpoint(store, 'graph-ghost', '0.1.0')
    expect(restored).toBeNull()
  })
})
