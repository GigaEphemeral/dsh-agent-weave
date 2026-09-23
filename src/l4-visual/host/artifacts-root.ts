/**
 * 产物根目录解析（MVP-4 P4.0.3，修复 P0-3：artifactsRoot 用 cwd 违反 R45）。
 *
 * 统一产物根目录的来源：
 * 1. 显式传入（output_dir / Config.artifactsRoot）
 * 2. workspace 目录（exec.workspace/productions）
 * 3. process.cwd()/productions 兜底
 */
import { join } from 'node:path'

export interface ArtifactsRootInput {
  explicit?: string | undefined
  workspace?: string | undefined
}

export function resolveArtifactsRoot(input: ArtifactsRootInput = {}): string {
  if (input.explicit) return input.explicit
  if (input.workspace) return join(input.workspace, 'productions')
  return join(process.cwd(), 'productions')
}
