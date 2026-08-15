/**
 * build.mjs — 把纯状态机 machine.js 嵌入 client.template.js，产出客户端 bundle：
 *   1. 读取 machine.js，剥离 `export ` 前缀（变成本作用域声明）；
 *   2. 替换 client.template.js 中的 // @@MACHINE@@ 标记；
 *   3. 写出 prompt-enhancer-ui/client.js；
 *   4. 同步到 profile 的 web/node_modules（该路径是指向本目录的符号链接，写入即部署；浏览器热更新/刷新后生效）。
 *
 * 用法：node build.mjs
 * 单一事实源：machine.js（node --test 直接测它，bundle 用同一份代码，零漂移）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const machine = readFileSync(join(here, 'machine.js'), 'utf8')
const template = readFileSync(join(here, 'client.template.js'), 'utf8')

// 剥离 ESM export 前缀（machine.js 无 default export，只有 export const/function）
const inlined = machine.replace(/^\s*export\s+/gm, '').trim()

if (!template.includes('// @@MACHINE@@')) {
  console.error('client.template.js 缺少 // @@MACHINE@@ 标记，中止')
  process.exit(1)
}
const bundle = template.replace('// @@MACHINE@@', inlined)

// 1. 写入插件目录
const outPath = join(here, 'client.js')
writeFileSync(outPath, bundle)
console.log('built', outPath, `(${bundle.length} bytes)`)

// 2. 同步到 profile 的 web/node_modules（dsh 从那里提供 /plugins/<id>/client.js）
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const deployed = join(dshHome, 'profiles', 'web', 'node_modules', 'prompt-enhancer-ui', 'client.js')
try {
  mkdirSync(dirname(deployed), { recursive: true })
  writeFileSync(deployed, bundle)
  console.log('deployed', deployed)
} catch (error) {
  console.error('部署到 web/node_modules 失败（可手动 cp）:', error.message)
  process.exit(1)
}
