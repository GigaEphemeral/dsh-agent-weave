/**
 * 终端实时进度视图（MVP-2 T12）。
 *
 * 订阅事件总线，逐行打印执行进度（不刷新整个屏幕，兼容所有终端）：
 * - 状态头：当前节点 / 迭代 / retry / 耗时 / Token（每分钟用 \r 覆盖）
 * - 事件流：▶ 节点开始（绿） / ✓ 完成（蓝） / ⚠ 回退（黄） / ✗ 错误（红）
 *
 * ANSI 颜色编码（无 TTY 时自动降级为纯文本）。
 */
import type { GraphEventBus, ExecutionSnapshot } from './event-bus.js'
import type { TrajectoryEvent } from '../../l2-engine/types.js'

/** ANSI 颜色。 */
const C = {
  green: '\u001b[32m',
  blue: '\u001b[34m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  reset: '\u001b[0m',
}

/** 检测是否支持颜色（非 CI 且 TTY）。 */
export function supportsColor(): boolean {
  return process.stdout.isTTY === true && !process.env.CI
}

/** 格式化事件行（含颜色；color=false 时纯文本）。 */
export function formatEventLine(event: TrajectoryEvent, color: boolean): string {
  const ts = formatTime(event.timestamp)
  const icon = iconFor(event)
  const message = messageFor(event)
  const colorCode = colorFor(event)
  if (color) {
    return `  [${ts}] ${colorCode}${icon} ${message}${C.reset}`
  }
  return `  [${ts}] ${icon} ${message}`
}

function formatTime(timestamp: number): string {
  const s = Math.floor((Date.now() - timestamp) / 1000)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function iconFor(event: TrajectoryEvent): string {
  switch (event.type) {
    case 'graph/node-start':
      return '▶'
    case 'graph/node-end':
      return '✓'
    case 'graph/loop-iteration':
      return '⚠'
    case 'graph/node-error':
    case 'graph/error':
      return '✗'
    case 'graph/checkpoint-written':
      return '💾'
    default:
      return '·'
  }
}

function messageFor(event: TrajectoryEvent): string {
  switch (event.type) {
    case 'graph/start':
      return `图开始: ${event.graphId}`
    case 'graph/node-start':
      return `${event.node} 开始`
    case 'graph/node-end': {
      const ms = event.durationMs ?? 0
      const tokens = event.data?.tokenUsed as number | undefined
      return `${event.node} 完成 (${(ms / 1000).toFixed(1)}s${tokens !== undefined ? `, ${tokens} tokens` : ''})`
    }
    case 'graph/loop-iteration': {
      const iter = event.data?.iteration as number | undefined
      const max = event.data?.maxIter as number | undefined
      return `回退到 ${event.node}${iter !== undefined ? ` (${iter}/${max ?? '∞'})` : ''}`
    }
    case 'graph/node-error':
      return `${event.node} 出错: ${String(event.data?.error ?? '')}`
    case 'graph/error':
      return `图错误: ${String(event.data?.error ?? '')}`
    case 'graph/checkpoint-written':
      return `checkpoint 已写入 @${event.node} iter=${String(event.data?.iteration ?? '')}`
    case 'graph/end':
      return '图结束'
    default:
      return event.type
  }
}

function colorFor(event: TrajectoryEvent): string {
  switch (event.type) {
    case 'graph/node-start':
      return C.green
    case 'graph/node-end':
      return C.blue
    case 'graph/loop-iteration':
      return C.yellow
    case 'graph/node-error':
    case 'graph/error':
      return C.red
    default:
      return C.cyan
  }
}

/** 渲染状态头（当前节点/迭代/retry/耗时/Token）。 */
export function formatStatusHeader(snap: ExecutionSnapshot, color: boolean): string {
  const line = `当前节点: ${snap.current || '(启动中)'} | 迭代: ${snap.iteration}/${snap.maxIterations} | retry: ${snap.retryCount}/${snap.maxRetry} | 耗时: ${(snap.elapsedMs / 1000).toFixed(0)}s | Token: ${snap.tokenUsed.toLocaleString()}`
  if (color) {
    const statusColor =
      snap.status === 'failed' ? C.red : snap.status === 'completed' ? C.blue : C.green
    return `${C.cyan}${line}${C.reset} ${statusColor}[${snap.status}]${C.reset}`
  }
  return `${line} [${snap.status}]`
}

/** 终端视图：订阅总线并逐行打印（返回停止函数）。 */
export function createTerminalView(
  bus: GraphEventBus,
  output: (line: string) => void = (l) => console.log(l),
): { start(): void; stop(): void } {
  const color = supportsColor()
  let stopped = false

  function handle(event: TrajectoryEvent): void {
    if (stopped) return
    output(formatEventLine(event, color))
    // 节点结束时刷新状态头
    if (event.type === 'graph/node-end' || event.type === 'graph/loop-iteration') {
      output(formatStatusHeader(bus.getSnapshot(), color))
    }
  }

  return {
    start() {
      bus.subscribe(handle)
      output(`${C.cyan}════ MVP-2 Graph Execution ${C.reset}`)
      output(formatStatusHeader(bus.getSnapshot(), color))
    },
    stop() {
      stopped = true
      output(formatStatusHeader(bus.getSnapshot(), color))
      output(`${C.cyan}════ 执行结束 ${C.reset}`)
    },
  }
}
