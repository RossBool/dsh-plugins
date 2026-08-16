import yaml from 'js-yaml'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// 用法：node check-patch.mjs [patch路径]，默认 $HOME/.dsh/profiles/web/cordis.patch.yml
const patchPath = process.argv[2] || process.env.DSH_WEB_PATCH || join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
const doc = yaml.load(readFileSync(patchPath, 'utf8'))
if (!Array.isArray(doc)) throw new Error('not a top-level array')
console.log('top-level entries:', doc.length)
const rows = doc.flatMap((e) => e.insert ?? [])
console.log('inserted rows:', rows.map((r) => r.id).join(', '))
const mcp = rows.find((r) => r.id === 'mcp-demo')
if (!mcp) throw new Error('mcp-demo row missing')
console.log('mcp-demo config:', JSON.stringify(mcp.config, null, 2))
console.log('YAML PARSE OK')
