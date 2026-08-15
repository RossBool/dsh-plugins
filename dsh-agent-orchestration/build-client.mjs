// 构建客户端 bundle：esbuild(cjs) → __ModuleLoader__.load 包装
// （与 dsh-voice/build-client.mjs 相同惯例；@xyflow/react 打进 bundle，react 走 DSH 平台种子）
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'

const result = await build({
  entryPoints: ['src/client.jsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots'],
  logLevel: 'info',
  target: ['es2020'],
})

const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-agent-orchestration",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	}
});
`
mkdirSync('dist', { recursive: true })
writeFileSync('dist/client.js', wrapped)
console.log('dist/client.js written:', wrapped.length, 'bytes')
