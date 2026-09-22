/**
 * 观察者信号（MVP-2 T15）。
 *
 * 零 Token 的结构化信号：GREEN / YELLOW / RED。
 */
export interface ObserverSignal {
  id: string
  observer_id: string
  correlation_id: string
  observed_node: string
  signal_level: 'green' | 'yellow' | 'red'
  concern_level: 'none' | 'minor' | 'significant' | 'critical'
  action: 'silent' | 'internal-log' | 'send-question' | 'send-red-signal'
  criteria_matched: string[]
  summary: string
  timestamp: number
  token_used: number
}

/** 构造一个 L1 观察者信号（纯数据，零 Token）。 */
export function createObserverSignal(input: {
  observer_id: string
  observed_node: string
  signal_level: ObserverSignal['signal_level']
  criteria_matched: string[]
  summary: string
  correlation_id?: string
}): ObserverSignal {
  const concern =
    input.signal_level === 'red'
      ? ('critical' as const)
      : input.signal_level === 'yellow'
        ? ('minor' as const)
        : ('none' as const)
  const action =
    input.signal_level === 'red'
      ? ('send-red-signal' as const)
      : input.signal_level === 'yellow'
        ? ('internal-log' as const)
        : ('silent' as const)
  return {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    observer_id: input.observer_id,
    correlation_id: input.correlation_id ?? '',
    observed_node: input.observed_node,
    signal_level: input.signal_level,
    concern_level: concern,
    action,
    criteria_matched: [...input.criteria_matched],
    summary: input.summary,
    timestamp: Date.now(),
    token_used: 0,
  }
}
