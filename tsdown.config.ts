import { defineConfig } from 'tsdown'
import { isBuiltin } from 'node:module'

/**
 * dsh-agent-weave 双半端构建配置。
 *
 * Host 半：tsc 编译（tsconfig.json）→ lib/，本配置不参与。
 * Client 半：tsc 编译（tsconfig.client.json）→ lib/client/index.js，
 *   再由 tsdown 打包为浏览器 bundle lib/client.js（ModuleLoader 闭包工厂形态）。
 *
 * 契约依据：DSH 官方 clientBundle preset（packages/client/tsdown.client.ts）——
 *   banner/footer/intro 为 `window.__ModuleLoader__.load({ id, factory })` 闭包形态；
 *   cordis 等运行时依赖保持 external（由 loader module table 提供），其余内联。
 */
export default defineConfig({
  name: 'dsh-agent-weave/client',
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // cordis DI 实体由 loader module table 提供：保持 external。
    neverBundle: (id: string) => id === '@deepseek-ai/cordis',
    // 其余一律内联（浏览器没有 node_modules 解析）。
    alwaysBundle: (id: string) => !isBuiltin(id) && id !== '@deepseek-ai/cordis',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-agent-weave", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
