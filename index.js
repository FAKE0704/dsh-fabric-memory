// genshu-fabric-tools — Genshu fabric 织物工具的 dsh 插件（116号 P0 只读桥 +
// 145号 P1-1 写通道，发现式供给——145号 §6/D0010：三元工具不静态注入工具列表，
// 经目录发现 + 执行面分发，压缩静态工具面席位）。
//
// 形态：**自包含插件**（120号 §8③ 领域面升格，226号 实施记录；迁移不并存——宿主
// tools/fabric.ts 与 /api/internal/dsh/fabric-tools/:op 回调路由已删）。工具语义
// （admin 门/scope 硬限与 kb 拒写/frontmatter 机械组装/supersede/逐写 commit/路径
// 逃逸护栏）全在本包 core.js（零依赖：仅 node: 标准库，fs/git exec 注入测试缝）。
//
// 工具名不变（red line）：fabric_tools_list 目录 + fabric_call_tool 执行面 + 内部
// 三元 search|read|write——存量 prompt/白名单/tool-name-map（FabricSearch/Read/Write
// 三词汇多对一映射 fabric_call_tool）零迁移；插件 export name 保持
// 'genshu-fabric-tools'（供给链稳定；公共仓 dsh-fabric-memory 仅重写 package.json
// 字段，226号）。
//
// admin 门（fail-closed 铁律，116/145号；226号 §admin 通道选型）：
//   1. config.admin 显式 true/false = 运营者钉死（桌面单操作者通道——dsh desktop
//      无 Genshu 宿主，config 是运营者自有文件，与 env 同信任级）
//   2. 会话策略通道（120号 §5 身份注入，session-policy/dir-authz 同源同窗口）：
//      fetchSessionPolicy(dshSessionId).isAdmin === true——宿主在 run 起点单点判定
//      users 表 role 随策略下发（DshSessionPolicy.isAdmin，226号 新增字段），每会话
//      取一次后缓存（工具时零回调）
//   3. 缺省 false（fail-closed）——传输失败/无策略/字段缺席一律拒，不缓存（下次
//      调用重试；当次 fail-closed）
// 禁止去门或 fail-open：本插件任何路径都不产生「无身份即放行」。
//
// 审批门：**不设**（137b §2 治理模型机械执行：写免审批，可见 + 可撤销——frontmatter
// 出身标注 + 逐写 git commit，撤销走织物 git revert）。kb/ 拒写是物理约束不是权限规则。
//
// root 来源：config.rootDir（桌面直配）?? env GENSHU_FABRIC_ROOT（生产沿用——宿主
// env 整份展开进子进程）；皆缺 = 整面不可用文案。
//
// keyless 纪律：语义核（core.js）fs/exec 全注入直测；身份解析 fetchPolicy 注入直测；
// 注册/白名单纯函数直测。零网络触达（fetchPolicy 缺省实现仅在真会话中被宿主 client
// 走 loopback token 通道）。

// 相对导入（非 bare）：插件包是 profile `link:` 目标非 workspace 成员，bare 名在仓内
// 测试与 pnpm link 双环境下都不可靠；同级目录相对路径在部署树/symlink 下按真实路径解析。
// host-client import 论证（120号 §8 白名单纪律）：**身份面本质通道**（122号 改判判词
// 「回调=身份面本质通道长存白名单」）——语义零回调，唯一宿主触达 = 会话策略取走
// （dir-authz 取 allowRoots 同款先例）。
import { fetchSessionPolicy, normalizeHostPluginConfig } from '../genshu-dsh-host-client/index.js'
import { createFabricSemantics } from './core.js'

export const name = 'genshu-fabric-tools'
export const inject = ['tools']

/**
 * config 归一：host-client 归一（hostBase/token/timeoutMs，env 回落——身份通道用）
 * + 本插件自有字段 rootDir（织物根，桌面直配）/ admin（三态：true/false=钉死，
 * 缺省=策略通道）。
 * @param {unknown} config
 */
export function normalizeConfig(config) {
  const base = normalizeHostPluginConfig(config)
  const c = typeof config === 'object' && config !== null ? config : {}
  const out = { ...base }
  if (typeof c.rootDir === 'string' && c.rootDir.trim() !== '') out.rootDir = c.rootDir
  if (c.admin === true || c.admin === false) out.admin = c.admin
  return out
}

/**
 * 执行面 op 白名单（客户端侧）：tool 名分发前防线 + 精确报错面（226号 起不再进 URL
 * 路径，防线语义保留——未知 op 本地拒，不触网不到语义核）。
 */
export const FABRIC_TOOL_OPS = Object.freeze(['search', 'read', 'write'])

/** @param {string} tool @returns {boolean} */
export function isFabricToolOp(tool) {
  return typeof tool === 'string' && FABRIC_TOOL_OPS.includes(tool)
}

/**
 * admin 身份解析器（每会话缓存；226号 §admin 三档优先级）。
 * @param {ReturnType<typeof normalizeConfig>} cfg
 * @param {{fetchPolicy?: typeof fetchSessionPolicy}} deps 测试缝（缺省 = 宿主策略通道）
 * @returns {(dshSessionId: string) => Promise<boolean>}
 */
export function createIdentityResolver(cfg, deps = {}) {
  const fetchPolicy = deps.fetchPolicy ?? fetchSessionPolicy
  /** @type {Map<string, boolean>} */
  const cache = new Map()
  return async function isAdmin(dshSessionId) {
    if (cfg.admin === true) return true // 运营者钉死放行（桌面通道）
    if (cfg.admin === false) return false // 运营者钉死关闭
    if (cache.has(dshSessionId)) return cache.get(dshSessionId)
    let policy
    try {
      policy = await fetchPolicy(dshSessionId, cfg)
    } catch {
      return false // 传输异常：当次 fail-closed，不缓存（下次调用重试）
    }
    if (!policy || typeof policy !== 'object') return false
    const verdict = policy.isAdmin === true
    cache.set(dshSessionId, verdict)
    return verdict
  }
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

/**
 * @param {import('../types.d.ts').PluginCtx} ctx @param {unknown} config
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const sem = createFabricSemantics(cfg.rootDir ? { rootDir: cfg.rootDir } : {})
  const isAdminFor = createIdentityResolver(cfg)

  /** 公共执行径：会话身份 → admin 门（策略通道/config 钉死）→ 语义核 op。 */
  const run = async (op, args, exec, missingIdentityNote) => {
    const sid = exec?.agent?.id
    if (typeof sid !== 'string' || sid === '') {
      return { ok: false, message: `会话身份不可用（exec.agent 缺席）——fabric 工具须在 agent 会话内调用，本次${missingIdentityNote}。` }
    }
    const isAdmin = await isAdminFor(sid)
    return sem[op](args, { sessionId: sid, isAdmin })
  }

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
    async execute(_args, exec) {
      return run('toolsList', {}, exec, '未读取任何织物内容')
    },
  })

  ctx.tools.register({
    name: 'fabric_call_tool',
    description:
      '执行 fabric 织物工具（语义在本插件内核自包含执行：admin 门/scope 硬限/frontmatter ' +
      '校验/supersede 流/逐写 git commit 全在插件内生效，不会因走本通道而绕过）。' +
      '用法：tool ∈ search|read|write（用 fabric_tools_list 返回的工具名），args 按其参数' +
      '说明组装。返回 isError 时按内容修正参数——校验会自拒越界参数与 scope' +
      '（kb/ 拒写是物理约束：写进去会被单向镜像冲掉）。',
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
      return run(args.tool, args?.args ?? {}, exec, '未执行任何织物操作')
    },
  })
}
