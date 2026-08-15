/**
 * dsh-team-plan/verifier — 对抗式质量门禁:受约束 LLM 单次调用,逐条对照
 * 批次验收标准判定 PASS/FAIL;FAIL 必须输出可执行问题清单(供重试注入 Worker 提示词)。
 * 纯逻辑 + 注入 askModel,可完整 mock 测试。
 */

import type { PlanBatch } from './schema.ts'

export type VerifierVerdict = { verdict: 'PASS' } | { verdict: 'FAIL'; issues: string[] }

export interface AskModel {
  (system: string, user: string, signal?: AbortSignal): Promise<string>
}

/** 解析验证器 JSON 输出(容忍 ```json 代码块);非法输出返回 error */
export function parseVerifierJson(text: string): { ok: true; v: VerifierVerdict } | { ok: false; error: string } {
  const raw = String(text ?? '').trim()
  let body = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  let obj: unknown
  try {
    obj = JSON.parse(body)
  } catch (e) {
    return { ok: false, error: '不是合法 JSON:' + String((e as Error)?.message ?? e) }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '必须是 JSON 对象(含 verdict/issues)' }
  }
  const o = obj as Record<string, unknown>
  if (o.verdict === 'PASS') return { ok: true, v: { verdict: 'PASS' } }
  if (o.verdict !== 'FAIL') return { ok: false, error: 'verdict 必须是 PASS 或 FAIL' }
  const issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 10) : []
  if (!issues.length) return { ok: false, error: 'FAIL 必须带非空 issues 数组' }
  return { ok: true, v: { verdict: 'FAIL', issues } }
}

/** 对抗式验证提示词:只按验收标准判定,FAIL 必须给可执行问题 */
export function buildVerifierPrompt(spec: PlanBatch, output: string, now?: Date): { system: string; user: string } {
  const ref = now ?? new Date()
  const dateStr = ref.getFullYear() + '-' + String(ref.getMonth() + 1).padStart(2, '0') + '-' + String(ref.getDate()).padStart(2, '0') + ' ' + String(ref.getHours()).padStart(2, '0') + ':' + String(ref.getMinutes()).padStart(2, '0')
  const system = [
    '参考事实(以此为准,不要用你的内部知识判断时间):系统当前时间是 ' + dateStr + '。',
    '你是「对抗式验证者(Verifier)」:质量门禁的最后一道闸。',
    '只输出一个 JSON 对象,不要输出任何其他文字或 markdown 代码块。',
    '输出结构:{"verdict":"PASS"} 或 {"verdict":"FAIL","issues":["问题1","问题2"]}。',
    '判定规则:',
    '- 逐条对照「验收标准」判定,全部满足才 PASS;任何一条不满足必须 FAIL;',
    '- 站在使用者对立面审查:产出是否真的完成了任务书要求?有没有含糊、遗漏、自相矛盾、明显错误?',
    '- 不因风格偏好、措辞、篇幅判 FAIL;证据不足时以验收标准为准;',
    '- FAIL 时 issues 给出 1~5 条可执行的具体问题(Worker 将按此修复),每条指向具体缺陷,不要泛泛而谈;',
    '- 产出明显未完成、格式错乱、答非所问,直接 FAIL。',
  ].join('\n')
  const criteriaText = spec.verify.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
  const user = [
    '【任务书】' + spec.prompt,
    '【验收标准】\n' + criteriaText,
    '【Worker 产出】\n' + truncate(output, 12000),
  ].join('\n\n')
  return { system, user }
}

/** 执行一次对抗式验证;验证器自身调用失败/输出非法 → FAIL(消耗一轮重试,不静默) */
export async function runVerifier(ask: AskModel, spec: PlanBatch, output: string, signal?: AbortSignal): Promise<VerifierVerdict> {
  const { system, user } = buildVerifierPrompt(spec, output)
  const text = await ask(system, user, signal)
  const r = parseVerifierJson(text)
  if (!r.ok) return { verdict: 'FAIL', issues: ['验证器输出无法解析:' + r.error] }
  return r.v
}

function truncate(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '\n…(截断)' : t
}
