// scripts/build-client.mjs
// 用 esbuild 打包 src/client 为 IIFE，再包进 DSH ModuleLoader 契约的 wrapper。
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function indent(text, prefix) {
  return text
      .split('\n')
      .map((line) => (line ? prefix + line : line))
      .join('\n')
}

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'iife',
  globalName: 'WeaveClientBundle',
  platform: 'browser',
  target: 'es2024',
  jsx: 'automatic',
  // external 与 dsh.client.external 保持一致
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  write: false,
  logLevel: 'info',
})

const bundleText = result.outputFiles[0].text

const out = `window.__ModuleLoader__.load({
  id: "dsh-agent-weave",
  factory: function (require) {
${indent(bundleText, '    ')}
    return WeaveClientBundle;
  },
});
`

mkdirSync(dirname('lib/client.js'), { recursive: true })
writeFileSync('lib/client.js', out, 'utf8')
console.log('[build-client] written lib/client.js:', out.length, 'bytes')