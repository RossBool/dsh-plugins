// dsh-voice 术语纠偏：确定性谐音映射 + 英文拼写规范化（不调 LLM、不改句子结构、幂等）
//
// 背景（第一性原理）：SFSpeechRecognizer 词汇表不含编程术语，且 macOS Speech 框架
// 没有自定义热词/词汇表 API —— 中文语音里的英文专有名词会被识别成同音中文词
// （「道可」→ Docker、「派森」→ Python、「金仓」→ Git…），或拼错英文（Doker/Pythn）。
// 识别层无法注入术语，只能做转写后的确定性后处理。本模块分两层：
//
//   1) 中文谐音 → 标准拼写（DEFAULT_TERMS）：覆盖 ASR 把英文谐音化成中文的情况。
//   2) 英文 token 规范化（STANDARD_TERMS + 编辑距离）：精确匹配做大小写规范化
//      （docker→Docker、PYTHON→Python），保守模糊匹配修拼写错误（Doker→Docker）。
//
// 说明：
// - 谐音表按 wrong 长度降序应用（先长后短），避免「金仓哈勃」被「金仓」先替换。
// - 幂等：替换后的标准拼写不会再被匹配（表内不含标准拼写本身）。
// - 模糊匹配只在 token 长度 ≥5、首字母相同、编辑距离 ≤1、最多漏 1 字母时生效，
//   以控制误伤（普通英文单词/短缩写不会被改）。
// - 用户可通过配置 asr.correction.terms 扩展（键=误识别，值=标准拼写），
//   或 asr.correction.enabled: false 整体关闭。

export const DEFAULT_TERMS: Record<string, string> = {
  // 长词优先（>3 字，误伤极低）
  '泰普斯克利普特': 'TypeScript',
  '库本内提斯': 'Kubernetes',
  '金仓哈勃': 'GitHub',
  '斯普林波特': 'Spring Boot',
  '杰瓦斯科瑞普特': 'JavaScript',
  '贾瓦斯科瑞普特': 'JavaScript',
  '波斯提格雷斯扣': 'PostgreSQL',
  '瑞艾克特': 'React',
  '迪皮克': 'DeepSeek',
  '奥鹏爱': 'OpenAI',
  '恩杰克斯': 'Nginx',
  '蒙戈迪比': 'MongoDB',
  '麦斯扣': 'MySQL',
  '吉特拉布': 'GitLab',
  '金肯斯': 'Jenkins',
  '扣特林': 'Kotlin',
  // 短词（编程语境高频谐音；个别词如「道可」「卡夫卡」在文学语境有极低误伤，可配置关闭）
  '斯佳佳': 'C++',
  '西加加': 'C++',
  '西哈普': 'C++',
  '西莎普': 'C#',
  '金仓': 'Git',
  '吉特': 'Git',
  '派森': 'Python',
  '道可': 'Docker',
  '诺德': 'Node',
  '扎哇': 'Java',
  '贾瓦': 'Java',
  '斯威夫特': 'Swift',
  '拉斯特': 'Rust',
  '鲁比': 'Ruby',
  '维尤': 'Vue',
  '利纽克斯': 'Linux',
  '阿帕奇': 'Apache',
  '迪夫': 'diff',
  '瑞迪斯': 'Redis',
  '卡夫卡': 'Kafka',
  '姜戈': 'Django',
  '斯普林': 'Spring',
  '弗拉特': 'Flutter',
}

// 标准术语词库：用于英文 token 的精确大小写规范化 + 保守拼写纠错。
// 只放专有名词/框架名（不放全大写缩写与普通英文词，避免把 rest/set/next 等普通词改掉）。
const STANDARD_TERMS: string[] = [
  'Docker', 'Python', 'Git', 'GitHub', 'GitLab', 'React', 'Vue', 'Kubernetes',
  'TypeScript', 'JavaScript', 'Java', 'MySQL', 'PostgreSQL', 'MongoDB', 'Redis',
  'Kafka', 'Nginx', 'Apache', 'Linux', 'Swift', 'Rust', 'Kotlin', 'Ruby', 'Django',
  'Flask', 'Spring', 'Laravel', 'Rails', 'Flutter', 'Jenkins', 'Ansible', 'Terraform',
  'Prometheus', 'Grafana', 'TensorFlow', 'PyTorch', 'Pandas', 'OpenAI', 'DeepSeek',
  'Vite', 'Webpack', 'Babel', 'ESLint', 'Prettier', 'Jest', 'Deno', 'Nuxt', 'Svelte',
  'Angular', 'jQuery', 'Bootstrap', 'Tailwind', 'Express', 'Elasticsearch', 'SQLite',
  'ClickHouse', 'InfluxDB', 'DynamoDB', 'RabbitMQ', 'Tomcat', 'Haskell', 'Scala',
  'Elixir', 'Erlang', 'Clojure', 'Keras', 'HuggingFace', 'Homebrew', 'GraphQL',
  'gRPC', 'PyCharm', 'WebStorm', 'IntelliJ', 'Confluence', 'GitBook', 'macOS', 'iOS',
]

/** 编辑距离（Levenshtein），用于英文拼写纠错 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array(n + 1).fill(0).map((_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}

/**
 * 规范化一个英文 token：精确匹配（大小写不敏感）→ 词库标准形式；
 * 否则做保守模糊匹配（长度≥4、前 2 字符相同、编辑距离≤1、最多漏 1 字母）。
 * 用「前 2 字符」而非「首字母」匹配，以区分普通词与术语（如 rest 的 "re" vs Rust 的 "ru"），
 * 避免把 rest/set/data/file 等普通英文词改掉。未命中返回原 token。
 */
function normalizeToken(token: string): string {
  const lower = token.toLowerCase()
  // 精确匹配（大小写规范化）
  for (const t of STANDARD_TERMS) {
    if (t.toLowerCase() === lower) return t
  }
  if (token.length < 4) return token
  // 保守模糊匹配
  const prefix = lower.slice(0, 2)
  let best: string | null = null
  let bestDist = Infinity
  for (const t of STANDARD_TERMS) {
    const tl = t.toLowerCase()
    if (tl.slice(0, 2) !== prefix) continue
    if (tl.length < token.length) continue // 只允许漏字母，不允许多字母
    if (tl.length - token.length > 1) continue // 最多漏 1 字母
    const d = levenshtein(lower, tl)
    if (d < bestDist) { bestDist = d; best = t }
  }
  return bestDist <= 1 && best ? best : token
}

/**
 * 仅英文 token 规范化（大小写 + 拼写纠错），不做中文谐音映射。
 * 用于「英文直接识别」路径：英文语音 → en-US 识别 → 只纠拼写/大小写，不把谐音「翻译」成英文。
 */
export function normalizeEnglish(text: string): string {
  if (!text) return text
  return text.replace(/[A-Za-z][A-Za-z0-9+#.+-]*/g, (token) => normalizeToken(token))
}

/**
 * 应用术语纠偏：① 中文谐音映射替换；② 英文 token 规范化（大小写 + 拼写纠错）。
 * 用于中文（zh-*）识别路径：把中文谐音「翻译」回标准英文术语 + 纠英文拼写。
 * @param text 原始转写文本
 * @param extra 用户自定义谐音映射（覆盖/追加内置表）
 */
export function applyTermCorrection(text: string, extra: Record<string, string> = {}): string {
  if (!text) return text
  // 第一层：中文谐音映射
  const terms: Record<string, string> = { ...DEFAULT_TERMS, ...extra }
  const entries = Object.entries(terms)
    .filter(([k, v]) => k && v)
    .sort((a, b) => b[0].length - a[0].length)
  let out = text
  for (const [wrong, right] of entries) {
    if (out.includes(wrong)) out = out.split(wrong).join(right)
  }
  // 第二层：英文 token 规范化
  return normalizeEnglish(out)
}
