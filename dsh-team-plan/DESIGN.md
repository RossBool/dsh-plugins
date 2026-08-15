# dsh-team-plan — 计划驱动协作引擎设计

> 2026-08-16 · 已获用户确认的架构。与现有自由协作路由(dsh-team-mode/route、dsh-agent-orchestration/route)**并存**,不改动后者一行。

## 1. 模型(对应 MiniMax Agent Team 协作模型图)

```
用户 /plan <需求>
   │
   ▼
Leader 控制面 ──受约束 LLM 单次调用(结构化 JSON 输出)──▶ plan(批次/依赖/验证标准/重试上限)
   │                                          │ 严格校验:非法重写一次,再失败显式交回主会话
   ▼                                          ▼
Team Engine —— 确定性状态机(纯函数 reducer,JSON 落盘,断点续跑)
   │  依赖满足即入队;批内 Worker 并行上限 3(可配置)
   ├──▶ Worker(harness 持久化子代理,startContinuable)──产出──▶ Verifier
   │        ▲                                                  │
   │        └── FAIL(问题清单注入下一轮提示词,≤maxRetries)──────┘
   │             耗尽重试 → 批次 exhausted(继续跑其余独立批次)
   ▼
全部批次终态 → 交付报告注入主会话 → 终止(含环:verifier→worker 重试回环)
```

**原则**:Leader/Verifier = 一次受约束 LLM 调用(非 agent loop);Worker = 真正干活的 agent。
**批次 FAIL 耗尽后的全局策略(已确认)**:继续跑其余独立批次,整体交付报告标注失败批次。

## 2. 插件结构(工作区 dsh-team-plan/,C1 上下文,独立仓库)

```
dsh-team-plan/
├── src/
│   ├── schema.ts      # 计划 Schema 类型 + validatePlan(纯校验,LLM 输出友好报错)
│   ├── engine.ts      # 确定性状态机:EngineState + transition(reducer)+ nextReady(调度)
│   ├── persist.ts     # JSON 原子落盘(saveState/loadState,tmp+rename)
│   ├── index.ts       # [M1] 插件入口:control/engine 行装配(待 API 事实清单后写)
│   ├── leader.ts      # [M1] Leader 受约束 LLM 调用 → plan JSON
│   └── verifier.ts    # [M2] Verifier 对抗式审查 → PASS/FAIL+问题清单
├── test/              # node --test 纯逻辑测试
├── research/          # DSH API 事实清单(dsh-api-facts.md,后台调研产出)
└── DESIGN.md
```

## 3. 状态机(确定性)

```
phase: idle →(plan:proposed)→ running →(全部批次终态 + deliver)→ delivering →(done)→ done
plan:failed → idle(planError 落盘,可重提)

批次: pending → ready → running → verifying → passed
                        └─(worker-error)─┘        └─ verify:fail:attempts+1
                                                      ├─ attempts < maxRetries+1 → ready(重试)
                                                      └─ attempts ≥ maxRetries+1 → exhausted
```

- 迁移是纯函数 `transition(state, event, now)`:同一状态+事件序列 → 同一结果(测试断言)。
- `nextReady(state, cap)`:依赖全 passed 的 pending/ready 批次,按声明顺序,受并行上限约束。
- 无效迁移返回 error,状态不变。
- 状态每次迁移后由驱动层落盘;恢复时按批次状态续跑(子代理可续接)。

## 4. 计划 Schema(plan,JSON 序列化)

```json
{
  "version": 1,
  "goal": "一句话目标",
  "batches": [{
    "id": "A", "title": "…", "prompt": "Worker 任务书(可含 {b.<id>.output} 占位符)",
    "deps": [], 
    "verify": { "criteria": ["验收条件一", "…"], "maxRetries": 3 }
  }]
}
```

校验规则:1~12 批;id 唯一且 `[A-Za-z0-9_-]{1,32}`;无自依赖/依赖不存在/依赖成环;
criteria 1~10 条非空;maxRetries 0~5 整数(默认 3)。

## 5. Verifier 协议

输入 = 批次任务书 + 验收标准 + Worker 产出;输出 = `{ "verdict": "PASS"|"FAIL", "issues": ["问题1", …] }`。
FAIL 的问题清单注入下一轮 Worker 提示词;轮数上限 = 批次 maxRetries。

## 6. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 ✅ | 脚手架 + 纯逻辑层(schema/engine/persist)+ 单测 | `node --test` 全绿 |
| M1 ✅(端到端验收通过) | 插件装配(/tplan 命令,实测 /plan 与官方 plan-mode 冲突改名)+ Leader 生成计划 + Worker 派发闭环;34 项单测全绿、typecheck 通过 | 已验收:Leader 出计划 → 2 Worker 并行 → 双双 PASS → 交付报告注入主会话 → 状态落盘 phase=done(实测记录见下) |
| M2 ✅(端到端验收通过) | 对抗式 Verifier+重试回环+超时归因+产出提取修复;45 项单测全绿;实测 FAIL→重试→PASS 闭环(见下) | 已验收 |
| M3 ✅(端到端验收通过) | host 叠加 plan 层节点 + 客户端四种新节点样式 + 红色虚线重试边;实测画布渲染完整层 | 已验收 |

## 8. v1.1 治理修复(用户反馈「占进度」问题)

- **启动自恢复**:插件加载时扫描状态文件,接管所有未完成计划并立即超时扫频——GUI 重启不再导致挂起批次永久卡 running(占任务状态的根因)。
- **/tplan abort**:显式中止当前计划(未完成批次→exhausted(用户中止)→交付报告),用户可随时结束任务。48 项单测全绿。
- **已知架构局限(待隔离重构)**:引擎当前运行在用户会话内部(Worker 是会话子代理、结算进 inbox、交付报告占消息),任务天然占用会话进度与画布。正确形态是每次 /tplan 派发到独立任务会话,主会话只收交付报告——待下一迭代实现。

**M1 端到端实测记录(2026-08-16,运行中 GUI 真实会话)**:`/tplan 两批并行演示…` → Leader(deepseek-v4-flash)生成合法 2 批计划 → 引擎派发 2 个持久化 Worker(startContinuable)并行执行 bash 任务 → 先后结算(subagent-settled 进父 inbox)驱动状态机双双 passed → 交付报告注入主会话 → 状态文件落盘 phase=done、A/B 均 passed。

**遗留(带入 M2)**:Worker 产出提取在结算瞬间回退到了结算通知文本——子代理的 `assistant/message` 事件当时尚未进入 `sessions.get(childId).events` 活体投影(持久 JSONL 中确实存在)。M2 修:结算后延迟重读活体投影 + `assistant/chunk` 的 `block-end` 块兜底组装。

**M3 实测发现(对抗门禁抓出管道自身缺陷)**:M3 验证计划(验收标准「输出恰好一个字符 A」)连续 4 轮 FAIL 后耗尽——Verifier 逐轮精准指出「输出包含了额外的前缀描述(Background subagent…closing message:)」,这正是产出提取回退到结算通知文本的残留 bug(延迟重读活体投影仍未命中,子会话活体投影在结算瞬间不可读)。已修复:`stripSettledPrefix` 剥离结算前缀/提取 closing message 段落,46 项单测全绿。**结论:对抗式门禁不仅能审 Worker,还能审管道本身。**

## 7. 风险与对策

1. Leader 计划质量不稳 → 强校验 + 一次重写 + 失败显式交回(不静默);
2. 子代理挂起/超时 → 每批超时(默认 15min,可配置),超时视 worker-error 消耗一轮;
3. 重试 token 放大 → 批次级 maxRetries 上限;重试提示词只追加问题清单,不重发全史;
4. 与现有路由冲突 → /tplan 显式命令触发,零自然语言误判;
5. 画布环 → React Flow 原生环能力;重试边单独渲染,不参与 BFS 分层。

## 9. M4 隔离重构(用户反馈「占会话进度」的架构修复)

**目标**:每次 /tplan 跑在独立任务会话内,用户会话只收一条最终交付报告,零占用。

- **任务会话**:/tplan 时创建持久任务容器(用户会话的 continuable 子代理,静默容器提示词);引擎状态文件按任务会话 id 命名并记录 parentSessionId。
- **Worker 归属任务会话**:spawnWorker 的 parent = 任务会话 agent → 结算只进任务会话 inbox(用户会话不再被 Worker 结算唤醒)。
- **交付**:引擎完成 → followup 把交付报告送进任务容器 → 容器原样输出 → 结算通知以「一条消息」自动投递回用户会话。
- **画布**:host 按血缘候选扫描状态文件,plan 层节点挂在对应任务节点之下——每个任务在画布上是独立子树(不同任务的上下文彼此隔离,重试环等全部保留)。
- **健壮性**:Worker 派发失败自动转 worker-error 消耗一轮;Leader 失败尽力 interrupt 清理空容器;启动自恢复按任务 id 接管并重建用户关联。
- 测试:48/48 全绿、typecheck 干净。

## 10. M4 实测发现的四个引擎缺陷(已修复,49 项单测全绿)

1. **重试派发失败死锁**:任务容器结算休眠后 `agents.get(taskId)` 取不到活体 agent,重试派发失败;且 worker-error 只接受 running 状态、驱动队列吞异常 → 批次永久卡 ready。修复:worker-error 接受 pending/ready/running;队列异常落日志;**容器休眠时 followup 唤醒(空转一轮)后重取活体 agent 再派发**。
2. **依赖级联封堵缺失**:某批次耗尽后,依赖它的批次永久 pending,全计划永远无法交付。修复:`blockDependents`——耗尽时传递封堵所有依赖它的 pending 批次(exhausted + "依赖的批次失败")。
3. **泵内耗尽不交付**:派发失败在泵内耗尽全部批次时无人复查终态。修复:pumpLocked 结束后补一次 allTerminal → 交付。
4. **Verifier 时间盲区**:对抗式验证对"今天的日期"类标准用自己的训练知识误判(把 2026-08-16 当成"不是今天")。修复:验证提示词注入系统当前时间作为参考事实。

## 11. M4 最终验收(2026-08-16,全链路实测通过)

1. **隔离**:两个任务会话(e9d154df/f746c8ad)各自独立运行——Worker 全部挂在任务会话节点下,结算只在任务会话内消化;用户会话仅收「已派发」+ 容器确认 + 最终交付报告,零中间占用。
2. **即时交付**:用户会话活跃时 followup 路径直达(`delivered: true`),报告原文:「✅ A 输出今天的日期: 2026-08-16 / ✅ B 输出1-100的随机数: 37」——Verifier 日期参考修复生效,A 经历一次重试后正确通过。
3. **休眠兜底**:重启后 `queued dormant delivery for …`,打开会话下一步即注入未投递的报告(上一个任务 e9d154df 的报告在测试会话中实测出现)。
4. **画布**:每个任务在画布上是独立子树(任务节点 → 计划引擎 → plan → worker → verifier + 重试环),任务间互不干扰。
5. **状态归属**:状态文件按任务会话 id 命名,`parentSessionId` 关联用户会话,`delivered` 标志落盘。
