// genshu-fabric-tools 语义核（226号 升格自包含；116号 P0 只读桥 + 145号 P1-1 写通道）。
//
// 整迁自宿主 tools/fabric.ts（已删，迁移不并存——120号 §8③）：search/read/write 三元
// + tools-list 目录的完整语义——admin 门 fail-closed / scope 硬限与 kb 拒写（145号 §3
// 写通道单一职责）/ frontmatter 机械组装（137b §3.1 出身标注）/ supersede 流 / 逐写
// git commit / 路径逃逸护栏 / 读扫截断护栏。
//
// 零依赖纪律（child=Node，可分享前提）：仅 node: 标准库；zod 手写校验替代
// （memory-save core.js 先例）；fs / git exec 全注入（keyless 测试缝，生产不传直连
// node:fs/promises 与 child_process.execFile）。
//
// root 来源：opts.rootDir（插件 config，桌面单操作者直配）?? env GENSHU_FABRIC_ROOT
// （生产沿用——宿主 env 整份展开进子进程）。两者皆缺 = 整面不可用（fail-closed）。
//
// 门语义（fail-closed 铁律，116/145号）：ctx.isAdmin !== true 一律拒——admin 身份由
// 外层（index.js）经会话策略通道（120号 §5 身份注入，session-policy/dir-authz 同源）
// 或插件 config.admin 显式钉死解析后传入；本核只认布尔，不做任何角色猜测。
//
// 写面免审批（137b §2 治理模型：审批从事前挪到事后——可见 + 可撤销，撤销走织物
// git revert）；kb/ 拒写是物理约束（单向镜像会冲掉）不是权限规则。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import fsp from 'node:fs/promises'

// ---------- 常量（fabric.ts 逐字迁移） ----------

/** 单文件扫描上限：超此大小的文件跳过（镜像里的超大笔记不参与行扫） */
const SCAN_FILE_MAX_BYTES = 256 * 1024
/** 目录遍历文件数上限（防异常大树拖垮执行） */
const WALK_FILE_CAP = 2000
/** 目录遍历目录数上限（同上） */
const WALK_DIR_CAP = 500
/** 写 scope 白名单（145号 §3）：kb-inbox/ 是 agent 修订表达面（镜像排除、人策展收编
 *  后经正向镜像变权威源），memory/ 是跨端记忆原子；kb/ 单向镜像面拒写、元数据面拒写。 */
const WRITE_SCOPES = new Set(['memory', 'kb-inbox'])
/** fabric-write 正文字节上限：与读面 maxBytes 上限同值——写进去读不全的原子不允许造出 */
const WRITE_BODY_MAX_BYTES = 65536
/** 逐写 commit 的 git 子进程超时 */
const GIT_TIMEOUT_MS = 15000

// ---------- 手写校验（zod 等价面：未知键剥离同 zod object 缺省行为） ----------

/** 校验失败抛 Error（message 无前缀——调用方统一包「参数不合法：」） */
function requireStr(raw, field, min, max) {
  if (typeof raw !== 'string') throw new Error(`${field} 须为字符串`)
  if (raw.length < min || raw.length > max) throw new Error(`${field} 须为 ${min}-${max} 字符`)
  return raw
}
function optionalInt(raw, field, min, max, dflt) {
  if (raw === undefined) return dflt
  if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new Error(`${field} 须为整数`)
  if (raw < min || raw > max) throw new Error(`${field} 须在 ${min}-${max} 范围`)
  return raw
}
function optionalEnum(raw, field, values, dflt) {
  if (raw === undefined) return dflt
  if (typeof raw !== 'string' || !values.includes(raw)) throw new Error(`${field} 须为 ${values.join('|')} 之一`)
  return raw
}
function requiredEnum(raw, field, values) {
  if (typeof raw !== 'string' || !values.includes(raw)) throw new Error(`${field} 须为 ${values.join('|')} 之一`)
  return raw
}

export function parseSearchInput(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('参数须为对象')
  return {
    query: requireStr(raw.query, 'query', 1, 200),
    scope: optionalEnum(raw.scope, 'scope', ['kb', 'memory', 'all'], 'all'),
    max: optionalInt(raw.max, 'max', 1, 50, 20),
  }
}

export function parseReadInput(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('参数须为对象')
  return {
    path: requireStr(raw.path, 'path', 1, 500),
    maxBytes: optionalInt(raw.maxBytes, 'maxBytes', 1000, 65536, 32768),
  }
}

export function parseWriteInput(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('参数须为对象')
  const fm = raw.frontmatter
  if (typeof fm !== 'object' || fm === null) throw new Error('frontmatter 须为对象（出身标注必填：source + owner）')
  return {
    path: requireStr(raw.path, 'path', 1, 500),
    content: requireStr(raw.content, 'content', 1, Number.POSITIVE_INFINITY),
    frontmatter: {
      source: requiredEnum(fm.source, 'frontmatter.source', ['user-uttered', 'agent-inferred']),
      owner: requireStr(fm.owner, 'frontmatter.owner', 1, 200),
    },
    ...(raw.supersede !== undefined ? { supersede: requireStr(raw.supersede, 'supersede', 1, 500) } : {}),
  }
}

/** 目录入参（strict 空对象——目录零参数，工具名即广告牌） */
export function parseToolsListInput(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('参数须为空对象（目录零参数）')
  if (Object.keys(raw).length > 0) throw new Error('目录零参数——不接受任何入参（工具名即广告牌）')
  return {}
}

// ---------- 语义工厂 ----------

/**
 * @param {{
 *   rootDir?: string,
 *   env?: Record<string, string | undefined>,
 *   fsImpl?: Partial<ReturnType<typeof defaultFs>>,
 *   execImpl?: typeof execFileP,
 *   now?: () => string,
 * }} opts
 * 返回 { search, read, write, toolsList, rootDirOf }——每个 op (raw, ctx) →
 * { ok, message }；ctx = { sessionId?, isAdmin? }（isAdmin 由外层身份通道解析）。
 */
export function createFabricSemantics(opts = {}) {
  const env = opts.env ?? process.env
  const fs = { ...defaultFs(), ...(opts.fsImpl ?? {}) }
  const exec = opts.execImpl ?? defaultExec()
  const nowIso = opts.now ?? (() => new Date().toISOString())
  const rootRaw = opts.rootDir ?? env.GENSHU_FABRIC_ROOT
  const rootDir = typeof rootRaw === 'string' && rootRaw.trim() !== '' ? resolve(rootRaw.trim()) : undefined
  const rootDirOf = () => rootDir

  /** env+角色门（fail-closed）：不可用时返回统一的不可用文案，不暴露任何织物内容 */
  const unavailable = (reason) => ({
    ok: false,
    message: `fabric 工具不可用：${reason}。本工具访问运营者个人上下文织物（GENSHU_FABRIC_ROOT checkout），如需使用请联系实例运营者在服务端 env 配置。`,
  })

  const gate = (ctx) => {
    if (!rootDir) return unavailable('GENSHU_FABRIC_ROOT 未配置')
    if (ctx?.isAdmin !== true) return unavailable('当前会话非 admin 档（fabric 是运营者个人上下文，admin 权限方可取用）')
    return null
  }

  /** 读路径逃逸双护栏（search/read 同款）：相对路径 + resolve 后须在 root 内 */
  const readEscape = (path) => {
    if (isAbsolute(path) || path.includes('..')) {
      return { ok: false, message: '拒绝：path 须为 fabric 根的相对路径，不接受绝对路径或 ..。' }
    }
    const abs = resolve(rootDir, path)
    if (abs !== rootDir && !abs.startsWith(rootDir + sep)) {
      return { ok: false, message: '拒绝：路径越出 fabric 根。' }
    }
    return null
  }

  /**
   * 写 scope 守卫（145号 §3，fail-closed 明确报错而非静默丢失）：逃逸检查 + 顶层
   * scope 白名单 + .md 原子约束。kb/ 与 .git 有专属文案（拒写理由可行动），其余
   * 越界给 scope 说明。
   */
  const writeScopeGuard = (path) => {
    const escaped = readEscape(path)
    if (escaped) return escaped
    const abs = resolve(rootDir, path)
    const rel = relPathOf(rootDir, abs)
    const top = rel.split(sep)[0]
    if (top === 'kb') {
      return {
        ok: false,
        message:
          '拒绝：kb/ 是单向镜像面（人 Obsidian 策展权），写进去会被下次镜像冲掉（静默丢失）——本工具 fail-closed 拒写（145号 §3）。' +
          '修订表达走 kb-inbox/：agent 的修订落收件箱，人策展收编进 vault 后经正向镜像自动变权威源。',
      }
    }
    if (top.startsWith('.')) {
      return { ok: false, message: `拒绝：${top}/ 是织物元数据面（.git/.obsidian 等），不接受任何写入。` }
    }
    if (!WRITE_SCOPES.has(top)) {
      return {
        ok: false,
        message: `拒绝：fabric-write scope 硬限 memory/ 与 kb-inbox/（145号 §3 写通道单一职责——修正通道），得到 "${top}/"。`,
      }
    }
    if (!basename(rel).endsWith('.md')) {
      return { ok: false, message: '拒绝：目标须是 .md 原子（织物检索/读面只见 md），path 须指向具体文件而非 scope 目录本身。' }
    }
    return null
  }

  /** 逐写 commit（145号 §3）：作者（owner）/会话/时间由调用方拼入 message；身份用
   *  工具恒定值经 -c 注入（织物仓可能无 user.name 配置——commit 不得因此失败）。 */
  async function gitCommitAtoms(root, files, message) {
    await exec('git', ['-C', root, 'add', '--', ...files], { timeout: GIT_TIMEOUT_MS })
    await exec(
      'git',
      ['-C', root, '-c', 'user.name=genshu-fabric-write', '-c', 'user.email=fabric-write@genshu.local', 'commit', '-m', message, '--', ...files],
      { timeout: GIT_TIMEOUT_MS },
    )
    const out = await exec('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { timeout: GIT_TIMEOUT_MS })
    return String(out.stdout).trim()
  }

  /** 新原子组装（frontmatter 机械执行点，137b §3.1）：source/owner 来自必填入参，
   *  created 由工具落（ISO 时间），supersedes 关系入 frontmatter 便于导航。 */
  function composeAtom(source, owner, iso, supersedes, body) {
    const lines = ['---', `source: ${source}`, `owner: ${owner}`, `created: "${iso}"`]
    if (supersedes) lines.push(`supersedes: "${supersedes}"`)
    lines.push('---', '', body.replace(/\s+$/, ''), '')
    return lines.join('\n')
  }

  /** 旧原子标 superseded-by（不静默覆盖的另一半）：已有 frontmatter 则在块内落行
   *  （已有 superseded-by 行则更新）；无 frontmatter 则前置最小块。 */
  function markSuperseded(oldText, newPathRel) {
    const line = `superseded-by: "${newPathRel}"`
    const lines = oldText.split('\n')
    if (lines[0] === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
          const existing = lines.findIndex((l) => l.startsWith('superseded-by:'))
          if (existing > 0) lines[existing] = line
          else lines.splice(i, 0, line)
          return lines.join('\n')
        }
      }
    }
    return `---\n${line}\n---\n\n${oldText}`
  }

  /** 收集 root 下（scope 收窄）全部 md 文件相对路径；scope 目录不存在返回 null（文案区分） */
  async function walkMdFiles(scope) {
    const base = scope === 'all' ? rootDir : join(rootDir, scope)
    try {
      await fs.readdir(base)
    } catch {
      return null // 目录不存在：scope 拼写错/镜像未跑
    }
    const out = []
    const queue = [base]
    let seenDirs = 0
    while (queue.length > 0 && out.length < WALK_FILE_CAP) {
      const dir = queue.shift()
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue // 单目录消失（遍历中同步变动）：跳过不中断
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue // .git/.obsidian 等元数据不进检索面
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (++seenDirs > WALK_DIR_CAP) continue
          queue.push(full)
        } else if (e.isFile() && e.name.endsWith('.md')) {
          out.push(full)
          if (out.length >= WALK_FILE_CAP) break
        }
      }
    }
    return out
  }

  const fail = (message) => ({ ok: false, message })
  const pass = (message) => ({ ok: true, message })

  async function search(raw, ctx) {
    const blocked = gate(ctx)
    if (blocked) return blocked
    let input
    try {
      input = parseSearchInput(raw)
    } catch (err) {
      return fail(`参数不合法：${err instanceof Error ? err.message : String(err)}`)
    }
    const files = (await walkMdFiles(input.scope)) ?? []
    const needle = input.query.toLowerCase()
    const matches = []
    for (const abs of files) {
      if (matches.length >= input.max) break
      let text
      try {
        const st = await fs.stat(abs)
        if (st.size > SCAN_FILE_MAX_BYTES) continue
        text = await fs.readFile(abs, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length && matches.length < input.max; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push(`${relPathOf(rootDir, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
        }
      }
    }
    const header = `fabric ${input.scope} 检索 "${input.query}"：${matches.length} 处命中${files.length === 0 ? '（织物目录为空或不存在——镜像/同步可能未跑）' : ''}`
    return pass(matches.length ? `${header}\n${matches.join('\n')}` : `${header}\n无命中。可换更短的关键词，或用 fabric-read 直接读已知路径。`)
  }

  async function read(raw, ctx) {
    const blocked = gate(ctx)
    if (blocked) return blocked
    let input
    try {
      input = parseReadInput(raw)
    } catch (err) {
      return fail(`参数不合法：${err instanceof Error ? err.message : String(err)}`)
    }
    const escaped = readEscape(input.path)
    if (escaped) return escaped
    const abs = resolve(rootDir, input.path)
    let text
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      return fail(`读取失败：${input.path} 不存在或不可读（织物同步范围外/已移动）。可用 fabric-search 重新定位。`)
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    const body = bytes > input.maxBytes ? `${text.slice(0, input.maxBytes)}\n…（截断：全文 ${bytes} 字节，超 maxBytes=${input.maxBytes}）` : text
    return pass(`# ${input.path}\n\n${body}`)
  }

  async function write(raw, ctx) {
    const blocked = gate(ctx)
    if (blocked) return blocked
    let input
    try {
      input = parseWriteInput(raw)
    } catch (err) {
      return fail(`参数不合法：${err instanceof Error ? err.message : String(err)}`)
    }
    if (Buffer.byteLength(input.content, 'utf8') > WRITE_BODY_MAX_BYTES) {
      return fail(`拒绝：正文超 ${WRITE_BODY_MAX_BYTES} 字节上限（读面 maxBytes 同值——写进去读不全的原子不允许造出）。`)
    }
    const guarded = writeScopeGuard(input.path)
    if (guarded) return guarded
    const abs = resolve(rootDir, input.path)
    const newRel = relPathOf(rootDir, abs)

    // 可撤销性前提：根必须是 git 仓（145号 §3——逐写 commit 是 revert 白送的前提）
    try {
      await fs.stat(join(rootDir, '.git'))
    } catch {
      return fail('拒绝：fabric 根不是 git 仓——逐写 commit 不可用即拒写（可撤销性前提缺失）。请运营者先 git init 或修正 GENSHU_FABRIC_ROOT。')
    }

    // 不静默覆盖：目标必须不存在；改既有原子 = supersede 流（旧标 superseded-by + 落新文件）
    let oldAbs
    let oldText
    if (input.supersede !== undefined) {
      const oldGuarded = writeScopeGuard(input.supersede)
      if (oldGuarded) return { ok: false, message: `supersede 旧路径不合法——${oldGuarded.message}` }
      const oldRel = relPathOf(rootDir, resolve(rootDir, input.supersede))
      if (oldRel === newRel) {
        return fail('拒绝：supersede 流要求 path 用新路径（旧文件保留并标 superseded-by）——path 与 supersede 同路径属静默覆盖。')
      }
      oldAbs = resolve(rootDir, input.supersede)
      try {
        oldText = await fs.readFile(oldAbs, 'utf8')
      } catch {
        return fail(`拒绝：supersede 旧原子 ${input.supersede} 不存在或不可读——先 fabric-search 确认既有原子路径。`)
      }
    }
    try {
      await fs.stat(abs)
      return fail(`拒绝：${input.path} 已存在——本工具不静默覆盖（145号 §3）。改写既有原子走 supersede 流：supersede="${input.path}" + path 用新文件路径。`)
    } catch {
      // 目标不存在：正路
    }

    const iso = nowIso()
    try {
      await fs.mkdir(join(rootDir, newRel, '..'), { recursive: true })
      await fs.writeFile(abs, composeAtom(input.frontmatter.source, input.frontmatter.owner, iso, input.supersede, input.content), 'utf8')
      const touched = [abs]
      if (oldAbs !== undefined && oldText !== undefined) {
        await fs.writeFile(oldAbs, markSuperseded(oldText, newRel), 'utf8')
        touched.push(oldAbs)
      }
      const sessionId = typeof ctx?.sessionId === 'string' && ctx.sessionId !== '' ? ctx.sessionId : 'unknown-session'
      const supersedeNote = input.supersede !== undefined ? `\nsupersedes=${input.supersede}` : ''
      const shortSha = await gitCommitAtoms(rootDir, touched, `fabric-write: ${newRel}\n\nsource=${input.frontmatter.source} owner=${input.frontmatter.owner} session=${sessionId} time=${iso}${supersedeNote}`)
      const note = input.supersede !== undefined ? `旧原子 ${input.supersede} 已标 superseded-by: ${newRel}。` : ''
      return pass(`已写入 ${newRel}（frontmatter: source=${input.frontmatter.source}, owner=${input.frontmatter.owner}, created=${iso}）+ git commit ${shortSha}。${note}`)
    } catch (err) {
      const wrote = oldAbs !== undefined // 旧文件标记/新文件可能已部分落盘——如实呈报，不假装无副作用
      return fail(`写入失败：${err instanceof Error ? err.message : String(err)}${wrote ? '（注意：部分文件可能已落盘但未 commit——请检查织物 git 状态）' : '（织物未改动）'}`)
    }
  }

  async function toolsList(raw, ctx) {
    const blocked = gate(ctx)
    if (blocked) return blocked // 目录只说真话：门不过 = 不可用文案而非目录内容
    try {
      parseToolsListInput(raw)
    } catch (err) {
      return fail(`参数不合法：${err instanceof Error ? err.message : String(err)}`)
    }
    const catalog = [
      'fabric 工具目录（三元；本目录即供给面，执行走 fabric_call_tool {tool, args}）：',
      '',
      '1. fabric-search — 织物检索（kb 知识库镜像 + memory 记忆原子，path:line 命中行）',
      '   参数: {"query": string(1-200 子串), "scope": "kb"|"memory"|"all"(默认 all), "max": number(1-50, 默认 20)}',
      '2. fabric-read — 读单文件全文（search 结果的相对路径；超 maxBytes 截断）',
      '   参数: {"path": string, "maxBytes": number(1000-65536, 默认 32768)}',
      '3. fabric-write — 写/修正织物原子（scope 硬限 memory/ 与 kb-inbox/ 的 .md；frontmatter 出身标注必填；改既有原子走 supersede 流；逐写 git commit）',
      '   参数: {"path": string(memory/|kb-inbox/ 下新 .md 路径), "content": string(正文), "frontmatter": {"source": "user-uttered"|"agent-inferred", "owner": string}, "supersede"?: string(被取代旧原子路径)}',
      '',
      '沉淀新知识不走 fabric-write——用 memory-save（导出通道）；fabric-write 只服务对既有织物的修正与 kb-inbox 修订表达。',
    ].join('\n')
    return pass(catalog)
  }

  return { search, read, write, toolsList, rootDirOf }
}

function defaultFs() {
  return {
    readdir: fsp.readdir,
    readFile: fsp.readFile,
    writeFile: fsp.writeFile,
    mkdir: fsp.mkdir,
    stat: fsp.stat,
  }
}

function defaultExec() {
  return /** @type {typeof execFileP} */ (promisify(execFile))
}

function relPathOf(root, abs) {
  return abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs
}
