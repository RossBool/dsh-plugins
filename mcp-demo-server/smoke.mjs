/**
 * Smoke test: spawn mcp-demo-server as an MCP stdio child, list tools,
 * exercise echo/add/memory round-trip, then exit 0/1.
 * Usage: node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(here, 'server.js')

const transport = new StdioClientTransport({
  command: process.env.MCP_DEMO_NODE ?? process.execPath,
  args: [serverPath],
  cwd: here,
})
const client = new Client({ name: 'mcp-demo-smoke', version: '1.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
const names = tools.map((t) => t.name).sort()
console.log('tools (' + names.length + '): ' + names.join(', '))
if (!['add', 'echo', 'now', 'uuid', 'memory_set', 'memory_get', 'memory_list', 'memory_delete'].every((n) => names.includes(n))) {
  throw new Error('expected tool set missing')
}

const echo = await client.callTool({ name: 'echo', arguments: { text: 'hello-mcp' } })
console.log('echo  →', JSON.stringify(echo.content))
const add = await client.callTool({ name: 'add', arguments: { a: 2, b: 40 } })
console.log('add   →', JSON.stringify(add.content))
const now = await client.callTool({ name: 'now', arguments: {} })
console.log('now   →', JSON.stringify(now.content))

await client.callTool({ name: 'memory_set', arguments: { key: 'smoke-test', value: '你好 MCP' } })
const got = await client.callTool({ name: 'memory_get', arguments: { key: 'smoke-test' } })
console.log('memory_get  →', JSON.stringify(got.content))
const list = await client.callTool({ name: 'memory_list', arguments: {} })
console.log('memory_list →', JSON.stringify(list.content))
await client.callTool({ name: 'memory_delete', arguments: { key: 'smoke-test' } })
const gone = await client.callTool({ name: 'memory_get', arguments: { key: 'smoke-test' } })
console.log('after delete →', JSON.stringify(gone.content))

await client.close()
console.log('SMOKE OK')
