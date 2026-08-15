# dsh-team-plan — 计划驱动协作引擎

用 `/tplan` 命令驱动「Leader 生成计划 → 确定性状态机 → Worker 子代理 → Verifier 对抗式质量门禁（重试回环）」的结构化多智能体协作，与自由协作路由并存。

## 功能简介

- **Leader**：一次受约束 LLM 调用，把需求结构化输出为计划 JSON（批次/依赖/验证标准/重试上限）。
- **Team Engine**：确定性状态机（纯函数 reducer），依赖满足即入队，批内 Worker 并行上限可配置，JSON 原子落盘、断点续跑。
- **Worker**：真正干活的持久化子代理（`startContinuable`）。
- **Verifier**：对抗式审查 Worker 产出，FAIL 的问题清单注入下一轮 Worker 提示词，≤ `maxRetries` 次重试；耗尽则批次 `exhausted`（继续跑其余独立批次）。

## 能力

| 组件 | 文件 | 说明 |
| --- | --- | --- |
| Schema | `src/schema.ts` | 计划 Schema 类型 + 纯校验（LLM 输出友好报错） |
| Engine | `src/engine.ts` | 确定性状态机 `transition(state, event, now)` + `nextReady` 调度 |
| Persist | `src/persist.ts` | JSON 原子落盘（tmp+rename），断点续跑 |
| Leader | `src/leader.ts` | 受约束 LLM 调用 → plan JSON |
| Verifier | `src/verifier.ts` | 对抗式审查 → PASS/FAIL + 问题清单 |
| Entry | `src/index.ts` | 插件入口 + `/tplan` 命令 + 事件驱动 |

状态机（确定性）：

```
idle →(plan:proposed)→ running →(全部批次终态)→ delivering → done
批次: pending → ready → running → verifying → passed
                    └─ verify:fail → attempts < maxRetries+1 → ready（重试）
                                   └─ attempts ≥ maxRetries+1 → exhausted
```

## 使用方式

### 安装与挂载

```yaml
- insert:
    - id: team-plan
      name: /path/to/dsh-team-plan/src/index.ts
      config:
        enabled: true
        provider: deepseek-official
        model: deepseek-v4-flash
        maxParallel: 3
```

### 触发

| 命令 | 作用 |
| --- | --- |
| `/tplan <需求描述>` | 生成计划并派发 Worker 团队执行 |
| `/tplan status` | 查看当前计划各批次进度 |
| `/tplan abort` | 中止进行中的计划 |

> 命名说明：官方 `dsh-plan-mode` 已占用 `/plan`，故本引擎用 `/tplan`（team plan）避免冲突。

### 校验与测试

```bash
npm install
npm run typecheck   # 类型检查
npm test            # node --test 纯逻辑测试
npm run gate        # typecheck + test
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用 |
| `provider` | `deepseek-official` | LLM 提供方 |
| `model` | `deepseek-v4-flash` | 模型 |
| `maxParallel` | `3` | 批内 Worker 并行上限（1–6） |
| `leaderTimeoutMs` | `120000` | Leader 调用超时 |
| `verifierTimeoutMs` | `120000` | Verifier 调用超时 |
| `workerTimeoutMs` | `900000` | Worker 执行超时 |

计划校验规则：1~12 批；id 唯一且 `[A-Za-z0-9_-]{1,32}`；无自依赖/依赖不存在/依赖成环；criteria 1~10 条非空；maxRetries 0~5 整数（默认 3）。详见 `DESIGN.md`。
