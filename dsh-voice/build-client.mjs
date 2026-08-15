// 构建客户端 bundle：esbuild(cjs) → __ModuleLoader__.load 包装
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'

const result = await build({
  entryPoints: ['src/client.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-api-remotes'],
  logLevel: 'info',
  target: ['es2020'],
})

const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-voice",
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
