/**
 * publish_finding 工具（Bugs-V1 §7：声明探测发现，供下游避免重复探测）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { appendFinding } from './findings-pool.js'
import type { Finding } from '../shared/types.js'
import { logger } from '../shared/logger.js'

export interface FindingContext {
  artifactsRoot: string | undefined
  graphId: string
  nodeId: string
}

export function registerPublishFindingTool(
  ctx: Context,
  getContext: () => FindingContext,
): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'publish_finding',
      description:
        '声明一条探测发现（写入本图共享发现池），供后续节点避免重复探测。' +
        '典型场景：探测 API 返回格式、查询工具版本、确认文件存在、确定技术选型。' +
        '注意：你仍必须在最终产物的 <!-- weave-handoff --> 块里重复这些发现（除非 reusable=false）。',
      parameters: {
        kind: { type: 'string', required: true, description: 'endpoint | version | decision | error | other' },
        what: { type: 'string', required: true, description: '探测对象（人类可读）' },
        how: { type: 'string', required: true, description: '探测方式（命令/URL）' },
        result: { type: 'string', required: true, description: '探测结果摘要（≤500 字）' },
        reusable: { type: 'boolean', description: '是否可复用（默认 true）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
      },
      output: {
        schema: { type: 'string' },
        render(_a, v) {
          return [{ type: 'text', text: v as string }]
        },
      },
      async execute(args) {
        const c = getContext()
        if (!c.artifactsRoot || !c.graphId || !c.nodeId) return '⚠ 无活动图上下文，finding 未记录'
        const finding: Finding = {
          at: Date.now(),
          node: c.nodeId,
          kind: args.kind as Finding['kind'],
          what: String(args.what),
          how: String(args.how),
          result: String(args.result).slice(0, 500),
          reusable: args.reusable !== false,
          ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
        }
        const ok = appendFinding(c.artifactsRoot, c.graphId, finding, (msg) => logger.warn('weave', msg))
        return ok ? `✅ 已记录到共享发现池（${args.kind}: ${args.what}）` : `⚠ ${args.what} 未记录（超上限）`
      },
    }),
  )
}
