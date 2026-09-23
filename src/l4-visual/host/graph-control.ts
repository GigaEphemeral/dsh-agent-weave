/**
 * 图控制（MVP-4 P4.B.5）。
 *
 * 通过标志文件控制运行中的图：PAUSE / RESUME / STOP。
 * 与 l2-engine/chain-runner 的 pause/stop 机制一致（productionsRoot 下的标志文件）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function pauseGraph(_graphId: string, productionsRoot: string): Promise<void> {
  writeFileSync(join(productionsRoot, 'PAUSE'), '', 'utf8')
}

export async function resumeGraph(_graphId: string, productionsRoot: string): Promise<void> {
  writeFileSync(join(productionsRoot, 'RESUME'), '', 'utf8')
}

export async function stopGraph(_graphId: string, productionsRoot: string): Promise<void> {
  writeFileSync(join(productionsRoot, 'STOP'), '', 'utf8')
}
