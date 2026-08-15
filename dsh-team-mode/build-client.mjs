// build-client.mjs — 把 src/client.jsx 编译到 dist/client.js（IIFE 形式）
// 不引入 React/antd 之外的运行时——dsh.client manifest 在 host 侧注入 React。
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

await mkdir(resolve(__dirname, 'dist'), { recursive: true })

await build({
  entryPoints: [resolve(__dirname, 'src/client.jsx')],
  outfile: resolve(__dirname, 'dist/client.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'transform',
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  logLevel: 'info',
})

console.log('dsh-team-mode: client bundle built → dist/client.js')