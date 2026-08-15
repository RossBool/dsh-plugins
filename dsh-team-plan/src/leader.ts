/**
 * dsh-team-plan/leader — Leader 控制面:受约束 LLM 单次调用生成计划,
 * 校验失败携带问题清单重写一次,再失败显式交回(不静默)。
 * 纯逻辑 + 注入 askModel,可完整 mock 测试。
 */

import { parsePlanJson, type Plan } from './schema.ts'
import { buildLeaderPrompt } from './driver.ts'

export interface AskModel {
  (system: string, user: string, signal?: AbortSignal): Promise<string>
}

export type LeaderResult = { ok: true; plan: Plan } | { ok: false; error: string }

export async function runLeader(ask: AskModel, requirement: string, signal?: AbortSignal): Promise<LeaderResult> {
  const { system, user } = buildLeaderPrompt(requirement)
  const first = await ask(system, user, signal)
  const r1 = parsePlanJson(first)
  if (r1.ok) return { ok: true, plan: r1.plan }

  const rewriteUser = user + '\n\n【上一版计划未通过校验,请修正以下问题后重新输出完整 JSON】\n' + r1.errors.map((e) => '- ' + e).join('\n')
  const second = await ask(system, rewriteUser, signal)
  const r2 = parsePlanJson(second)
  if (r2.ok) return { ok: true, plan: r2.plan }

  return { ok: false, error: '计划两次校验均失败。第二次问题:' + r2.errors.join(';') + '(首次问题:' + r1.errors.join(';') + ')' }
}
