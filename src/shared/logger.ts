/**
 * 结构化日志基础设施（MVP-1 P1.1.4）。
 *
 * 设计：
 * - 统一 LogEntry 结构，字段化而非字符串拼接
 * - AsyncLocalStorage 贯穿 trace_id / node_id / role_id / correlation_id
 * - 脱敏工具：truncate（截断长文本）/ ref（工件引用）/ fingerprint（内容指纹）
 * - 不记录完整 prompt、凭证、PII（开发契约 §7.4）
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** 日志级别（对齐常用日志框架）。 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** 一条结构化日志条目。 */
export interface LogEntry {
  ts: number
  level: LogLevel
  component: string
  msg: string
  trace_id?: string
  node_id?: string
  role_id?: string
  correlation_id?: string
  child_id?: string
  error?: { name: string; message: string; stack?: string }
  data?: Record<string, unknown>
}
/** AsyncLocalStorage 中贯穿的关联上下文。 */
export interface TraceContext {
  trace_id: string
  node_id?: string
  role_id?: string
  correlation_id?: string
  child_id?: string
}

const traceStore = new AsyncLocalStorage<TraceContext>()

/** 记录到控制台的底层函数（统一出口，避免散落 console.log）。 */
function write(entry: LogEntry): void {
  const line = JSON.stringify(entry)
  // 结构化输出走 stdout；错误级别走 stderr
  if (entry.level === 'error' || entry.level === 'fatal') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

/** 合并 AsyncLocalStorage 上下文与显式覆盖。 */
function withTraceContext(
  level: LogLevel,
  component: string,
  msg: string,
  data?: Record<string, unknown>,
  error?: Error,
): LogEntry {
  const trace = traceStore.getStore()
  const entry: LogEntry = {
    ts: Date.now(),
    level,
    component,
    msg,
    ...(trace?.trace_id !== undefined ? { trace_id: trace.trace_id } : {}),
    ...(trace?.node_id !== undefined ? { node_id: trace.node_id } : {}),
    ...(trace?.role_id !== undefined ? { role_id: trace.role_id } : {}),
    ...(trace?.correlation_id !== undefined ? { correlation_id: trace.correlation_id } : {}),
    ...(trace?.child_id !== undefined ? { child_id: trace.child_id } : {}),
    ...(error !== undefined
      ? { error: { name: error.name, message: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) } }
      : {}),
    ...(data !== undefined && Object.keys(data).length > 0 ? { data } : {}),
  }
  return entry
}

/** 在关联上下文内执行 fn（trace_id 等贯穿其中产生的所有日志）。 */
export function withTrace<T>(ctx: TraceContext, fn: () => T): T {
  return traceStore.run(ctx, fn)
}

/** 读取当前 AsyncLocalStorage 关联上下文（无则 undefined）。 */
export function currentTrace(): TraceContext | undefined {
  return traceStore.getStore()
}

/** 截断字符串到 max 长度（默认 200 字符），超长以省略号标记。 */
export function truncate(s: string, max = 200): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

/** 工件引用：规范化 art:// 引用路径（仅路径，不携带内容）。 */
export function ref(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('art://')) return normalized
  return `art://${normalized.replace(/^\/+/, '')}`
}

/** 内容指纹：对长文本计算短 hash（不泄露内容本身）。 */
export function fingerprint(s: string): string {
  // FNV-1a 32 位（无依赖、确定性、足够区分 prompt 变体）
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return `fp:${hash.toString(16).padStart(8, '0')}`
}

export const logger = {
  fatal(component: string, msg: string, error: Error, data?: Record<string, unknown>): void {
    write(withTraceContext('fatal', component, msg, data, error))
  },
  error(component: string, msg: string, error: Error, data?: Record<string, unknown>): void {
    write(withTraceContext('error', component, msg, data, error))
  },
  warn(component: string, msg: string, data?: Record<string, unknown>): void {
    write(withTraceContext('warn', component, msg, data))
  },
  info(component: string, msg: string, data?: Record<string, unknown>): void {
    write(withTraceContext('info', component, msg, data))
  },
  debug(component: string, msg: string, data?: Record<string, unknown>): void {
    write(withTraceContext('debug', component, msg, data))
  },
  trace(component: string, msg: string, data?: Record<string, unknown>): void {
    write(withTraceContext('trace', component, msg, data))
  },
}

export type Logger = typeof logger
