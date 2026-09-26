/**
 * 可视化运行时聚合（MVP-4 Phase B 入口）。
 *
 * 聚合 SSE broker + approval 服务 + 图控制，向 webServer 注册 REST 路由。
 * 通过 ctx.get('webServer') 鸭子类型接入（headless 环境静默跳过，不阻塞插件）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSseBroker, type SseBroker } from './sse-broker.js'
import { createApprovalService, type ApprovalService } from './approval-service.js'
import { registerVisualRoutes } from './routes.js'
import { startEventBridge } from './event-bridge.js'
import { getGlobalSnapshot } from './shared-bus.js'
import { getGraph } from './spec-registry.js'
import { resolveArtifactsRoot } from './artifacts-root.js'
import { createTokenCollector, type TokenCollector } from '../../l5-observability/token-collector.js'

/** 可视化运行时实例。 */
export interface VisualRuntime {
  broker: SseBroker
  approvals: ApprovalService
  tokens: TokenCollector
  dispose(): void
}

/** webServer 最小鸭子类型（来自 @deepseek-ai/dsh-host-webserver）。 */
export interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void
}

/** 全局 Token 分账收集器（引擎 node-end 写入；REST /tokens 读取）。 */
let globalTokens: TokenCollector | null = null

/** 全局 SSE broker（任务事件 / 面板推送用）。 */
let globalBroker: SseBroker | null = null

/** 获取全局 SSE broker（headless 未初始化时为 null）。 */
export function getGlobalBroker(): SseBroker | null {
  return globalBroker
}

/** 获取全局 TokenCollector（惰性创建，幂等）。 */
export function getGlobalTokens(): TokenCollector {
  if (!globalTokens) globalTokens = createTokenCollector()
  return globalTokens
}

/** 在 webServer 可用时挂载可视化路由。 */
export function registerVisualRuntime(ctx: Context): () => void {
  const broker = createSseBroker()
  globalBroker = broker
  const approvals = createApprovalService(broker)
  const tokens = getGlobalTokens()

  const disposers: Array<() => void> = []
  const bridgeDispose = startEventBridge(ctx, broker)
  disposers.push(bridgeDispose)

  // 轮询等待 webServer（与 MVP-2 reference 同机制；headless 静默跳过）
  const attempts = 25
  const pollMs = 200
  let disposed = false
  void (async () => {
    for (let attempt = 0; attempt < attempts && !disposed; attempt += 1) {
      let webServer: WebServerLike | undefined
      try {
        webServer = ctx.get('webServer') as WebServerLike | undefined
      } catch {
        // headless / 尚未就绪
      }
      if (webServer?.register) {
        const unreg = registerVisualRoutes(ctx, broker, approvals, tokens, webServer)
        disposers.push(unreg)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  })()
  ctx.on('dispose' as never, (() => {
    disposed = true
  }) as never)

  return () => {
    disposed = true
    for (const d of disposers) d()
    broker.dispose()
  }
}

// 导出供 routes.ts 复用（避免循环依赖）
export { getGlobalSnapshot, getGraph, resolveArtifactsRoot, createTokenCollector }
