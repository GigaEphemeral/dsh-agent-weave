/**
 * 图控制（MVP-4 P4.B.5 + Bugs-V2 问题3 修法4：文件写入日志）。
 *
 * 通过标志文件控制运行中的图：PAUSE / RESUME / STOP。
 * 与 l2-engine/chain-runner 的 pause/stop 机制一致（productionsRoot 下的标志文件）。
 */
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../../shared/logger.js'

export async function pauseGraph(_graphId: string, productionsRoot: string): Promise<void> {
  const path = join(productionsRoot, 'PAUSE')
  writeFileSync(path, '', 'utf8')
  logger.info('weave-control', '写入 PAUSE 文件', { path })
}

export async function resumeGraph(_graphId: string, productionsRoot: string): Promise<void> {
  const resumePath = join(productionsRoot, 'RESUME')
  const pausePath = join(productionsRoot, 'PAUSE')
  writeFileSync(resumePath, '', 'utf8')
  // ★ v2：删除 PAUSE 文件（否则引擎文件层永远等待）
  try {
    unlinkSync(pausePath)
    logger.info('weave-control', 'resume 清理 PAUSE 文件', { pausePath })
  } catch {
    // 无 PAUSE 文件忽略
  }
  logger.info('weave-control', '写入 RESUME 文件', { resumePath })
}

export async function stopGraph(_graphId: string, productionsRoot: string): Promise<void> {
  const path = join(productionsRoot, 'STOP')
  writeFileSync(path, '', 'utf8')
  logger.info('weave-control', '写入 STOP 文件', { path })
}
