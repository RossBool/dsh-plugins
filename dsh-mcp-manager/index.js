/**
 * dsh-mcp-manager — MCP 服务器管理插件（host half）
 *
 * - 通过 settings 命名空间 `mcp-servers` 持久化服务器配置（$DSH_HOME/settings.yaml，
 *   用户层），Web UI（./client.js 的 Settings 页）直接增删改查，实时生效。
 * - 对每个 enabled 的服务器动态挂载官方 @deepseek-ai/dsh-mcp-client 实例
 *   （工具注册为 mcp__<serverName>__<tool>，自动重连），配置变化/删除时热卸载。
 * - 暴露内部命令 /mcp-status：返回各服务器运行时状态 JSON（供设置页轮询）。
 *
 * @module dsh-mcp-manager
 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  Config as McpClientConfig,
  apply as mcpClientApply,
} from '@deepseek-ai/dsh-mcp-client'
import { appendFileSync } from 'node:fs'
const trace = (line) => { try { appendFileSync('/tmp/mcp-manager-trace.log', new Date().toISOString() + ' ' + line + '\n') } catch {} }

export const name = 'dsh-mcp-manager'

/** 依赖的服务：工具注册表（状态统计）、斜杠命令（/mcp-status）、settings（冷启动时必须等它就绪）、timer（自愈定时器）。 */
export const inject = ['tools', 'commands', 'settings', 'timer']

/** mcp-client 对 serverName 的约束（公共工具名 mcp__<name>__<tool> 的前缀）。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const commonFields = {
  /** 是否启用该服务器；停用 = 卸载实例并取消注册其工具。 */
  enabled: z.boolean().default(true),
  /** 单次 MCP 工具调用超时（毫秒）。 */
  toolCallTimeoutMs: z.number().step(1).min(1000).max(600000).default(60000),
}

/** 一个 MCP 服务器的配置（stdio 或 streamable-http 二选一）。 */
const ServerSpec = z.union([
  z.object({
    ...commonFields,
    transport: z.const('stdio'),
    /** 启动服务器的可执行文件（绝对路径或 PATH 中的命令）。 */
    command: z.string().min(1),
    /** 直接传递的参数，不做 shell 插值。 */
    args: z.array(z.string()).default([]),
    /** 额外环境变量（合并到清理后的父进程环境之上）。 */
    env: z.dict(z.string()).default({}),
    /** 子进程工作目录。 */
    cwd: z.string().default(''),
  }),
  z.object({
    ...commonFields,
    transport: z.const('streamable-http'),
    /** MCP Streamable HTTP 端点 URL。 */
    url: z.string().min(1),
    /** 附加到 MCP 请求的 HTTP 头（如 Authorization）。 */
    headers: z.dict(z.string()).default({}),
  }),
])

/** 插件配置：servers 字典，键 = serverName（唯一命名空间）。 */
export const Config = z.object({
  servers: z.dict(ServerSpec).default({}),
})

/** 跨字段校验：serverName 键必须满足 mcp-client 的命名约束。 */
function validateServers(value) {
  const servers = value?.servers ?? {}
  for (const key of Object.keys(servers)) {
    if (!SERVER_NAME_PATTERN.test(key)) {
      throw new Error(
        '服务器名 "' + key + '" 不合法：仅允许 1–32 位字母/数字/下划线/连字符（[A-Za-z0-9_-]）',
      )
    }
  }
}

/** 把 UI 形状的配置映射为 mcp-client 的 Config，并用其 schema 补齐默认值。 */
function toClientConfig(serverName, spec) {
  const base = {
    serverName,
    toolCallTimeoutMs: spec.toolCallTimeoutMs,
    failOnStartupError: false, // 首次连接失败进入后台自动重连，不阻断插件
  }
  if (spec.transport === 'stdio') {
    return McpClientConfig({
      ...base,
      transport: 'stdio',
      command: spec.command,
      args: spec.args ?? [],
      env: spec.env ?? {},
      cwd: spec.cwd ?? '',
    })
  }
  return McpClientConfig({
    ...base,
    transport: 'streamable-http',
    url: spec.url,
    headers: spec.headers ?? {},
  })
}

/** 序列化规范指纹：配置变化时热替换实例。 */
function fingerprint(spec) {
  return JSON.stringify(spec)
}

/** 首次启动时植入的演示服务器（写入用户层，UI 里可见、可删）。 */
const DEMO_SERVER = {
  transport: 'stdio',
  command: '/Users/zhoujunren/Library/PhpWebStudy/app/nodejs/v22.21.1/bin/node',
  args: ['/Users/zhoujunren/.dsh/profiles/plugins/mcp-demo-server/server.js'],
  cwd: '/Users/zhoujunren/.dsh/profiles/plugins/mcp-demo-server',
  env: {},
  toolCallTimeoutMs: 60000,
  enabled: true,
}

/** 插件入口：注册 settings 命名空间、对配置变化做实例对账、注册状态命令。 */
export function apply(ctx, config) {
  const log = ctx.logger(name)

  /** 运行中的实例：serverName → { specFp, fiber, state, error, since } */
  const mounted = new Map()
  let live = config

  /** 串行化对账，避免并发对账互相交错（同名实例的卸/挂顺序）。 */
  let reconcileChain = Promise.resolve()

  /** 幂等卸载一个实例并等待其清理完成（serverName 预约随之释放）。 */
  async function disposeEntry(entry) {
    if (!entry.fiber) return
    const fiber = entry.fiber
    entry.fiber = null
    try { await fiber.dispose() } catch { /* 幂等卸载 */ }
  }

  /**
   * 把 live.servers 与已挂载实例对账：新增/变更 → 挂载；删除/停用 → 卸载。
   * 同一名称的变更先等待旧实例完全卸载（释放 serverName 预约）再挂载新实例。
   */
  function reconcile(next) {
    trace('reconcile: servers=' + Object.keys(next?.servers ?? {}).join(',') + ' zai.enabled=' + String(next?.servers?.zai?.enabled))
    const run = reconcileChain.then(async () => {
      const servers = next?.servers ?? {}
      const wanted = new Set()
      for (const [serverName, spec] of Object.entries(servers)) {
        if (spec?.enabled !== true) continue
        wanted.add(serverName)
        const fp = fingerprint(spec)
        const rec = mounted.get(serverName)
        // 已成功挂载且配置未变 → 跳过；但失败遗留的 entry（如 serverName 预约
        // 残留导致的挂载失败）不能永久跳过——距上次尝试超过 60 秒则重试一次。
        if (rec && rec.specFp === fp) {
          const now = Date.now()
          if (rec.state !== 'failed' || now - (rec.lastTry ?? rec.since) < 60000) continue
          log.info('重试此前失败的 MCP 服务器:', serverName)
          await disposeEntry(rec)
          mounted.delete(serverName)
        } else if (rec) {
          await disposeEntry(rec)
          mounted.delete(serverName)
        }
        const entry = { specFp: fp, fiber: null, state: 'connecting', error: null, since: Date.now(), lastTry: Date.now() }
        mounted.set(serverName, entry)
        const retryOnce = () => {
          if (mounted.get(serverName) !== entry || entry.retried) return
          entry.retried = true
          const prev = entry.fiber
          entry.fiber = null
          prev?.dispose?.().catch(() => {})
          entry.state = 'connecting'
          entry.error = null
          setTimeout(() => {
            if (mounted.get(serverName) !== entry) return
            mount()
          }, 1200)
        }
        const mount = () => {
          entry.lastTry = Date.now()
          trace('mount: start ' + serverName)
          try {
            // settings 服务返回的配置是冻结对象（frozen），Schemastery 解析时会
            // 向缺失字段写入默认值而抛错（空 env 的 demo 侥幸通过，带 env 的 zai 必炸）。
            // 深拷贝解冻后再交给 mcp-client 的 schema。
            const resolved = toClientConfig(serverName, structuredClone(spec))
            trace('mount: config OK ' + serverName + ' transport=' + resolved.transport)
            entry.fiber = ctx.plugin(
              { name: 'mcp-client', inject: ['tools'], apply: mcpClientApply },
              resolved,
            )
            trace('mount: ctx.plugin returned ' + serverName + ' fiber=' + String(entry.fiber !== undefined && entry.fiber !== null))
            entry.fiber.then(
              () => { if (mounted.get(serverName) === entry && entry.state === 'connecting') entry.state = 'ready' },
              (error) => {
                if (mounted.get(serverName) !== entry) return
                entry.state = 'failed'
                entry.error = error instanceof Error ? error.message : String(error)
                log.warn('MCP 服务器挂载失败:', serverName, entry.error)
                retryOnce()
              },
            )
          } catch (error) {
            // schema 错误消息包含完整配置（env 里可能有明文密钥），只保留截断版本
            const raw = error instanceof Error ? error.message : String(error)
            entry.state = 'failed'
            entry.error = raw.length > 160 ? raw.slice(0, 160) + '…(已截断)' : raw
            // 注意：schema 错误消息可能包含完整配置（含 env 明文），trace 只记名字与类型
            trace('mount: CATCH ' + serverName + ' err-type=' + (error?.name ?? typeof error))
            log.warn('MCP 服务器挂载失败:', serverName, '配置校验失败，详情见 /mcp-status')
            retryOnce()
          }
        }
        mount()
        // 同名预约未释放的竞态兜底：挂载失败后等 1.2s 重试一次（不影响慢连接）
        entry.fiber?.then?.(() => {
          if (mounted.get(serverName) !== entry) return
          if (entry.state !== 'failed' || entry.retried) return
          retryOnce()
        })
      }
      for (const [serverName, rec] of [...mounted.entries()]) {
        if (wanted.has(serverName)) continue
        await disposeEntry(rec)
        mounted.delete(serverName)
        log.info('已卸载 MCP 服务器:', serverName)
      }
    })
    reconcileChain = run.catch(() => {})
    return run
  }

  // settings 命名空间：用户层配置（Settings 页写入）+ 实时 watch
  // 注意：settings 服务可能被热替换（行重载产生新 provider 实例），必须每次
  // 实时解析 ctx.get('settings')，不能把旧实例捕获进闭包长期使用。
  let scope
  let registeredProvider = undefined

  /**
   * 向当前 settings 服务实例注册命名空间并接线。覆盖三种失效模式：
   *   1) settings provider 被热替换（新实例没有我们的注册）→ 重新注册；
   *   2) 注册清理是「按键删除」的，旧 fiber 的清理可能误删新注册 → 自愈重装；
   *   3) 注册遇「已注册」冲突（旧清理未完成）→ 稍后重试。
   */
  function installNamespace() {
    const settingsService = ctx.root.get('settings')
    trace('install: ctx.get(settings)=' + String(settingsService !== undefined && settingsService !== null) + '; ctx.root.get(settings)=' + String(ctx.root && ctx.root.get('settings') !== undefined && ctx.root.get('settings') !== null))
    if (!settingsService || typeof settingsService.register !== 'function') {
      log.warn('settings 服务不可用，仅使用 cordis.yml 配置')
      return false
    }
    try {
      scope = settingsService.register(settingsNamespace('mcp-servers'), Config, {
        base: config,
        applies: 'live',
        validate: validateServers,
      })
      trace('register OK; describe-has=' + settingsService.describe().some((d) => String(d.ns) === 'mcp-servers'))
      registeredProvider = settingsService
    } catch (error) {
      trace('register FAILED: ' + (error?.message ?? error))
      if (String(error?.message ?? error).includes('already registered')) {
        // 命名空间已被另一存活实例持有（热重载竞态/重复 apply）：
        // 认领当前 provider 为已注册，使 heal 的存在性检查保持静默；
        // 待原持有者卸载、注册被按键清理后，heal 会自动接管重装。
        registeredProvider = settingsService
        scope = undefined
        trace('register: namespace owned elsewhere; standing by for handover')
        log.info('mcp-servers 命名空间由其他实例持有，本实例待命接管')
        return false
      }
      log.warn('settings 命名空间注册失败，回退为仅 cordis.yml 配置:', error)
      scope = undefined
      registeredProvider = undefined
      return false
    }
    live = scope.get()
    scope.watch((next) => {
      trace('watch fired: zai.enabled=' + String(next?.servers?.zai?.enabled) + ' demo.enabled=' + String(next?.servers?.demo?.enabled))
      live = next
      reconcile(next)
    })
    // 首次使用：用户层为空时植入演示服务器（仅一次；之后 UI 可删除）
    try {
      const desc = settingsService.describe()
      const mine = desc.find((d) => String(d.ns) === 'mcp-servers')
      const hasUser = mine && mine.user !== undefined && mine.user !== null
      if (!hasUser && Object.keys(live.servers ?? {}).length === 0) {
        scope.update({ servers: { demo: DEMO_SERVER } }).catch((error) => {
          log.warn('演示服务器植入失败:', error)
        })
      }
    } catch (error) {
      log.warn('检查 settings 用户层失败:', error)
    }
    return true
  }

  installNamespace()
  // 自愈：每 10s 检查「当前」settings 服务实例上的注册是否健在，
  // 服务被热替换或注册被误删时自动重新注册（不影响已挂载的实例）。
  let healTimer
  try {
    healTimer = ctx.setInterval(() => {
      const settingsService = ctx.root.get('settings')
      let present = false
      try {
        // 包装对象身份跨调用不可靠（可能每次返回新包装），以注册存在性为准
        present = settingsService.get(settingsNamespace('mcp-servers')) !== undefined
      } catch { /* 查询失败按缺失处理，走重装 */ }
        if (present) return
      if (installNamespace()) {
        log.info('settings 命名空间已自愈重装')
        reconcile(live)
      }
    }, 10000)
  } catch (error) {
  }
  ctx.effect(() => () => clearInterval(healTimer), 'dsh-mcp-manager.heal')

  // 初始对账（基于合并后的配置）
  reconcile(live)

  // 卸载时释放所有子实例（嵌套 fiber 本会被父生命周期带走，这里兜底）
  ctx.effect(() => () => {
    for (const rec of mounted.values()) {
      try { rec.fiber?.dispose?.() } catch { /* 幂等卸载 */ }
    }
    mounted.clear()
    // 释放本实例持有的 settings 注册（身份守卫式；误删新注册由 dispose 内部防住）
    try { scope?.dispose?.() } catch { /* 幂等 */ }
  }, 'dsh-mcp-manager.mounted')

  // 内部命令：/mcp-status —— 返回各服务器运行时状态 JSON（设置页轮询）
  ctx.commands.register({
    name: 'mcp-status',
    description: '内部命令：返回 MCP 服务器运行时状态 JSON（供设置页轮询）',
    recordInput: false,
    handler: () => {
      let toolSchemas = []
      try { toolSchemas = ctx.tools.schemas() } catch { /* 统计失败按 0 处理 */ }
      const servers = Object.entries(live?.servers ?? {}).map(([serverName, spec]) => {
        const enabled = spec?.enabled === true
        const rec = mounted.get(serverName)
        const tools = enabled
          ? toolSchemas.filter((s) => s?.name?.startsWith('mcp__' + serverName + '__')).map((s) => s.name)
          : []
        return {
          serverName,
          enabled,
          transport: spec?.transport ?? null,
          state: enabled ? (rec?.state ?? 'unknown') : 'disabled',
          error: enabled ? (rec?.error ?? null) : null,
          toolCount: tools.length,
          tools,
          since: rec?.since ?? null,
        }
      })
      return { kind: 'success', text: JSON.stringify({ servers }) }
    },
  })
}