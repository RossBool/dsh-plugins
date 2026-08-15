/**
 * Validate the exact mcp-client row config from cordis.patch.yml against the
 * plugin's Schemastery schema — the same validation the loader performs.
 * Usage: node schema-check.mjs
 */
import { Config } from '@deepseek-ai/dsh-mcp-client'

const resolved = Config({
  transport: 'stdio',
  serverName: 'demo',
  command: '/Users/zhoujunren/Library/PhpWebStudy/app/nodejs/v22.21.1/bin/node',
  args: ['/Users/zhoujunren/.dsh/profiles/plugins/mcp-demo-server/server.js'],
  cwd: '/Users/zhoujunren/.dsh/profiles/plugins/mcp-demo-server',
  env: {},
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
})
console.log('config validated:', JSON.stringify(resolved, null, 2))
