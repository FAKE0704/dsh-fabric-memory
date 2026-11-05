// genshu-fabric-tools 语义核（120号 §8③ 升格：自包含 in-child 执行）。
//
// 从宿主 tools/fabric.ts（116号 P0 只读桥 + 145号 P1-1 写通道，已删）整迁：search/
// read/write 三元 + 发现式目录文本，scope 硬限与 kb 拒写/frontmatter 机械组装/
// supersede/逐写 git commit/路径逃逸护栏/读检护栏（大小与匹配数上限）。宿主回调
// 路由与工具工厂同步拆除——本包成为唯一同源实例（薄壳不变量「同一语义一个同源
// 实例」的单点从宿主搬进插件，语义随本质走）。
//
// 零依赖纪律（可分享前提，memory-save/local-llm core.js 同款）：不引 zod——入参
// 按既有 schema 契约手写复验（错误文案保持「参数不合法：…」形态）；child=Node，
// fs/git/时钟全注入（createFabricSemantics 缺省 node:fs/promises + execFile），
// keyless 测试换注入件直测。macOS/Linux/Windows：git 走 PATH 上的 git 可执行
// （与宿主实现同面）。写入策略 v1 = 只 commit 不自动 push——织物仓同步是用户
// 自己的 git 工作流（多端用户 README 说明）。
//
// admin 门不在此文件：门在 index.js（身份是外界注入职责，120号 §5——桌面
// config.admin 直通 / 生产 agent/created 窗口经宿主 fabric-admin-check 取走）。

import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

/** 单文件扫描上限：超此大小的文件跳过（镜像里的超大笔记不参与行扫） */
export const SCAN_FILE_MAX_BYTES = 256 * 1024
/** 目录遍历文件数上限（防异常大树拖垮回调） */
export const WALK_FILE_CAP = 2000
/** 目录遍历目录数上限（防环/异常深树） */
const WALK_DIR_CAP = 500
/** 写 scope 白名单（145号 §3）：kb-inbox/ 是 agent 修订表达面（镜像排除、人策展
 *  收编后经正向镜像变权威源），memory/ 是跨端记忆原子；kb/ 单向镜像面拒写、
 *  元数据面拒写。 */
export const WRITE_SCOPES = new Set(['memory', 'kb-inbox'])
/** fabric-write 正文字节上限：与读面 maxBytes 上限同值——写进去读不全的原子不允许造出 */
export const WRITE_BODY_MAX_BYTES = 65536
/** 逐写 commit 的 git 子进程超时 */
export const GIT_TIMEOUT_MS = 15000

const execFileP = promisify(execFile)

/** fabric root 解析序（升格后双源）：插件 config.fabricRoot（桌面形态）→
 *  env GENSHU_FABRIC_ROOT（生产沿用）→ undefined = 整面不可用。 */
export function resolveFabricRoot(configRoot, env = process.env) {
  const raw = (typeof configRoot === 'string' && configRoot.trim() !== '')
    ? configRoot
    : (typeof env.GENSHU_FABRIC_ROOT === 'string' ? env.GENSHU_FABRIC_ROOT.trim() : '')
  return raw !== '' ? resolve(raw) : undefined
}

// ---------- 入参手写复验（zod 契约镜像；fail-closed 文案「参数不合法：…」） ----------

function expectString(raw, label, min, max) {
  if (typeof raw !== 'string') return `${label} 须为字符串`
  if (raw.length < min || raw.length > max) return `${label} 长度须在 ${min}-${max}`
  return null
}

function expectInt(raw, label, min, max) {
  if (!Number.isInteger(raw)) return `${label} 须为整数`
  if (raw < min || raw > max) return `${label} 须在 ${min}-${max}`
  return null
}

function invalid(msg) {
  const err = new Error(`参数不合法：${msg}`)
  err.fabricInvalid = true
  return err
}

/** search 入参：query(1-200 子串) / scope(kb|memory|all,缺省 all) / max(1-50,缺省 20)。 */
export function parseSearchInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('入参须为对象')
  const qErr = expectString(raw.query, 'query', 1, 200)
  if (qErr) throw invalid(qErr)
  const scope = raw.scope === undefined ? 'all' : raw.scope
  if (scope !== 'kb' && scope !== 'memory' && scope !== 'all') throw invalid('scope 须为 kb|memory|all 之一')
  const max = raw.max === undefined ? 20 : raw.max
  const mErr = expectInt(max, 'max', 1, 50)
  if (mErr) throw invalid(mErr)
  return { query: raw.query, scope, max }
}

/** read 入参：path(1-500 相对路径) / maxBytes(1000-65536,缺省 32768)。 */
export function parseReadInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('入参须为对象')
  const pErr = expectString(raw.path, 'path', 1, 500)
  if (pErr) throw invalid(pErr)
  const maxBytes = raw.maxBytes === undefined ? 32768 : raw.maxBytes
  const mErr = expectInt(maxBytes, 'maxBytes', 1000, 65536)
  if (mErr) throw invalid(mErr)
  return { path: raw.path, maxBytes }
}

const SOURCE_ENUM = new Set(['user-uttered', 'agent-inferred'])

/** write 入参：path/content/frontmatter{source,owner}/supersede?——frontmatter 出身
 *  标注必填（137b §3.1：source/owner 必填、created 由工具落，不靠模型自报）。 */
export function parseWriteInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('入参须为对象')
  const pErr = expectString(raw.path, 'path', 1, 500)
  if (pErr) throw invalid(pErr)
  if (typeof raw.content !== 'string' || raw.content.length < 1) throw invalid('content 须为非空字符串')
  const fm = raw.frontmatter
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) throw invalid('frontmatter 须为对象（出身标注 source/owner 必填）')
  if (!SOURCE_ENUM.has(fm.source)) throw invalid('frontmatter.source 须为 user-uttered|agent-inferred 之一')
  const oErr = expectString(fm.owner, 'frontmatter.owner', 1, 200)
  if (oErr) throw invalid(oErr)
  let supersede
  if (raw.supersede !== undefined) {
    const sErr = expectString(raw.supersede, 'supersede', 1, 500)
    if (sErr) throw invalid(sErr)
    supersede = raw.supersede
  }
  return { path: raw.path, content: raw.content, frontmatter: { source: fm.source, owner: fm.owner }, supersede }
}

/** 目录入参（strict 空对象——目录零参数，工具名即广告牌）。 */
export function parseToolsListInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 0) {
    throw invalid('目录零参数——不接受任何字段')
  }
  return {}
}

function relPathOf(root, abs) {
  return abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs
}

/**
 * 语义工厂：impls 注入全部副作用（fs 五件 + git 执行 + 时钟）；缺省 node 实现。
 * @param {{
 *   fs?: { mkdir: Function, readdir: Function, readFile: Function, writeFile: Function, stat: Function },
 *   git?: (args: string[]) => Promise<{ stdout: string }>,
 *   now?: () => string,
 * }} impls
 */
export function createFabricSemantics(impls = {}) {
  const fs = impls.fs ?? { mkdir, readdir, readFile, writeFile, stat }
  const git = impls.git ?? ((args) => execFileP('git', args, { timeout: GIT_TIMEOUT_MS }))
  const now = impls.now ?? (() => new Date().toISOString())
  let rootDir // 闭包根（bindRoot 时 resolve 定格——root 来源判定的产物）

  const bindRoot = (root) => { rootDir = root }

  /** root+角色门共用：root 未绑定即整面不可用（fail-closed 文案不暴露织物内容）。 */
  const requireRoot = () => rootDir

  /** 读路径逃逸双护栏（search/read 同款）：相对路径 + resolve 后须在 root 内 */
  function readEscape(path) {
    if (isAbsolute(path) || path.includes('..')) {
      return '拒绝：path 须为 fabric 根的相对路径，不接受绝对路径或 ..。'
    }
    const abs = resolve(rootDir, path)
    if (abs !== rootDir && !abs.startsWith(rootDir + sep)) {
      return '拒绝：路径越出 fabric 根。'
    }
    return null
  }

  /**
   * 写 scope 守卫（145号 §3，fail-closed 明确报错而非静默丢失）：逃逸检查 + 顶层
   * scope 白名单 + .md 原子约束。kb/ 与 .git 有专属文案（拒写理由可行动），其余
   * 越界给 scope 说明。
   */
  function writeScopeGuard(path) {
    const escaped = readEscape(path)
    if (escaped) return escaped
    const abs = resolve(rootDir, path)
    const rel = relPathOf(rootDir, abs)
    const top = rel.split(sep)[0]
    if (top === 'kb') {
      return '拒绝：kb/ 是单向镜像面（人 Obsidian 策展权），写进去会被下次镜像冲掉（静默丢失）——本工具 fail-closed 拒写（145号 §3）。' +
        '修订表达走 kb-inbox/：agent 的修订落收件箱，人策展收编进 vault 后经正向镜像自动变权威源。'
    }
    if (top.startsWith('.')) {
      return `拒绝：${top}/ 是织物元数据面（.git/.obsidian 等），不接受任何写入。`
    }
    if (!WRITE_SCOPES.has(top)) {
      return `拒绝：fabric-write scope 硬限 memory/ 与 kb-inbox/（145号 §3 写通道单一职责——修正通道），得到 "${top}/"。`
    }
    if (!basename(rel).endsWith('.md')) {
      return '拒绝：目标须是 .md 原子（织物检索/读面只见 md），path 须指向具体文件而非 scope 目录本身。'
    }
    return null
  }

  /** 逐写 commit（145号 §3）：作者（owner）/会话/时间由调用方拼入 message；身份用
   *  工具恒定值经 -c 注入（织物仓可能无 user.name 配置——commit 不得因此失败）。 */
  async function gitCommitAtoms(root, files, message) {
    await git(['-C', root, 'add', '--', ...files])
    await git(['-C', root, '-c', 'user.name=genshu-fabric-write', '-c', 'user.email=fabric-write@genshu.local', 'commit', '-m', message, '--', ...files])
    const { stdout } = await git(['-C', root, 'rev-parse', '--short', 'HEAD'])
    return stdout.trim()
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

  /** fabric-search：子串检索（大小写不敏感；path:line 命中行）。返回 {content, isError}。 */
  async function search(input) {
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
    return {
      content: matches.length ? `${header}\n${matches.join('\n')}` : `${header}\n无命中。可换更短的关键词，或用 fabric-read 直接读已知路径。`,
      isError: false,
    }
  }

  /** fabric-read：读单文件全文（超 maxBytes 截断带字节说明）。返回 {content, isError}。 */
  async function read(input) {
    const escaped = readEscape(input.path)
    if (escaped) return { content: escaped, isError: true }
    const abs = resolve(rootDir, input.path)
    let text
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      return { content: `读取失败：${input.path} 不存在或不可读（织物同步范围外/已移动）。可用 fabric-search 重新定位。`, isError: true }
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    const body = bytes > input.maxBytes ? `${text.slice(0, input.maxBytes)}\n…（截断：全文 ${bytes} 字节，超 maxBytes=${input.maxBytes}）` : text
    return { content: `# ${input.path}\n\n${body}`, isError: false }
  }

  /** fabric-write：写/修正原子（scope 硬限/frontmatter 机械组装/supersede/逐写 commit）。
   *  opts.sessionId 入逐写 commit message（作者/会话/时间入 message——撤销走 git revert）。 */
  async function write(input, opts = {}) {
    if (Buffer.byteLength(input.content, 'utf8') > WRITE_BODY_MAX_BYTES) {
      return { content: `拒绝：正文超 ${WRITE_BODY_MAX_BYTES} 字节上限（读面 maxBytes 同值——写进去读不全的原子不允许造出）。`, isError: true }
    }
    const guarded = writeScopeGuard(input.path)
    if (guarded) return { content: guarded, isError: true }
    const abs = resolve(rootDir, input.path)
    const newRel = relPathOf(rootDir, abs)

    // 可撤销性前提：根必须是 git 仓（145号 §3——逐写 commit 是 revert 白送的前提）
    try {
      await fs.stat(join(rootDir, '.git'))
    } catch {
      return { content: '拒绝：fabric 根不是 git 仓——逐写 commit 不可用即拒写（可撤销性前提缺失）。请运营者先 git init 或修正 fabric root 配置。', isError: true }
    }

    // 不静默覆盖：目标必须不存在；改既有原子 = supersede 流（旧标 superseded-by + 落新文件）
    let oldAbs
    let oldText
    if (input.supersede !== undefined) {
      const oldGuarded = writeScopeGuard(input.supersede)
      if (oldGuarded) return { content: `supersede 旧路径不合法——${oldGuarded}`, isError: true }
      const oldRel = relPathOf(rootDir, resolve(rootDir, input.supersede))
      if (oldRel === newRel) {
        return { content: '拒绝：supersede 流要求 path 用新路径（旧文件保留并标 superseded-by）——path 与 supersede 同路径属静默覆盖。', isError: true }
      }
      oldAbs = resolve(rootDir, input.supersede)
      try {
        oldText = await fs.readFile(oldAbs, 'utf8')
      } catch {
        return { content: `拒绝：supersede 旧原子 ${input.supersede} 不存在或不可读——先 fabric-search 确认既有原子路径。`, isError: true }
      }
    }
    try {
      await fs.stat(abs)
      return {
        content: `拒绝：${input.path} 已存在——本工具不静默覆盖（145号 §3）。改写既有原子走 supersede 流：supersede="${input.path}" + path 用新文件路径。`,
        isError: true,
      }
    } catch {
      // 目标不存在：正路
    }

    const iso = now()
    try {
      // 目标目录（root/newRel 的父目录）——必须以 root 为基准（newRel 是 root 相对
      // 路径，单独 join 会落 process.cwd()，写深路径时目录建错位）。
      await fs.mkdir(join(rootDir, newRel, '..'), { recursive: true })
      await fs.writeFile(abs, composeAtom(input.frontmatter.source, input.frontmatter.owner, iso, input.supersede, input.content), 'utf8')
      const touched = [abs]
      if (oldAbs !== undefined && oldText !== undefined) {
        await fs.writeFile(oldAbs, markSuperseded(oldText, newRel), 'utf8')
        touched.push(oldAbs)
      }
      const sessionId = typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : 'unknown-session'
      const supersedeNote = input.supersede !== undefined ? `\nsupersedes=${input.supersede}` : ''
      const shortSha = await gitCommitAtoms(rootDir, touched, `fabric-write: ${newRel}\n\nsource=${input.frontmatter.source} owner=${input.frontmatter.owner} session=${sessionId} time=${iso}${supersedeNote}`)
      const note = input.supersede !== undefined ? `旧原子 ${input.supersede} 已标 superseded-by: ${newRel}。` : ''
      return {
        content: `已写入 ${newRel}（frontmatter: source=${input.frontmatter.source}, owner=${input.frontmatter.owner}, created=${iso}）+ git commit ${shortSha}。${note}`,
        isError: false,
      }
    } catch (err) {
      const wrote = oldAbs !== undefined // 旧文件标记/新文件可能已部分落盘——如实呈报，不假装无副作用
      return {
        content: `写入失败：${err instanceof Error ? err.message : String(err)}${wrote ? '（注意：部分文件可能已落盘但未 commit——请检查织物 git 状态）' : '（织物未改动）'}`,
        isError: true,
      }
    }
  }

  return { bindRoot, requireRoot, search, read, write, composeAtom, markSuperseded }
}

/** 发现式目录文本（145号 §6/D0010：三元工具不静态注入，经目录发现 + 执行面分发）。 */
export function fabricCatalog() {
  return [
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
}
