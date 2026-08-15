/**
 * mcp-demo-server — a minimal stdio MCP server for the dsh web profile.
 *
 * Demonstrates the @deepseek-ai/dsh-mcp-client bridge: every tool registered
 * here becomes a harness tool named mcp__demo__<tool> for the agent.
 * Also provides a tiny persistent string KV store as a "real capability" demo.
 *
 * Run standalone: node server.js   (speaks MCP over stdio; stderr is free for logs)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const here = dirname(fileURLToPath(import.meta.url))
const storagePath = resolve(process.env.MCP_DEMO_STORAGE ?? resolve(here, 'storage.json'))

function loadStore() {
  try {
    if (existsSync(storagePath)) return JSON.parse(readFileSync(storagePath, 'utf8'))
  } catch (error) {
    console.error('[mcp-demo] storage read failed, starting empty:', String(error))
  }
  return {}
}

function saveStore(store) {
  writeFileSync(storagePath, JSON.stringify(store, null, 2), 'utf8')
}

const store = loadStore()

const text = (value) => ({ content: [{ type: 'text', text: value }] })

const server = new McpServer({ name: 'mcp-demo', version: '1.0.0' })

server.registerTool('echo', {
  title: 'Echo',
  description: 'Echo text back unchanged — connectivity smoke test for the MCP bridge.',
  inputSchema: { text: z.string().describe('Text to echo back') },
}, async ({ text: t }) => text(t))

server.registerTool('add', {
  title: 'Add',
  description: 'Add two numbers and return the sum.',
  inputSchema: { a: z.number(), b: z.number() },
}, async ({ a, b }) => text(String(a + b)))

server.registerTool('now', {
  title: 'Now',
  description: 'Return the current date and time (ISO 8601 and epoch milliseconds).',
  inputSchema: {},
}, async () => {
  const d = new Date()
  return text(JSON.stringify({ iso: d.toISOString(), epochMs: d.getTime() }))
})

server.registerTool('uuid', {
  title: 'UUID',
  description: 'Generate a random UUID v4.',
  inputSchema: {},
}, async () => text(randomUUID()))

server.registerTool('memory_set', {
  title: 'Memory Set',
  description: 'Persist a string value under a key in the demo durable store.',
  inputSchema: { key: z.string(), value: z.string() },
}, async ({ key, value }) => {
  store[key] = value
  saveStore(store)
  return text('ok')
})

server.registerTool('memory_get', {
  title: 'Memory Get',
  description: 'Read the persisted value for a key (empty string when missing).',
  inputSchema: { key: z.string() },
}, async ({ key }) => text(store[key] ?? ''))

server.registerTool('memory_list', {
  title: 'Memory List',
  description: 'List all keys in the demo durable store.',
  inputSchema: {},
}, async () => text(JSON.stringify(Object.keys(store).sort())))

server.registerTool('memory_delete', {
  title: 'Memory Delete',
  description: 'Delete a key from the demo durable store.',
  inputSchema: { key: z.string() },
}, async ({ key }) => {
  const existed = key in store
  delete store[key]
  saveStore(store)
  return text(existed ? 'deleted' : 'missing')
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[mcp-demo] started (pid ${process.pid}, storage ${storagePath})`)
