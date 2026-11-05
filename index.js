// genshu-fabric-tools — fabric 织物工具的 dsh 插件（116号 P0 只读桥 + 145号 P1-1
// 写通道，发现式供给——145号 §6/D0010：三元工具不静态注入工具列表，经目录发现 +
// 执行面分发，压缩静态工具面席位）。
//
// 形态变更（120号 §8③ 升格，226号）：原宿主回调薄壳（D0062，语义在宿主
// tools/fabric.ts 经 /api/internal/dsh/fabric-tools/:op 回调）已升格为**自包含插件**
// ——语义核整体迁入本包 core.js（scope 硬限与 kb 拒写/frontmatter 机械组装/
// supersede/逐写 git commit/路径逃逸护栏/读检护栏），宿主路由与工具工厂同步拆除，
// 本包成为唯一同源实例。host-client 白名单 13→12（再减，ARCHITECTURE 口径）：本包
// **零 import**——admin 身份取走是唯一外界触点（手写 fetch，见下），公共仓单文件
// 形态成立（github:FAKE0704/dsh-fabric-memory，npm 押后）。
//
// admin 门（fail-closed 铁律，116/145号 不弱化）：fabric 是运营者个人上下文织物，
// admin 档身份是**外界注入职责**（120号 §5 外界四件事之身份注入；child 内无 users
// 表）。双形态：
//  - 桌面（dsh desktop，单用户即运营者）：config.admin = true 直通；
//  - 生产（Genshu server，users 表是身份真源）：会话创建窗口（agent/created，
//    session-policy 先例形态）POST 宿主 /api/internal/dsh/fabric-admin-check
//    {dshSessionId} → {isAdmin}——宿主经 tool-context 注册表反解 genshu 会话后按
//    users.role 判定（GENSHU_DISABLE_AUTH=1 免鉴权模式同口径放行）；判定语义
//    单点在宿主（身份），门在插件（每次执行校验）。窗口回调失败/未登记 → 不设 →
//    拒（fail-closed：宁可不可用不可放行）。
//  写面免审批不变（137b §2 治理模型：审批从事前挪到事后——可见 + 可撤销：
//  frontmatter 出身标注 + 逐写 git commit，撤销走织物 git revert）。kb/ 拒写是
//  物理约束（单向镜像会冲掉）不是权限规则。写入策略 v1 = 只 commit 不自动 push
//  ——织物仓多端同步是用户自己的 git 工作流（README 说明）。
//
// 发现式供给语义不变：目录实例（fabric_tools_list——门不过返回不可用文案，「目录
// 只说真话」）+ 执行面（fabric_call_tool，tool 名白名单 search|read|write——既防
// 注入也是精确报错面）。工具实名零迁移：存量 prompt/白名单/plan-gate 只读分类/
// tool-name-map 词汇席位全部不动。
//
// keyless 纪律：语义全在 core.js（fs/git/时钟注入直测）；本文件只做注册/门控/
// 委托；网络经 config.impls.fetchImpl 注入（生产缺省全局 fetch）；config.impls
// 为测试缝（生产 config 不传）。

import {
  createFabricSemantics,
  fabricCatalog,
  parseReadInput,
  parseSearchInput,
  parseToolsListInput,
  parseWriteInput,
  resolveFabricRoot,
} from './core.js'

export const name = 'genshu-fabric-tools'
export const inject = ['tools']

/**
 * 执行面 op 白名单（客户端侧）：tool 名进语义分发——白名单是精确报错面 +
 * 参数面收窄（未知工具名本地拒，不走语义层）。legacy 三词汇
 * FabricSearch/FabricRead/FabricWrite 经宿主 tool-name-map 多对一同指 fabric_call_tool，
 * 词汇面不变。
 */
export const FABRIC_TOOL_OPS = Object.freeze(['search', 'read', 'write'])

/** @param {string} tool @returns {boolean} */
export function isFabricToolOp(tool) {
  return typeof tool === 'string' && FABRIC_TOOL_OPS.includes(tool)
}

/** 宿主回调 env 键（身份取走通道；host-client 同名键，本包零 import 自取）。 */
const HOST_BASE_ENV = 'GENSHU_DSH_HOST_BASE'
const HOST_TOKEN_ENV = 'GENSHU_DSH_HOST_TOKEN'
const DEFAULT_TIMEOUT_MS = 5000

/**
 * config 归一（升格后本地自管——host-client 的 normalizeHostPluginConfig 会剥掉
 * fabricRoot/admin 独有键，故不再透传）。挑五键：fabricRoot（桌面织物根）、
 * admin（桌面身份直通/显式关）、hostBase/token/timeoutMs（生产身份取走通道，
 * env 回落同 host-client 口径）。非对象 config 容错为空（profile 补丁层注入
 * 形状不可信）。
 * @param {unknown} config
 * @param {NodeJS.ProcessEnv} [env]
 */
export function normalizeConfig(config, env = process.env) {
  const raw = config && typeof config === 'object' ? config : {}
  const hostBase = raw.hostBase || env[HOST_BASE_ENV] || ''
  const token = raw.token || env[HOST_TOKEN_ENV] || ''
  const timeoutRaw = Number(raw.timeoutMs ?? env.GENSHU_DSH_HOST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 60000) : DEFAULT_TIMEOUT_MS
  if (hostBase && !/^https?:\/\//.test(hostBase)) {
    throw new Error(`genshu-fabric-tools: hostBase 须为 http(s) URL（得到 ${hostBase}）`)
  }
  return {
    fabricRoot: typeof raw.fabricRoot === 'string' && raw.fabricRoot.trim() !== '' ? raw.fabricRoot.trim() : undefined,
    admin: raw.admin === true ? true : raw.admin === false ? false : undefined,
    hostBase: hostBase.replace(/\/+$/, ''),
    token,
    timeoutMs,
  }
}

/**
 * admin 身份取走（生产形态，窗口一次性——120号 §5 身份注入的现行最小面）：
 * POST {dshSessionId} → {isAdmin:boolean}。非 2xx/网络错/超时返回 null（调用方
 * 不设 → 门拒，fail-closed）。测试经 opts.fetchImpl 注入不触网。
 * @param {string} dshSessionId
 * @param {ReturnType<typeof normalizeConfig>} cfg
 * @param {Partial<{signal: AbortSignal, fetchImpl: typeof fetch}>} opts
 * @returns {Promise<{ isAdmin: boolean } | null>}
 */
export async function fetchFabricAdminCheck(dshSessionId, cfg, opts = {}) {
  if (!cfg.hostBase || !cfg.token) return null
  const doFetch = opts.fetchImpl ?? fetch
  const timer = AbortSignal.timeout(cfg.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer
  let res
  try {
    res = await doFetch(`${cfg.hostBase}/api/internal/dsh/fabric-admin-check`, {
      method: 'POST',
      headers: { 'x-genshu-local-token': cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({ dshSessionId }),
      signal,
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const body = await res.json().catch(() => null)
  if (!body || typeof body !== 'object' || typeof body.isAdmin !== 'boolean') return null
  return { isAdmin: body.isAdmin }
}

/** 两元 canonical value 的输出面（ok/message 双字段 + 文本渲染）。 */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
    required: ['ok', 'message'],
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

/** ToolResult 形（{content,isError}）→ 输出面值（{ok,message}）。 */
const toValue = (r) => ({ ok: r.isError !== true, message: r.content })

/**
 * @param {import('../types.d.ts').PluginCtx} ctx @param {unknown} config
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const impls = (config && typeof config === 'object' && config.impls && typeof config.impls === 'object') ? config.impls : {}
  // fetchImpl 是身份取走通道的测试缝（生产缺省全局 fetch）；其余键（fs/git/now）归语义核
  const fetchImpl = typeof impls.fetchImpl === 'function' ? impls.fetchImpl : undefined
  const semantics = createFabricSemantics(impls)
  // root 来源判定（env 读一次进闭包，改配置须重启——与升格前同口径运维纪律）：
  // config.fabricRoot（桌面）→ env GENSHU_FABRIC_ROOT（生产沿用）→ undefined。
  const rootDir = resolveFabricRoot(cfg.fabricRoot)
  if (rootDir) semantics.bindRoot(rootDir)

  /** 会话 → admin 判定（agent/created 窗口取走，agent/disposed 清理——session-policy
   *  同款生命周期）。桌面 config.admin 直通不走此表。 */
  const adminBySession = new Map()

  const isAdminSession = (sid) => {
    if (cfg.admin === true) return true
    if (cfg.admin === false) return false
    return adminBySession.get(sid) === true
  }

  /** 门（fail-closed）：root 未配置 / 非 admin 统一不可用文案，不暴露任何织物内容。 */
  const gate = (sid) => {
    if (!rootDir) {
      return 'fabric 工具不可用：fabric root 未配置（env GENSHU_FABRIC_ROOT 或插件 config.fabricRoot）。本工具访问运营者个人上下文织物（kb 镜像 + memory 原子），如需使用请联系实例运营者配置。'
    }
    if (!isAdminSession(sid)) {
      return 'fabric 工具不可用：当前会话非 admin 档（fabric 是运营者个人上下文，admin 权限方可取用）。'
    }
    return null
  }

  // 生产身份取走（120号 §5）：会话创建窗口一问一答，工具执行时零回调。
  // 无 hostBase/token（桌面形态）零回调——身份走 config.admin。
  ctx.on('agent/created', async ({ agent, signal }) => {
    const sid = agent?.id
    if (!sid) return
    if (cfg.admin !== undefined) return // 桌面直通/显式关：身份已定，零回调
    const out = await fetchFabricAdminCheck(sid, cfg, { ...(signal ? { signal } : {}), ...(fetchImpl ? { fetchImpl } : {}) })
    if (out) adminBySession.set(sid, out.isAdmin) // 回调失败不设 → 门拒（fail-closed）
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const sid = agent?.id
    if (sid) adminBySession.delete(sid)
  })

  ctx.tools.register({
    name: 'fabric_tools_list',
    description:
      'fabric 织物工具目录（发现式供给：三元工具不直接出现在工具列表中，须经本目录发现、' +
      '经 fabric_call_tool 执行；工具名即广告牌）。fabric = 运营者个人上下文织物（kb 知识库' +
      '镜像 + memory 跨端记忆原子 + kb-inbox 修订收件箱）。三元：fabric-search（检索）、' +
      'fabric-read（读全文）、fabric-write（写/修正原子，scope 硬限 memory/ 与 kb-inbox/，' +
      'frontmatter 出身标注必填，逐写 git commit）。返回紧凑参数说明。admin 门 fail-closed：' +
      '未配置/非 admin 会话返回不可用说明而非目录内容。沉淀新知识走 memory-save 导出通道，' +
      '不走 fabric-write。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const blocked = gate(exec?.agent?.id)
      if (blocked) return { ok: false, message: blocked }
      try {
        parseToolsListInput(args ?? {})
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      return { ok: true, message: fabricCatalog() }
    },
  })

  ctx.tools.register({
    name: 'fabric_call_tool',
    description:
      '执行 fabric 织物工具（in-child 语义核自包含执行；admin 门/scope 硬限/frontmatter 校验' +
      '按插件语义生效，不会因走本通道而绕过）。用法：tool ∈ search|read|write（用 ' +
      'fabric_tools_list 返回的工具名），args 按其参数说明组装。返回 isError 时按内容修正参数' +
      '——插件会自校验参数与 scope（kb/ 拒写是物理约束：写进去会被单向镜像冲掉）。',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['search', 'read', 'write'], description: 'fabric 工具名（fabric_tools_list 返回的，大小写敏感）' },
        args: { type: 'object', description: '按该工具参数说明组装的参数（见 fabric_tools_list 目录）' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      if (!isFabricToolOp(args?.tool)) {
        return { ok: false, message: `未知 fabric 工具名：${JSON.stringify(args?.tool ?? null)}——可用值 search|read|write（先 fabric_tools_list 看目录）。` }
      }
      const blocked = gate(exec?.agent?.id)
      if (blocked) return { ok: false, message: blocked }
      const raw = args?.args ?? {}
      try {
        if (args.tool === 'search') return toValue(await semantics.search(parseSearchInput(raw)))
        if (args.tool === 'read') return toValue(await semantics.read(parseReadInput(raw)))
        return toValue(await semantics.write(parseWriteInput(raw), { sessionId: exec?.agent?.id }))
      } catch (err) {
        // parse 抛错（fabricInvalid）与语义层意外抛错同形归一 isError 工具值，不外抛
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}
