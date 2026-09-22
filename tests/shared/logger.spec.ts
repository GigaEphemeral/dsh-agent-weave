/**
 * shared/logger.ts 单测（P1.1.4 验收）。
 *
 * 验证：LogEntry 结构、AsyncLocalStorage trace 贯穿、脱敏工具（truncate/ref/fingerprint）。
 * 通过替换 process.stdout/stderr 捕获结构化输出。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprint, logger, ref, truncate, withTrace } from '../../src/shared/logger'

function captureStdout(): { spy: ReturnType<typeof vi.spyOn>; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return {
    spy,
    lines: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
  }
}

describe('logger 结构化输出', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('输出 JSON 行且包含必填字段', () => {
    const { spy, lines } = captureStdout()
    logger.info('role-loader', '注册角色 R6', { role_id: 'R6-developer' })
    spy.mockRestore()
    const [line] = lines()
    expect(line).toBeDefined()
    expect(typeof line?.ts).toBe('number')
    expect(line?.level).toBe('info')
    expect(line?.component).toBe('role-loader')
    expect(line?.msg).toBe('注册角色 R6')
    expect(line?.data).toEqual({ role_id: 'R6-developer' })
  })

  it('error 级别走 stderr 且携带错误对象', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const chunks: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    const err = new Error('boom')
    logger.error('role-loader', '加载失败', err, { role_id: 'R6' })
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    expect(chunks.length).toBe(1)
    const parsed = JSON.parse(chunks[0] ?? '{}') as Record<string, unknown>
    expect(parsed.level).toBe('error')
    expect((parsed.error as { message: string }).message).toBe('boom')
  })
})

describe('withTrace AsyncLocalStorage 贯穿', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('trace_id 贯穿异步上下文内产生的日志', async () => {
    const { spy, lines } = captureStdout()
    await withTrace({ trace_id: 'trace-123', node_id: 'node-1' }, async () => {
      logger.info('engine', '节点开始')
      await Promise.resolve()
      logger.warn('engine', '节点告警', { role_id: 'R6' })
    })
    spy.mockRestore()
    const all = lines()
    expect(all.length).toBe(2)
    for (const line of all) {
      expect(line.trace_id).toBe('trace-123')
      expect(line.node_id).toBe('node-1')
    }
    expect(all[1]?.data).toEqual({ role_id: 'R6' })
  })

  it('上下文外无 trace_id', () => {
    const { spy, lines } = captureStdout()
    logger.info('engine', '无 trace')
    spy.mockRestore()
    expect(lines()[0]?.trace_id).toBeUndefined()
  })
})

describe('脱敏工具', () => {
  it('truncate 短文本原样、长文本截断', () => {
    expect(truncate('short')).toBe('short')
    const long = 'a'.repeat(300)
    expect(truncate(long, 200)).toHaveLength(201)
    expect(truncate(long, 200)).toMatch(/…$/)
  })

  it('ref 规范化为 art:// 引用', () => {
    expect(ref('productions/R1/prd.md')).toBe('art://productions/R1/prd.md')
    expect(ref('art://productions/R1/prd.md')).toBe('art://productions/R1/prd.md')
    expect(ref('C:\\work\\a.md')).toBe('art://C:/work/a.md')
  })

  it('fingerprint 确定性且短', () => {
    const f1 = fingerprint('hello world')
    const f2 = fingerprint('hello world')
    const f3 = fingerprint('hello world!')
    expect(f1).toBe(f2)
    expect(f1).not.toBe(f3)
    expect(f1).toMatch(/^fp:[0-9a-f]{8}$/)
  })
})
