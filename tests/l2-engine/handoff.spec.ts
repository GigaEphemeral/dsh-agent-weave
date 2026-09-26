/**
 * MVP-5B B1：交接单数据结构层单测（handoff-schema / handoff / project-memory）。
 *
 * 覆盖验收 10.1 #1-#8：
 *  1. parseHandoffFromMarkdown 空输入 → 合法空 shell（不崩）
 *  2. parseHandoffFromMarkdown 有 front-matter → 补全 path/hash/sizeBytes
 *  3. mergeEnvelopes(null, curr) → 返回 curr 副本，不修改入参
 *  4. mergeEnvelopes(prev, curr) facts 冲突 → confidence='conflict'
 *  5. mergeEnvelopes 时 curr 解决 prev.unmet → 合并后不含该 unmet（累积式）
 *  6. buildHandoffSection 指派过滤 → 只显示 suggestedOwner === myRole
 *  7. extractFactsFromMarkdown 兼容 → 返回 ProjectFact[]
 *  8. ProjectMemory 空态 setFact → current() 非 null
 * 另：IO 往返（write/read handoff.json）、fromLegacyHandoff、artifactsAsPaths/openIssuesAsStrings
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactsAsPaths,
  buildHandoffSection,
  fromLegacyHandoff,
  mergeEnvelopes,
  openIssuesAsStrings,
  parseHandoffFromMarkdown,
  readHandoffJson,
  writeHandoffJson,
  type Handoff,
  type HandoffEnvelope,
} from '../../src/l2-engine/handoff'
import { parseFrontMatter, validateEnvelope } from '../../src/l2-engine/handoff-schema'
import { extractFactsFromMarkdown, ProjectMemory } from '../../src/l2-engine/project-memory'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'weave-handoff-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function makeEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    schemaVersion: '1.0',
    graphId: 'g-1',
    nodeId: 'node-a',
    roleRef: 'R1-requirement',
    at: Date.now(),
    artifacts: [],
    facts: [],
    environment: { verified: [], unmet: [] },
    openIssues: [],
    handoff: { upstream: [], downstream: [], completed: false },
    ...overrides,
  }
}

describe('parseFrontMatter（handoff-schema）', () => {
  it('解析完整 front-matter（facts/artifacts/environment/openIssues）', () => {
    const md = `---
facts:
  - key: env.python.version
    category: environment
    value: "3.14.6"
    confidence: confirmed
    summary: "Python 3.14.6 已安装"
artifacts:
  - path: ./docs/a.md
    kind: doc
    summary: "A 文档"
    contract: "下游必须遵守"
environment:
  verified:
    - key: env.node.version
      value: "22.23"
      cmd: "node --version"
  unmet:
    - key: env.docker
      required: "docker 可用"
      suggestion: "安装 docker"
      blocking: [node-b]
openIssues:
  - id: issue-1
    severity: blocker
    summary: "上游 API 凭证缺失"
    suggestedOwner: node-b
---
# 正文
`
    const fm = parseFrontMatter(md)
    expect(fm).not.toBeNull()
    expect(fm?.facts).toHaveLength(1)
    expect(fm?.facts[0]?.key).toBe('env.python.version')
    expect(fm?.artifacts).toHaveLength(1)
    expect(fm?.artifacts[0]?.contract).toContain('下游必须遵守')
    expect(fm?.environment?.verified).toHaveLength(1)
    expect(fm?.environment?.unmet?.[0]?.blocking).toEqual(['node-b'])
    expect(fm?.openIssues).toHaveLength(1)
  })

  it('无 front-matter / 空串 → null', () => {
    expect(parseFrontMatter('# 普通文档')).toBeNull()
    expect(parseFrontMatter('')).toBeNull()
  })

  it('非法 front-matter（缺必填/非法枚举）→ null（严格全拒，不部分解析）', () => {
    const md = `---
facts:
  - key: ok
    category: environment
    value: yes
  - key: bad
    category: nonsense
    value: x
---
`
    // category=nonsense 非法 → 整段拒绝（严格校验，防幻觉）
    expect(parseFrontMatter(md)).toBeNull()
  })
})

describe('parseHandoffFromMarkdown（handoff.ts）', () => {
  it('空输入返回合法空 shell（验收 10.1#1，不崩）', () => {
    const artifactPath = join(tmp, 'node-a.md')
    writeFileSync(artifactPath, '', 'utf8')
    const env = parseHandoffFromMarkdown('', {
      graphId: 'g-1',
      nodeId: 'node-a',
      roleRef: 'R1-requirement',
      artifactsRoot: tmp,
      artifactAbsolutePath: artifactPath,
    })
    expect(env.nodeId).toBe('node-a')
    expect(env.roleRef).toBe('R1-requirement')
    expect(env.facts).toEqual([])
    expect(env.environment.verified).toEqual([])
    expect(env.openIssues).toEqual([])
    expect(validateEnvelope(env)).not.toBeNull()
  })

  it('有 front-matter → 补全 path/hash/sizeBytes/source（验收 10.1#2）', () => {
    const artifactPath = join(tmp, 'node-a.md')
    const refPath = join(tmp, 'docs', 'a.md')
    mkdirSync(dirname(refPath), { recursive: true })
    writeFileSync(artifactPath, '# node-a\n', 'utf8')
    writeFileSync(refPath, 'ref-content', 'utf8')
    const md = `---
facts:
  - key: env.python.version
    category: environment
    value: "3.14.6"
    summary: "Python 已安装"
artifacts:
  - path: ./docs/a.md
    kind: doc
    summary: "A 文档"
---
# node-a
`
    const env = parseHandoffFromMarkdown(md, {
      graphId: 'g-1',
      nodeId: 'node-a',
      roleRef: 'R1-requirement',
      artifactsRoot: tmp,
      artifactAbsolutePath: artifactPath,
    })
    // facts 补 source
    expect(env.facts[0]).toMatchObject({ key: 'env.python.version', source: 'R1-requirement' })
    // artifacts 补 path（相对 artifactsRoot，正斜杠）/hash/sizeBytes
    const ref = env.artifacts.find((a) => a.path.endsWith('docs/a.md'))
    expect(ref).toBeDefined()
    expect(ref?.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(ref?.sizeBytes).toBe('ref-content'.length)
    expect(ref?.kind).toBe('doc')
    // 自引用 artifact 自动补全
    expect(env.artifacts.some((a) => a.path.endsWith('node-a.md') && a.kind === 'doc')).toBe(true)
  })

  it('environment.verified 补 at/source；unmet 原样保留', () => {
    const artifactPath = join(tmp, 'node-a.md')
    writeFileSync(artifactPath, 'x', 'utf8')
    const md = `---
environment:
  verified:
    - key: env.node.version
      value: "22.23"
      cmd: "node --version"
  unmet:
    - key: env.docker
      required: "docker"
      blocking: [node-b]
---
`
    const env = parseHandoffFromMarkdown(md, {
      graphId: 'g-1', nodeId: 'node-a', roleRef: 'R1-requirement',
      artifactsRoot: tmp, artifactAbsolutePath: artifactPath,
    })
    expect(env.environment.verified[0]?.source).toBe('R1-requirement')
    expect(env.environment.verified[0]?.at).toBeTypeOf('number')
    expect(env.environment.unmet[0]?.blocking).toEqual(['node-b'])
  })
})

describe('mergeEnvelopes（handoff.ts）', () => {
  it('prev=null 返回 curr 副本，不修改入参（验收 10.1#3）', () => {
    const curr = makeEnvelope({ facts: [{ key: 'a', category: 'environment', value: '1', confidence: 'confirmed', summary: '', source: 'R1' }] })
    const merged = mergeEnvelopes(null, curr)
    expect(merged).not.toBe(curr)
    expect(merged.facts).toEqual(curr.facts)
    expect(merged.handoff.upstream).toEqual([])
    // 入参未被修改
    expect(curr.handoff.upstream).toEqual([])
    expect(curr.handoff.completed).toBe(false)
  })

  it('facts 冲突 → confidence=conflict（验收 10.1#4，E7）', () => {
    const prev = makeEnvelope({ nodeId: 'node-a', facts: [{ key: 'k', category: 'environment', value: 'v1', confidence: 'confirmed', summary: 's1', source: 'A' }] })
    const curr = makeEnvelope({ nodeId: 'node-b', facts: [{ key: 'k', category: 'environment', value: 'v2', confidence: 'confirmed', summary: 's2', source: 'B' }] })
    const merged = mergeEnvelopes(prev, curr)
    const fact = merged.facts.find((f) => f.key === 'k')
    expect(fact?.confidence).toBe('conflict')
    expect(fact?.summary).toContain('冲突')
    expect(merged.facts).toHaveLength(1)
  })

  it('facts 同值 → 保留 LLM 原 confidence（E7，不误标冲突）', () => {
    const prev = makeEnvelope({ nodeId: 'node-a', facts: [{ key: 'k', category: 'environment', value: 'v1', confidence: 'assumed', summary: '', source: 'A' }] })
    const curr = makeEnvelope({ nodeId: 'node-b', facts: [{ key: 'k', category: 'environment', value: 'v1', confidence: 'confirmed', summary: '', source: 'B' }] })
    const merged = mergeEnvelopes(prev, curr)
    expect(merged.facts[0]?.confidence).toBe('confirmed')
  })

  it('unmet 累积式：prev 未解决继续传递；curr 解决（verified 同 key）则移除（验收 10.1#5）', () => {
    const prev = makeEnvelope({
      nodeId: 'node-a',
      environment: { verified: [], unmet: [{ key: 'env.docker', required: 'docker', suggestion: '安装', blocking: ['node-b'] }] },
    })
    const currUnresolved = makeEnvelope({ nodeId: 'node-b', environment: { verified: [], unmet: [] } })
    // 未解决 → 继续传递
    const mergedUnresolved = mergeEnvelopes(prev, currUnresolved)
    expect(mergedUnresolved.environment.unmet.map((u) => u.key)).toEqual(['env.docker'])
    // 解决（curr verified 同 key）→ 移除
    const currResolved = makeEnvelope({
      nodeId: 'node-b',
      environment: { verified: [{ key: 'env.docker', value: 'ok', cmd: 'docker --version' }], unmet: [] },
    })
    const mergedResolved = mergeEnvelopes(prev, currResolved)
    expect(mergedResolved.environment.unmet).toEqual([])
  })

  it('openIssues：curr 同 id 视为关闭（覆盖 prev）', () => {
    const prev = makeEnvelope({
      nodeId: 'node-a',
      openIssues: [{ id: 'i-1', severity: 'warning', summary: '旧问题', suggestedOwner: 'node-b' }],
    })
    const curr = makeEnvelope({
      nodeId: 'node-b',
      openIssues: [{ id: 'i-1', severity: 'info', summary: '已解决说明', suggestedOwner: 'user' }],
    })
    const merged = mergeEnvelopes(prev, curr)
    expect(merged.openIssues).toHaveLength(1)
    expect(merged.openIssues[0]?.summary).toBe('已解决说明')
  })

  it('handoff.upstream 累积 + 去重', () => {
    const prev = makeEnvelope({ nodeId: 'node-a', handoff: { upstream: ['node-0'], downstream: [], completed: true } })
    const curr = makeEnvelope({ nodeId: 'node-b', handoff: { upstream: [], downstream: ['node-c'], completed: false } })
    const merged = mergeEnvelopes(prev, curr)
    expect(merged.handoff.upstream).toEqual(['node-0', 'node-a'])
    expect(merged.handoff.completed).toBe(true)
    expect(merged.handoff.downstream).toEqual(['node-c'])
  })
})

describe('buildHandoffSection（handoff.ts）', () => {
  it('指派过滤：只显示 suggestedOwner === myRole（验收 10.1#6）', () => {
    const env = makeEnvelope({
      openIssues: [
        { id: 'i-1', severity: 'blocker', summary: '给 B 的问题', suggestedOwner: 'node-b' },
        { id: 'i-2', severity: 'info', summary: '给用户的问题', suggestedOwner: 'user' },
      ],
    })
    const section = buildHandoffSection(env, 'node-b')
    expect(section).toContain('给 B 的问题')
    expect(section).toContain('【行为约束】')
    expect(section).not.toContain('给用户的问题')
  })

  it('包含产物/已验证/未满足段落', () => {
    const env = makeEnvelope({
      artifacts: [{ path: 'docs/a.md', kind: 'doc', summary: 'A', hash: 'x', sizeBytes: 1 }],
      environment: {
        verified: [{ key: 'env.node.version', value: '22', cmd: 'node --version', source: 'R1' }],
        unmet: [{ key: 'env.docker', required: 'docker', suggestion: '安装', blocking: ['node-b'] }],
      },
    })
    const section = buildHandoffSection(env, '')
    expect(section).toContain('【上游交接单】')
    expect(section).toContain('你必须读取的产物')
    expect(section).toContain('已确认的事实（禁止重复探测）')
    expect(section).toContain('env.node.version = 22')
    expect(section).toContain('已知未满足（遇到必须停）')
    expect(section).toContain('env.docker')
  })
})

describe('IO：handoff.json 往返', () => {
  it('write → read 一致；不存在/非法 → null', () => {
    const nodeDir = join(tmp, 'productions', 'node-a')
    const env = makeEnvelope({ facts: [{ key: 'k', category: 'api', value: 'v', confidence: 'confirmed', summary: '', source: 'A' }] })
    writeHandoffJson(nodeDir, env)
    const read = readHandoffJson(nodeDir)
    expect(read).not.toBeNull()
    expect(read?.nodeId).toBe('node-a')
    expect(read?.facts).toEqual(env.facts)
    expect(readHandoffJson(join(tmp, 'no-such'))).toBeNull()
    // 非法 JSON → null
    writeFileSync(join(nodeDir, 'handoff.json'), '{not-json', 'utf8')
    expect(readHandoffJson(nodeDir)).toBeNull()
  })
})

describe('兼容层：E1/E2/E3 + 旧 API', () => {
  it('artifactsAsPaths / openIssuesAsStrings', () => {
    const env = makeEnvelope({
      artifacts: [{ path: 'a.md', kind: 'doc', summary: '', hash: '', sizeBytes: 0 }],
      openIssues: [{ id: 'i-1', severity: 'warning', summary: '问题一', suggestedOwner: 'user' }],
    })
    expect(artifactsAsPaths(env)).toEqual(['a.md'])
    expect(openIssuesAsStrings(env)).toEqual(['问题一'])
  })

  it('fromLegacyHandoff：旧四字段 → 新 envelope', () => {
    const legacy: Handoff = {
      summary: '旧摘要',
      artifacts: ['a.md', 'b.md'],
      openIssues: ['问题1', '问题2'],
      provenance: { roleId: 'R1', nodeId: 'node-a', at: 123, graphId: 'g-1', graphVersion: '0.1.0' },
    }
    const env = fromLegacyHandoff(legacy)
    expect(env.schemaVersion).toBe('1.0')
    expect(env.roleRef).toBe('R1')
    expect(env.artifacts.map((a) => a.path)).toEqual(['a.md', 'b.md'])
    expect(env.openIssues.map((i) => i.summary)).toEqual(['问题1', '问题2'])
    expect(env.handoff.completed).toBe(true)
    expect(validateEnvelope(env)).not.toBeNull()
  })
})

describe('ProjectMemory（重写）', () => {
  it('空态 setFact → current() 非 null（验收 10.1#8，E5）', () => {
    const mem = new ProjectMemory()
    expect(mem.current()).toBeNull()
    mem.setFact({ key: 'k', category: 'environment', value: 'v', confidence: 'confirmed', summary: '', source: 'A' })
    expect(mem.current()).not.toBeNull()
    expect(mem.all()).toHaveLength(1)
  })

  it('mergeEnvelope 累积；byNodeId 取原始；current 取合并', () => {
    const mem = new ProjectMemory()
    mem.mergeEnvelope('node-a', makeEnvelope({ nodeId: 'node-a', facts: [{ key: 'k1', category: 'environment', value: 'a', confidence: 'confirmed', summary: '', source: 'A' }] }))
    mem.mergeEnvelope('node-b', makeEnvelope({ nodeId: 'node-b', facts: [{ key: 'k1', category: 'environment', value: 'b', confidence: 'confirmed', summary: '', source: 'B' }] }))
    expect(mem.current()?.facts[0]?.confidence).toBe('conflict')
    expect(mem.byNodeId('node-a')?.facts[0]?.value).toBe('a')
    expect(mem.byNodeId('node-x')).toBeNull()
  })

  it('toPromptSection 转发 buildHandoffSection；空态返回空串', () => {
    const mem = new ProjectMemory()
    expect(mem.toPromptSection('node-b')).toBe('')
    mem.mergeEnvelope('node-a', makeEnvelope({ nodeId: 'node-a', facts: [] }))
    expect(mem.toPromptSection('node-b')).toContain('【上游交接单】')
  })

  it('extractFactsFromMarkdown 兼容返回 ProjectFact[]（验收 10.1#7）', () => {
    const md = `---
facts:
  - key: env.python.version
    category: environment
    value: "3.14.6"
---
# 正文
`
    const facts = extractFactsFromMarkdown(md, 'R1-requirement')
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ key: 'env.python.version', source: 'R1-requirement' })
  })

  it('deprecated conflicts() 返回 conflict facts（新形态 ProjectFact[]）', () => {
    const mem = new ProjectMemory()
    mem.setFact({ key: 'k', category: 'environment', value: 'v1', confidence: 'confirmed', summary: '', source: 'A' })
    mem.setFact({ key: 'k', category: 'environment', value: 'v2', confidence: 'confirmed', summary: '', source: 'B' })
    expect(mem.conflicts()).toHaveLength(1)
    expect(mem.conflicts()[0]?.confidence).toBe('conflict')
  })
})
