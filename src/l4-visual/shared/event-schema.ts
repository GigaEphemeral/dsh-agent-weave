/**
 * 事件流契约（MVP-4 P4.A.1，对齐 OTEL GenAI 语义）。
 *
 * 引擎 TrajectoryEvent → Web 推送 WsEvent 的映射：
 * - trace_id = graphId；span_id = node；gen_ai.agent.name = role
 * - gen_ai.operation.name = node_start/node_end/observer_signal/invoke_agent
 * - gen_ai.usage.* = node-end 携带的 token 数值
 * - event_type = 业务事件类型（供 UI applyEvent 分支）
 */
import { z } from 'zod'
import type { TrajectoryEvent } from '../../l2-engine/types.js'

export const WsEventSchema = z.object({
  // OTEL 对齐
  trace_id: z.string(),
  span_id: z.string().optional(),
  'gen_ai.agent.name': z.string().optional(),
  'gen_ai.operation.name': z.enum([
    'invoke_agent', 'node_start', 'node_end', 'observer_signal',
  ]).optional(),
  'gen_ai.usage.input_tokens': z.number().optional(),
  'gen_ai.usage.output_tokens': z.number().optional(),
  'gen_ai.usage.cache_read_tokens': z.number().optional(),

  // 业务字段
  event_type: z.enum([
    'graph-start', 'node-start', 'node-end', 'node-error',
    'loop-iteration', 'checkpoint-written',
    'observer-signal', 'agent-message',
    'approval-request', 'approval-decided', 'graph-end',
  ]),  node: z.string().optional(),
  timestamp: z.number(),
  data: z.record(z.string(), z.unknown()).default({}),
})

export type WsEvent = z.infer<typeof WsEventSchema>

/** TrajectoryEvent.type → 业务 event_type 映射。 */
export function mapEventType(type: TrajectoryEvent['type']): WsEvent['event_type'] {
  switch (type) {
    case 'graph/start': return 'graph-start'
    case 'graph/node-start': return 'node-start'
    case 'graph/node-end': return 'node-end'
    case 'graph/node-error': return 'node-error'
    case 'graph/loop-iteration': return 'loop-iteration'
    case 'graph/checkpoint-written': return 'checkpoint-written'
    case 'graph/observer-signal': return 'observer-signal'
    case 'graph/end': return 'graph-end'
    default: return 'graph-end' // graph/error → graph-end（保守）
  }
}

/** TrajectoryEvent → WsEvent（OTEL 字段映射 + 业务字段）。 */
export function trajectoryToWsEvent(
  evt: TrajectoryEvent,
  roleMap: Record<string, string>,
): WsEvent {
  const role = evt.node ? roleMap[evt.node] : undefined
  const data = evt.data ?? {}
  return {
    trace_id: evt.graphId,
    ...(evt.node ? { span_id: evt.node } : {}),
    ...(role ? { 'gen_ai.agent.name': role } : {}),
    'gen_ai.operation.name':
      evt.type === 'graph/node-start' ? 'node_start'
      : evt.type === 'graph/node-end' ? 'node_end'
      : evt.type === 'graph/node-error' ? 'node_end'
      : 'invoke_agent',
    ...(typeof data.inputTokens === 'number'
      ? { 'gen_ai.usage.input_tokens': data.inputTokens } : {}),
    ...(typeof data.outputTokens === 'number'
      ? { 'gen_ai.usage.output_tokens': data.outputTokens } : {}),
    ...(typeof data.cacheReadTokens === 'number'
      ? { 'gen_ai.usage.cache_read_tokens': data.cacheReadTokens } : {}),
    event_type: mapEventType(evt.type),
    ...(evt.node ? { node: evt.node } : {}),
    timestamp: evt.timestamp,
    data,
  }
}
