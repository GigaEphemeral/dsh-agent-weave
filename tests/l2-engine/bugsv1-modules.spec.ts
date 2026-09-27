/**
 * Bugs-V1 新模块单测：handoff 解析 / 结构化质量门 / 共享发现池。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHandoffComment, stripHandoffComment, buildUpstreamContextBlocks } from '../../src/l2-engine/handoff-extractor'
import { validateNodeOutput } from '../../src/l2-engine/node-validator'
import { appendFinding, readRecentFindings, reusableFindingsText } from '../../src/l2-engine/findings-pool'

const ROOT = join(process.cwd(), 'test-env', 'runs', 'bugsv1-spec')

function writeArtifacts(files: Record<string, string>): Record<string, string> {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  const map: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) {
    const p = join(ROOT, k)
    writeFileSync(p, v, 'utf8')
    map[k] = p
  }
  return map
}

describe('Bugs-V1 handoff 解析', () => {
  it('解析 weave-handoff 注释块', () => {
    const h = parseHandoffComment('正文\n<!-- weave-handoff\n{"probes":[{"what":"API","how":"curl","result":"200","reusable":true}]}\n-->')
    expect(h?.probes[0]?.what).toBe('API')
  })

  it('格式错 → null', () => {
    expect(parseHandoffComment('无注释')).toBeNull()
    expect(parseHandoffComment('<!-- weave-handoff\n{bad json}\n-->')).toBeNull()
  })

  it('stripHandoffComment 去掉注释块', () => {
    const t = '正文\n<!-- weave-handoff\n{"probes":[]}\n-->\n尾部'
    expect(stripHandoffComment(t)).toContain('正文')
    expect(stripHandoffComment(t)).not.toContain('weave-handoff')
  })

  it('buildUpstreamContextBlocks 注入已探测/已决策', () => {
    const blocks = buildUpstreamContextBlocks(
      '## 正文\n<!-- weave-handoff\n{"probes":[{"what":"ETF API","how":"curl","result":"200 1523条"}],"decisions":[{"topic":"栈","choice":"Python"}]}\n-->',
    )
    const joined = blocks.join('\n')
    expect(joined).toContain('已探测（无需重复）')
    expect(joined).toContain('ETF API')
    expect(joined).toContain('已决策')
    expect(joined).toContain('栈: Python')
  })
})

describe('Bugs-V1 结构化质量门', () => {
  it('require_probe_section：无 handoff 块 → 失败', () => {
    const a = writeArtifacts({ 'prd.md': '## 目标\n内容'.repeat(100) })
    const r = validateNodeOutput({ artifacts: a }, [{ type: 'require_probe_section' }])
    expect(r.passed).toBe(false)
    expect(r.failures[0]).toContain('weave-handoff')
  })

  it('require_probe_section：有完整 handoff → 通过', () => {
    const text = '## 目标\n内容'.repeat(100) + '\n<!-- weave-handoff\n{"probes":[{"what":"x","how":"y","result":"z"}]}\n-->'
    const a = writeArtifacts({ 'prd.md': text })
    const r = validateNodeOutput({ artifacts: a }, [{ type: 'require_probe_section' }])
    expect(r.passed).toBe(true)
  })

  it('contains_section + min_file_size 联合判定', () => {
    const a = writeArtifacts({ 'arch.md': '# 技术选型\nPython\n\n## 模块划分\nA/B\n'.repeat(30) })
    const r = validateNodeOutput(
      { artifacts: a },
      [
        { type: 'min_file_size', bytes: 500 },
        { type: 'contains_section', section: '技术选型' },
      ],
    )
    expect(r.passed).toBe(true)
  })

  it('占位内容（"完成"）→ non_empty 失败', () => {
    const a = writeArtifacts({ 'dev.md': '完成' })
    const r = validateNodeOutput({ artifacts: a }, [{ type: 'non_empty' }])
    expect(r.passed).toBe(false)
  })
})

describe('Bugs-V1 共享发现池', () => {
  beforeEach(() => rmSync(ROOT, { recursive: true, force: true }))

  it('append + read + reusable 过滤', () => {
    appendFinding(ROOT, 'g1', { at: 1, node: 'r1', kind: 'endpoint', what: 'API', how: 'curl', result: '200', reusable: true })
    appendFinding(ROOT, 'g1', { at: 2, node: 'r1', kind: 'error', what: 'bad', how: 'x', result: 'err', reusable: false })
    const all = readRecentFindings(ROOT, 'g1')
    expect(all).toHaveLength(2)
    const text = reusableFindingsText(ROOT, 'g1')
    expect(text).toContain('API')
    expect(text).not.toContain('bad') // reusable=false 不进复用
  })

  it('单节点 20 条上限', () => {
    for (let i = 0; i < 25; i++) {
      appendFinding(ROOT, 'g1', { at: i, node: 'r1', kind: 'other', what: `f${i}`, how: 'h', result: 'r', reusable: true })
    }
    const file = join(ROOT, '_shared', 'g1-findings.jsonl')
    const count = readFileSync(file, 'utf8').split('\n').filter(Boolean).length
    expect(count).toBe(20)
  })
})
