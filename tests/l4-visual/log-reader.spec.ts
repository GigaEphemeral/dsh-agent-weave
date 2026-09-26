/**
 * MVP-5 Phase G：结构化日志读取（traces jsonl）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTraceLogs } from '../../src/l4-visual/host/log-reader'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-logs-'))
  mkdirSync(join(dir, 'traces'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readTraceLogs', () => {
  it('读取并解析 jsonl 轨迹', () => {
    const graphId = 'graph-1'
    writeFileSync(join(dir, 'traces', graphId + '.jsonl'), [
      JSON.stringify({ type: 'graph/start', graphId, timestamp: 1 }),
      JSON.stringify({ type: 'graph/node-start', graphId, node: 'a', timestamp: 2 }),
    ].join('\n'), 'utf8')
    const logs = readTraceLogs(dir, graphId)
    expect(logs).toHaveLength(2)
    expect(logs[0]?.event.type).toBe('graph/start')
    expect(logs[1]?.seq).toBe(2)
  })

  it('按类型过滤 + 搜索 + limit', () => {
    const graphId = 'graph-2'
    writeFileSync(join(dir, 'traces', graphId + '.jsonl'), [
      JSON.stringify({ type: 'graph/start', graphId, timestamp: 1 }),
      JSON.stringify({ type: 'graph/node-start', graphId, node: 'dev', timestamp: 2 }),
      JSON.stringify({ type: 'graph/node-end', graphId, node: 'dev', timestamp: 3 }),
    ].join('\n'), 'utf8')
    expect(readTraceLogs(dir, graphId, { level: 'node-start' })).toHaveLength(1)
    expect(readTraceLogs(dir, graphId, { search: 'dev' })).toHaveLength(2)
    expect(readTraceLogs(dir, graphId, { limit: 1 })).toHaveLength(1)
  })

  it('文件不存在返回空数组；损坏行被跳过', () => {
    expect(readTraceLogs(dir, 'nope')).toEqual([])
    writeFileSync(join(dir, 'traces', 'g.jsonl'), 'not-json\n', 'utf8')
    expect(readTraceLogs(dir, 'g')).toEqual([])
  })
})
