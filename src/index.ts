import type { Context } from '@deepseek-ai/cordis'

/**
 * dsh-agent-weave 插件入口（Host 半端）。
 *
 * MVP-1：占位骨架，注册角色 Provider 的流程在 P1.1.6 实现。
 */
export const name = 'dsh-agent-weave'

/** 声明依赖的服务：subagents（子代理注册表）+ skills（角色 prompt 加载）。 */
export const inject = ['subagents', 'skills']

export interface Config {
  /** 角色定义文件所在目录，默认 ./roles */
  rolesDir?: string
  /** 技能文件所在目录，默认 ./skills */
  skillsDir?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.logger.info('weave', '插件已加载', {
    roles_dir: config.rolesDir,
    skills_dir: config.skillsDir,
  })
}
