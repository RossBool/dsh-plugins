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
// - 英文模糊匹配只在 token 长度≥4、前 2 字符相同、编辑距离≤1、最多漏 1 字母时生效，
//   以控制误伤（普通英文单词/短缩写不会被改）。
// - 用户可通过配置 asr.correction.terms 扩展谐音表、asr.correction.mishear 覆盖英文误识别映射，
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

// 模糊匹配候选词库：可参与编辑距离拼写纠错。只放「拼错也不会和普通词混淆」的专有名词，
// 避免把 cords→Cordis、typer→Typert 等普通词误改。
const FUZZY_TERMS: string[] = [
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

// 仅精确规范化词库（不参与模糊匹配）：DeepSeek Harness（DSH）生态专有名词。
// 这些词与普通词发音/拼写相近（cords↔Cordis、typer↔Typert），若参与模糊匹配会误伤普通词。
const EXACT_ONLY_TERMS: string[] = [
  'Harness', 'Cordis', 'Schemastery', 'Cosmokit', 'Typert',
]

// 英文「发音相近替代」映射（默认内置）：ASR 把词汇表外的专有名词识别成发音相近的
// 词汇表内词/缩写（拼写差异大，编辑距离/音码都失效），只能用领域知识做精确 token 匹配纠正。
// 注意：'dc'/'honey' 是高频多义词（直流电/华盛顿 DC/AC·DC、蜂蜜/昵称）——本插件是
// DSH 语音编程专用，该语境下它们几乎只指 DeepSeek/Harness，故默认内置；通用场景应通过
// 配置 asr.correction.mishear 覆盖/删除（值为空字符串 = 删除该项）。
const DEFAULT_MISHEAR: Record<string, string> = {
  'dseek': 'DeepSeek',  // DeepSeek → dseek（拼写变体，低误伤）
  'dc': 'DeepSeek',     // DeepSeek → DC（/diːp siːk/ 被听成 /diː siː/）
  'honey': 'Harness',   // Harness → Honey（/ˈhɑːrnɪs/ 被听成 /ˈhʌni/）
}

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
 * 规范化一个英文 token：① 发音相近替代映射（精确，优先级最高）；② 词库精确匹配（大小写规范化）；
 * ③ 保守模糊匹配（拼写纠错，只用 FUZZY_TERMS 候选集）。
 * 模糊匹配约束：长度≥4、前 2 字符相同、编辑距离≤1、最多漏 1 字母；
 * 用「前 2 字符」而非「首字母」区分普通词与术语（rest 的 "re" vs Rust 的 "ru"）。
 * 未命中返回原 token。
 */
function normalizeToken(token: string, mishear: Record<string, string>): string {
  const lower = token.toLowerCase()
  // 1. 发音相近替代映射（精确 token 匹配，优先级最高）：dc→DeepSeek、honey→Harness
  if (mishear[lower]) return mishear[lower]
  // 2. 词库精确匹配（大小写规范化）：FUZZY_TERMS ∪ EXACT_ONLY_TERMS
  for (const t of FUZZY_TERMS) {
    if (t.toLowerCase() === lower) return t
  }
  for (const t of EXACT_ONLY_TERMS) {
    if (t.toLowerCase() === lower) return t
  }
  // 3. 保守模糊匹配（只用 FUZZY_TERMS，不含 EXACT_ONLY_TERMS，避免 cords→Cordis 误伤）
  if (token.length < 4) return token
  const prefix = lower.slice(0, 2)
  let best: string | null = null
  let bestDist = Infinity
  for (const t of FUZZY_TERMS) {
    const tl = t.toLowerCase()
    if (tl.slice(0, 2) !== prefix) continue
    if (tl.length < token.length) continue // 只允许漏字母，不允许多字母
    if (tl.length - token.length > 1) continue // 最多漏 1 字母
    const d = levenshtein(lower, tl)
    if (d < bestDist) { bestDist = d; best = t }
  }
  return bestDist <= 1 && best ? best : token
}

/** 合并内置误识别映射与用户配置：值为空字符串 = 删除该项 */
function mergeMishear(user: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_MISHEAR }
  for (const [k, v] of Object.entries(user ?? {})) {
    if (v) merged[k.toLowerCase()] = v
    else delete merged[k.toLowerCase()]
  }
  return merged
}

/**
 * 仅英文 token 规范化（发音相近替代 + 大小写 + 拼写纠错），不做中文谐音映射。
 * 用于「英文直接识别」路径：英文语音 → en-US 识别 → 只纠专有名词/拼写/大小写。
 */
export function normalizeEnglish(text: string, mishear: Record<string, string> = {}): string {
  if (!text) return text
  const merged = mergeMishear(mishear)
  return text.replace(/[A-Za-z][A-Za-z0-9+#.+-]*/g, (token) => normalizeToken(token, merged))
}

/**
 * 应用术语纠偏：① 中文谐音映射替换；② 英文 token 规范化（发音相近替代 + 大小写 + 拼写纠错）。
 * 用于中文（zh-*）识别路径：把中文谐音「翻译」回标准英文术语 + 纠英文专有名词/拼写。
 * @param text 原始转写文本
 * @param extra 用户自定义谐音映射（覆盖/追加内置表）
 * @param mishear 用户自定义英文误识别映射（覆盖/追加/删除内置 DEFAULT_MISHEAR）
 */
export function applyTermCorrection(text: string, extra: Record<string, string> = {}, mishear: Record<string, string> = {}): string {
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
  return normalizeEnglish(out, mishear)
}

// —— 口语语气字（零语义损失的确定性清理）——
//
// 第一性原理：语音转写的噪声分两类——①「无歧义的纯语气字」（呃/嗯/啊…），其语义负载
// 趋近于零，可机械删除；②「语境依赖的口头禅/冗余词」（就是/然后/那个/这个/之类的/什么的），
// 在不同上下文里有语义，机械删除会改意，必须交给 LLM 润色判断。
// 本函数只处理第①类（纯语气填充字），因此是**无损、幂等**的确定性变换，且只删除：
//   1) 成串重复的语气字（呃呃、嗯嗯嗯）——disfluency，无语义；
//   2) 句首的孤立语气字（含其紧邻的句读/空白）。
// 不删句尾（句尾语气助词如「呢/啊/嘛/哈」表疑问/感叹/肯定，删了会改意），
// 不碰句中（无分词，避免误伤「那个」「就是」等），不碰语境依赖词。

// 仅纯填充语气字（零语义）；有语义的语气助词（呢/啊/嘛/哈/呀/哟/喂/咦）刻意排除
const INTERJECTION_CHARS = '呃嗯哦噢诶唉哎哼唔'
// 语气字两侧允许出现的「非词」字符：空白 + 中文句读 + 省略号/破折号/括号
const FILLER_BOUNDARY = '\\s，。！？、；：…—·（）()'

/**
 * 去除口语纯语气字（呃/嗯/哦…），仅做无损清理，用于「润色」路径的确定性预过滤。
 * 其余口语化去除（就是/然后/那个/之类的）与语病修补、流畅度增强由 LLM 完成。
 */
export function stripInterjections(text: string): string {
  if (!text) return text
  const run = new RegExp(`[${INTERJECTION_CHARS}]{2,}`, 'g')
  const lead = new RegExp(`^[${FILLER_BOUNDARY}]*[${INTERJECTION_CHARS}]+[${FILLER_BOUNDARY}]*`, 'g')
  return text.replace(run, '').replace(lead, '')
}
