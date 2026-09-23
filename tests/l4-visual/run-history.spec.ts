/**
 * run-history 单测（MVP-4 P4.B.6）。
 *
 * 覆盖：从 traces/*.jsonl 列出运行 / 状态推断（completed/running）/ 恢复点读取。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { listRuns, listCheckpoints } from '../../src/l4-visual/host/run-history'

const ROOT = join(process.cwd(), 'test-env', 'runs', 'run-history-spec')

describe('P4.B.6 运行历史', () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, 'traces'), { recursive: true })
  })

  it('列出运行并按起始时间倒序', () => {
    writeFileSync(join(ROOT, 'traces', 'g-old.jsonl'), `${JSON.stringify({ type: 'graph/start', timestamp: 100 })}\n${JSON.stringify({ type: 'graph/end' })}\n`, 'utf8')
    writeFileSync(join(ROOT, 'traces', 'g-new.jsonl'), `${JSON.stringify({ type: 'graph/start', timestamp: 200 })}\n`, 'utf8')
    const runs = listRuns(ROOT)
    expect(runs).toHaveLength(2)
    expect(runs[0]?.graphId).toBe('g-new')
    expect(runs[0]?.status).toBe('running')
    expect(runs[1]?.status).toBe('completed')
  })

  it('空目录返回空数组', () => {
    expect(listRuns(ROOT)).toEqual([])
  })

  it('恢复点按迭代排序', () => {
    const store = {
      dir: () => ROOT,
      list: () => ['cp-2', 'cp-1'],
      read: (path: string) => {
        if (path.endsWith('cp-2')) return { iteration: 2, node: 'b', timestamp: 300 }
        if (path.endsWith('cp-1')) return { iteration: 1, node: 'a', timestamp: 200 }
        return null
      },
    }
    const cps = listCheckpoints(store, 'g1')
    expect(cps.map((c) => c.iteration)).toEqual([1, 2])
  })
})
