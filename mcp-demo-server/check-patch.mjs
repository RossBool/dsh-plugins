import yaml from 'js-yaml'
import { readFileSync } from 'node:fs'
const doc = yaml.load(readFileSync('/Users/zhoujunren/.dsh/profiles/web/cordis.patch.yml', 'utf8'))
if (!Array.isArray(doc)) throw new Error('not a top-level array')
console.log('top-level entries:', doc.length)
const rows = doc.flatMap((e) => e.insert ?? [])
console.log('inserted rows:', rows.map((r) => r.id).join(', '))
const mcp = rows.find((r) => r.id === 'mcp-demo')
if (!mcp) throw new Error('mcp-demo row missing')
console.log('mcp-demo config:', JSON.stringify(mcp.config, null, 2))
console.log('YAML PARSE OK')
