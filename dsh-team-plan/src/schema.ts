/**
 * dsh-team-plan/schema — 计划 Schema 类型与纯校验。
 *
 * 计划由 Leader 的受约束 LLM 调用以 JSON 输出（概念上即图中 plan.yaml），
 * 校验完全手写：报错面向"LLM 输出哪里不合规"给出逐条原因，便于重写提示词。
 */

export interface PlanBatch {
  id: string
  title: string
  prompt: string
  deps: string[]
  verify: {
    criteria: string[]
    maxRetries: number
  }
}

export interface Plan {
  version: 1
  goal: string
  batches: PlanBatch[]
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[] }

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/

/** 依赖成环检测（DFS 三色标记） */
function hasCycle(batches: PlanBatch[]): string[] {
  const byId = new Map(batches.map((b) => [b.id, b]))
  const state = new Map<string, 0 | 1 | 2>() // 0=未访问 1=栈中 2=完成
  const cycleIds: string[] = []
  const stack: string[] = []

  const visit = (id: string): void => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      const at = stack.indexOf(id)
      if (at >= 0 && cycleIds.length === 0) cycleIds.push(...stack.slice(at), id)
      return
    }
    state.set(id, 1)
    stack.push(id)
    for (const dep of byId.get(id)?.deps ?? []) visit(dep)
    stack.pop()
    state.set(id, 2)
  }
  for (const b of batches) visit(b.id)
  return cycleIds
}

/** 校验任意 JSON 输入是否为合法计划；逐条收集错误，供 Leader 重写 */
export function validatePlan(input: unknown): PlanResult {
  const errors: string[] = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['计划必须是 JSON 对象（含 version/goal/batches 字段）'] }
  }
  const obj = input as Record<string, unknown>
  if (obj.version !== 1) errors.push('version 必须为 1')
  if (typeof obj.goal !== 'string' || !obj.goal.trim() || obj.goal.length > 200) {
    errors.push('goal 必须是非空字符串（≤200 字符）')
  }
  if (!Array.isArray(obj.batches) || obj.batches.length < 1 || obj.batches.length > 12) {
    errors.push('batches 必须是 1~12 个批次的数组')
    return { ok: false, errors }
  }

  const seen = new Set<string>()
  const batches: PlanBatch[] = []
  obj.batches.forEach((raw, i) => {
    const tag = `batches[${i}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${tag} 必须是对象`); return
    }
    const b = raw as Record<string, unknown>
    const id = b.id
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      errors.push(`${tag}.id 必须匹配 ${ID_RE}（当前：${JSON.stringify(id)}）`)
    } else if (seen.has(id)) {
      errors.push(`${tag}.id "${id}" 重复`)
    } else {
      seen.add(id)
    }
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 80) {
      errors.push(`${tag}.title 必须是非空字符串（≤80 字符）`)
    }
    if (typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 4000) {
      errors.push(`${tag}.prompt 必须是非空字符串（≤4000 字符）`)
    }
    const deps = Array.isArray(b.deps) ? b.deps : null
    if (deps === null || deps.some((d) => typeof d !== 'string')) {
      errors.push(`${tag}.deps 必须是字符串数组`)
    }
    const v = b.verify
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      errors.push(`${tag}.verify 必须是对象（含 criteria/maxRetries）`)
    } else {
      const vv = v as Record<string, unknown>
      const crit = vv.criteria
      if (!Array.isArray(crit) || crit.length < 1 || crit.length > 10 || crit.some((c) => typeof c !== 'string' || !c.trim())) {
        errors.push(`${tag}.verify.criteria 必须是 1~10 条非空字符串`)
      }
      const mr = vv.maxRetries
      if (mr !== undefined && (typeof mr !== 'number' || !Number.isInteger(mr) || mr < 0 || mr > 5)) {
        errors.push(`${tag}.verify.maxRetries 必须是 0~5 的整数`)
      }
    }
    batches.push({
      id: typeof id === 'string' ? id : String(i),
      title: typeof b.title === 'string' ? b.title : '',
      prompt: typeof b.prompt === 'string' ? b.prompt : '',
      deps: (deps ?? []).filter((d): d is string => typeof d === 'string'),
      verify: {
        criteria: Array.isArray((b.verify as Record<string, unknown> | undefined)?.criteria)
          ? ((b.verify as Record<string, unknown>).criteria as string[]).filter((c) => typeof c === 'string')
          : [],
        maxRetries: typeof (b.verify as Record<string, unknown> | undefined)?.maxRetries === 'number'
          ? ((b.verify as Record<string, unknown>).maxRetries as number)
          : 3,
      },
    })
  })
  if (errors.length) return { ok: false, errors }

  // 依赖引用与环（仅当结构错误已清零时才有意义）
  const byId = new Map(batches.map((b) => [b.id, b]))
  for (const b of batches) {
    for (const d of b.deps) {
      if (!byId.has(d)) errors.push(`批次 "${b.id}" 依赖不存在的批次 "${d}"`)
      if (d === b.id) errors.push(`批次 "${b.id}" 不能依赖自身`)
    }
  }
  const cycle = hasCycle(batches)
  if (cycle.length) errors.push(`批次依赖成环：${cycle.join(' → ')}`)
  if (errors.length) return { ok: false, errors }

  const plan: Plan = { version: 1, goal: obj.goal as string, batches }
  return { ok: true, plan }
}

/** 解析 Leader 输出的 JSON 字符串（容忍 ```json 代码块包裹）并校验 */
export function parsePlanJson(text: string): PlanResult {
  const raw = String(text ?? '').trim()
  let body = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  try {
    return validatePlan(JSON.parse(body))
  } catch (e) {
    return { ok: false, errors: ['计划不是合法 JSON：' + String((e as Error)?.message ?? e)] }
  }
}
