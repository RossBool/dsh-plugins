/**
 * Validate the exact mcp-client row config from cordis.patch.yml against the
 * plugin's Schemastery schema — the same validation the loader performs.
 * Usage: node schema-check.mjs
 */
import { Config } from '@deepseek-ai/dsh-mcp-client'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const resolved = Config({
  transport: 'stdio',
  serverName: 'demo',
  command: process.env.MCP_DEMO_NODE ?? process.execPath,
  args: [resolve(here, 'server.js')],
  cwd: here,
  env: {},
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
})
console.log('config validated:', JSON.stringify(resolved, null, 2))
