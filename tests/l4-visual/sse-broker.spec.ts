/**
 * SSE broker 单测（MVP-4 P4.A.3）。
 *
 * 覆盖：订阅/广播/注销 / 按 graphId 过滤 / subscriberCount / dispose。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { createSseBroker } from '../../src/l4-visual/host/sse-broker'
import type { WsEvent } from '../../src/l4-visual/shared/event-schema'

/** 构造最小 Response（spy 捕获 write 输出）。 */
function makeRes(): { res: ServerResponse; written: string[] } {
  const written: string[] = []
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((c: string) => { written.push(c); return true }),
    end: vi.fn(),
  } as unknown as ServerResponse
  return { res, written }
}

function ws(overrides: Partial<WsEvent> = {}): WsEvent & { seq?: number } {
  return { trace_id: 'g1', event_type: 'node-start', timestamp: 1, data: {}, ...overrides }
}

describe('P4.A.3 SSE broker', () => {
  it('subscribe 后 broadcast 推给同 graphId 订阅者', () => {
    const broker = createSseBroker()
    const { res, written } = makeRes()
    broker.subscribe('g1', res)
    broker.broadcast('g1', ws({ node: 'a' }))
    expect(written.join('')).toContain('"event_type":"node-start"')
    expect(broker.subscriberCount('g1')).toBe(1)
    broker.dispose()
  })

  it('不同 graphId 不互扰', () => {
    const broker = createSseBroker()
    const { res, written } = makeRes()
    broker.subscribe('g1', res)
    broker.broadcast('g2', ws({ node: 'x' }))
    expect(written.join('')).not.toContain('node-start')
    broker.dispose()
  })

  it('unsubscribe 后不再接收且计数归零', () => {
    const broker = createSseBroker()
    const { res, written } = makeRes()
    const id = broker.subscribe('g1', res)
    broker.unsubscribe(id)
    broker.broadcast('g1', ws())
    expect(written.join('')).not.toContain('node-start')
    expect(broker.subscriberCount('g1')).toBe(0)
  })
})
