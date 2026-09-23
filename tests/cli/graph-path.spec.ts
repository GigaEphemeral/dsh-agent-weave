/**
 * 图路径解析单测（MVP-4 问题 3：loadGraphSpec 接 exec.workspace，非 process.cwd()）。
 *
 * 覆盖：绝对路径原样 / 相对路径基于 workspace / 无 workspace 回退 cwd /
 * exec.workspace 优先于 agent.session.header.cwd。
 */
import { describe, expect, it } from 'vitest'
import { isAbsolute, join } from 'node:path'
import { resolveGraphPath, resolveExecWorkspace, loadGraphSpec } from '../../src/cli/graph-commands'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const WS = join(process.cwd(), 'test-env', 'runs', 'graph-path-spec-ws')
const SPEC = `version: '1'
graphVersion: '0.1.0'
graphSchemaHash: 'h'
entryPoint: 'a'
nodes:
  - id: a
    nodeType: role
    roleRef: R1
edges: []
checkpoint:
  strategy: node-level
  storage: fs
metadata:
  source: yaml
  createdAt: '2026-01-01T00:00:00Z'
  updatedAt: '2026-01-01T00:00:00Z'
`

describe('问题3 图路径解析', () => {
  it('绝对路径原样返回', () => {
    expect(resolveGraphPath('D:/abs/g.yaml')).toBe('D:/abs/g.yaml')
    expect(isAbsolute(resolveGraphPath('C:\\x\\y.yaml'))).toBe(true)
  })

  it('相对路径基于 workspace 拼接', () => {
    const p = resolveGraphPath('MVP-4/graphs/g.yaml', WS)
    expect(p).toBe(join(WS, 'MVP-4', 'graphs', 'g.yaml'))
    expect(isAbsolute(p)).toBe(true)
  })

  it('无 workspace 回退 process.cwd()', () => {
    expect(resolveGraphPath('graphs/g.yaml')).toBe(join(process.cwd(), 'graphs', 'g.yaml'))
  })

  it('resolveExecWorkspace 优先 exec.workspace', () => {
    expect(resolveExecWorkspace({ workspace: WS })).toBe(WS)
    expect(resolveExecWorkspace({ agent: { session: { header: { cwd: WS } } } })).toBe(WS)
    // workspace 优先于 agent cwd
    expect(resolveExecWorkspace({ workspace: WS, agent: { session: { header: { cwd: '/other' } } } })).toBe(WS)
    // 空对象回退 undefined
    expect(resolveExecWorkspace({})).toBeUndefined()
    expect(resolveExecWorkspace(null)).toBeUndefined()
  })

  it('loadGraphSpec 基于 workspace 读文件', () => {
    const dir = join(WS, 'MVP-4', 'graphs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'g.yaml'), SPEC, 'utf8')
    const spec = loadGraphSpec('MVP-4/graphs/g.yaml', WS)
    expect(spec.entryPoint).toBe('a')
    rmSync(WS, { recursive: true, force: true })
  })
})
