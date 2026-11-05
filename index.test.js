// genshu-fabric-tools keyless 单测（226号 升格自包含后本文件 = 语义唯一测试面；
// 宿主 __tests__/tools/fabric.test.ts 与 __tests__/routes/internal-dsh-fabric-tools.test.ts
// 已随迁移删除）。覆盖：语义核全断言面（admin 门 fail-closed / scope 硬限与 kb 拒写 /
// 路径逃逸 / 截断与缺失文案 / frontmatter 机械校验 / supersede 流 / 逐写 commit /
// 不静默覆盖）+ 身份解析三档（config 钉死/策略通道/缺省拒）+ 注册接线与执行面白名单。
// 纯 fs 临时目录 + 真实 git init 桩（写面 commit 断言），无网络无 DB。绝不触碰真实
// checkout ~/context-fabric。
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createIdentityResolver, FABRIC_TOOL_OPS, isFabricToolOp, normalizeConfig } from './index.js'
import { createFabricSemantics, parseReadInput, parseSearchInput, parseWriteInput } from './core.js'

const ADMIN = { sessionId: 's-owner', isAdmin: true }
const OTHER = { sessionId: 's-other', isAdmin: false }

const makeCtx = () => {
  const registered = new Map()
  const hooks = new Map()
  return {
    registered,
    hooks,
    tools: { register: (t) => registered.set(t.name, t) },
    on: (event, fn) => hooks.set(event, fn),
  }
}

describe('isFabricToolOp（执行面客户端白名单）', () => {
  test('search|read|write 放行；畸形/未知/路径注入形态拒（语义核分发前防线）', () => {
    expect(isFabricToolOp('search')).toBe(true)
    expect(isFabricToolOp('read')).toBe(true)
    expect(isFabricToolOp('write')).toBe(true)
    expect(FABRIC_TOOL_OPS).toEqual(['search', 'read', 'write'])
    expect(isFabricToolOp('list')).toBe(false)
    expect(isFabricToolOp('../.git/config')).toBe(false)
    expect(isFabricToolOp('')).toBe(false)
    expect(isFabricToolOp(null)).toBe(false)
    expect(isFabricToolOp(undefined)).toBe(false)
    expect(isFabricToolOp(42)).toBe(false)
  })
})

describe('normalizeConfig（host 通道字段 + rootDir/admin 自有字段）', () => {
  test('undefined → 缺省 env 口径；rootDir/admin 类型护栏', () => {
    expect(normalizeConfig(undefined)).toBeTypeOf('object')
    expect(normalizeConfig({ hostBase: 'http://h', token: 'tk' }).hostBase).toBe('http://h')
    expect(normalizeConfig({ rootDir: '/fabric', admin: true })).toEqual(expect.objectContaining({ rootDir: '/fabric', admin: true }))
    expect(normalizeConfig({ admin: 'yes' }).admin).toBeUndefined() // 非布尔不收（三态护栏）
    expect(normalizeConfig({ rootDir: '   ' }).rootDir).toBeUndefined()
  })
})

describe('createIdentityResolver（admin 门三档，226号 §admin）', () => {
  test('config.admin 显式钉死优先于策略通道（不触 fetch）', async () => {
    let fetches = 0
    const fetchPolicy = async () => {
      fetches += 1
      return { isAdmin: false }
    }
    expect(await createIdentityResolver(normalizeConfig({ admin: true }), { fetchPolicy })('s1')).toBe(true)
    expect(await createIdentityResolver(normalizeConfig({ admin: false }), { fetchPolicy })('s1')).toBe(false)
    expect(fetches).toBe(0)
  })

  test('策略通道：isAdmin=true 取走并缓存（同会话二次零 refetch）；无字段=false', async () => {
    let fetches = 0
    const fetchPolicy = async () => {
      fetches += 1
      return { allowTools: ['fabric_call_tool'], isAdmin: true }
    }
    const gate = createIdentityResolver(normalizeConfig({}), { fetchPolicy })
    expect(await gate('s1')).toBe(true)
    expect(await gate('s1')).toBe(true)
    expect(fetches).toBe(1) // 缓存生效
    expect(await gate('s2')).toBe(true) // 另一会话独立取
    expect(fetches).toBe(2)
    const noField = createIdentityResolver(normalizeConfig({}), { fetchPolicy: async () => ({ allowTools: ['read'] }) })
    expect(await noField('s3')).toBe(false) // 字段缺席 fail-closed
  })

  test('传输失败/空策略：当次 false 且不缓存（下次调用重试——短暂宿主不可达自愈）', async () => {
    let shouldFail = true
    let fetches = 0
    const gate = createIdentityResolver(normalizeConfig({}), {
      fetchPolicy: async () => {
        fetches += 1
        if (shouldFail) return null
        return { isAdmin: true }
      },
    })
    expect(await gate('s1')).toBe(false)
    expect(await gate('s1')).toBe(false)
    expect(fetches).toBe(2) // 失败不缓存
    shouldFail = false
    expect(await gate('s1')).toBe(true) // 恢复后取到真身份
    expect(fetches).toBe(3)
    expect(await gate('s1')).toBe(true) // 成功后缓存（零 refetch）
    expect(fetches).toBe(3)
  })
})

// ── 语义核：只读面（search/read/toolsList）──────────────────────────────

let root
let sem

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fabric-test-'))
  await mkdir(join(root, 'kb', '03-项目'), { recursive: true })
  await mkdir(join(root, 'memory'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'kb', 'README.md'), '# 知识库\n部署走 ci-deploy.sh\n')
  await writeFile(join(root, 'kb', '03-项目', 'pylon.md'), '# Pylon\n判据 ≤10轮/30min/零介入×3\n')
  await writeFile(join(root, 'memory', 'user-pref.md'), '---\nowner: u1\n---\n沟通偏好：结论先行\n')
  await writeFile(join(root, '.git', 'config.md'), '部署走 ci-deploy.sh\n') // 元数据面不应被检索
  await writeFile(join(root, 'kb', 'big.md'), `${'x'.repeat(300 * 1024)}\n部署走 ci-deploy.sh\n`) // 超 256k 跳过

  sem = createFabricSemantics({ rootDir: root })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('语义核·admin 门（fail-closed）', () => {
  test('rootDir 未配置 → 四 op 统一不可用文案，不暴露织物内容', async () => {
    const t = createFabricSemantics({ rootDir: undefined, env: {} }) // env 显式清空——真机设了 GENSHU_FABRIC_ROOT，缺省回落会触真织物
    const out = await t.search({ query: '部署' }, ADMIN)
    expect(out.ok).toBe(false)
    expect(out.message).toContain('GENSHU_FABRIC_ROOT 未配置')
    const out2 = await t.read({ path: 'kb/README.md' }, ADMIN)
    expect(out2.ok).toBe(false)
    expect(out2.message).toContain('不可用')
    const out3 = await t.write({ path: 'memory/a.md', content: 'x', frontmatter: { source: 'agent-inferred', owner: 'u' } }, ADMIN)
    expect(out3.message).toContain('不可用')
    const out4 = await t.toolsList({}, ADMIN)
    expect(out4.message).toContain('不可用')
  })

  test('env GENSHU_FABRIC_ROOT 缺省 root（生产沿用；注入 env 测试缝）', () => {
    const t = createFabricSemantics({ env: { GENSHU_FABRIC_ROOT: root } })
    expect(t.rootDirOf()).toBe(root)
    const tMissing = createFabricSemantics({ rootDir: undefined, env: {} })
    expect(tMissing.rootDirOf()).toBeUndefined()
  })

  test('非 admin 会话 → 不可用文案（不读任何文件）；isAdmin 缺席同拒（fail-closed）', async () => {
    const out = await sem.search({ query: '部署' }, OTHER)
    expect(out.ok).toBe(false)
    expect(out.message).toContain('非 admin 档')
    expect(out.message).not.toContain('ci-deploy')
    const absent = await sem.search({ query: '部署' }, { sessionId: 's3' })
    expect(absent.ok).toBe(false)
    expect(absent.message).toContain('非 admin 档')
  })
})

describe('语义核·fabric-search', () => {
  test('all 域：跨 kb/memory 命中，.git 元数据与超大文件不进检索面', async () => {
    const out = await sem.search({ query: '部署走' }, ADMIN)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('kb/README.md:2:')
    expect(out.message).not.toContain('.git/config.md')
    expect(out.message).not.toContain('kb/big.md')
  })

  test('scope 收窄：memory 域只搜记忆原子（大小写不敏感）', async () => {
    const out = await sem.search({ query: '结论先行', scope: 'memory' }, ADMIN)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('memory/user-pref.md:4:')
    const upper = await sem.search({ query: 'PYLON', scope: 'kb' }, ADMIN)
    expect(upper.message).toContain('03-项目/pylon.md')
  })

  test('无命中 → 换词建议 + 0 处命中；scope 目录不存在 → 镜像未跑提示；非法 scope = 参数不合法', async () => {
    const none = await sem.search({ query: '不存在的关键词xyz' }, ADMIN)
    expect(none.message).toContain('0 处命中')
    expect(none.message).toContain('无命中')
    // scope 合法但目录不存在（镜像未跑）→ 空结果带提示——独立 fixture（无 kb/）
    const noKbRoot = await mkdtemp(join(tmpdir(), 'fabric-nokb-'))
    try {
      const noKb = createFabricSemantics({ rootDir: noKbRoot })
      const missing = await noKb.search({ query: 'x', scope: 'kb' }, ADMIN)
      expect(missing.ok).toBe(true)
      expect(missing.message).toContain('织物目录为空或不存在')
    } finally {
      await rm(noKbRoot, { recursive: true, force: true })
    }
    // 非法 scope（zod enum 同面）→ 参数不合法而非静默空结果
    const badScope = await sem.search({ query: 'x', scope: 'nosuch' }, ADMIN)
    expect(badScope.ok).toBe(false)
    expect(badScope.message).toContain('参数不合法')
  })

  test('max 上限截断', async () => {
    const out = await sem.search({ query: 'e', max: 1 }, ADMIN)
    expect(out.message).toContain('1 处命中')
  })
})

describe('语义核·fabric-read', () => {
  test('读相对路径全文（带 # path 头）', async () => {
    const out = await sem.read({ path: 'kb/README.md' }, ADMIN)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('# kb/README.md')
    expect(out.message).toContain('部署走 ci-deploy.sh')
  })

  test('路径逃逸拒绝：绝对路径 / .. 双护栏', async () => {
    const abs = await sem.read({ path: '/etc/passwd' }, ADMIN)
    expect(abs.ok).toBe(false)
    expect(abs.message).toContain('相对路径')
    const dotdot = await sem.read({ path: 'kb/../../etc/passwd' }, ADMIN)
    expect(dotdot.ok).toBe(false)
  })

  test('maxBytes 截断带字节说明；缺失文件给重定位建议', async () => {
    const truncated = await sem.read({ path: 'kb/big.md', maxBytes: 1000 }, ADMIN)
    expect(truncated.message).toContain('截断：全文')
    const missing = await sem.read({ path: 'kb/nope.md' }, ADMIN)
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('fabric-search')
  })
})

// ── 语义核：写面（145号 P1-1）——独立 git 真仓桩 ──────────────────────────

let wroot
let wsem

const revCount = (r) => {
  try {
    return execFileSync('git', ['-C', r, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return '0' // unborn HEAD（首次写前）
  }
}
const lastSubject = (r) => execFileSync('git', ['-C', r, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()
const lastBody = (r) => execFileSync('git', ['-C', r, 'log', '-1', '--format=%b'], { encoding: 'utf8' }).trim()

beforeAll(async () => {
  wroot = await mkdtemp(join(tmpdir(), 'fabric-write-test-'))
  execFileSync('git', ['-C', wroot, 'init', '-q'])
  await mkdir(join(wroot, 'memory'), { recursive: true })
  await mkdir(join(wroot, 'kb'), { recursive: true })
  await mkdir(join(wroot, 'kb-inbox'), { recursive: true })
  await writeFile(join(wroot, 'kb', 'vault.md'), '# 既有权威笔记\n决策 A 已定\n')
  await writeFile(join(wroot, 'memory', 'old-atom.md'), '---\nsource: user-uttered\nowner: human\ncreated: "2026-10-01"\n---\n\n旧结论：部署端口 3000\n')
  wsem = createFabricSemantics({ rootDir: wroot })
})

afterAll(async () => {
  await rm(wroot, { recursive: true, force: true })
})

const WRITE_ARGS = {
  content: '新结论：部署端口 8093',
  frontmatter: { source: 'agent-inferred', owner: 'ops-lead' },
}

describe('语义核·fabric-write（145号 P1-1）', () => {
  test('快乐路径：memory/ 落盘 + frontmatter 机械组装 + 逐写 commit（作者/会话/时间入 message）', async () => {
    const before = revCount(wroot)
    const out = await wsem.write({ path: 'memory/new-atom.md', ...WRITE_ARGS }, ADMIN)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('memory/new-atom.md')
    expect(out.message).toMatch(/git commit [0-9a-f]+/)
    // frontmatter 由工具机械组装（created 由工具落——不靠模型自报）
    const text = await readFile(join(wroot, 'memory', 'new-atom.md'), 'utf8')
    expect(text).toContain('source: agent-inferred')
    expect(text).toContain('owner: ops-lead')
    expect(text).toMatch(/created: "\d{4}-\d{2}-\d{2}T/)
    expect(text).toContain('新结论：部署端口 8093')
    // commit 产生：恰好 +1，subject 带 fabric-write: <path>，body 带 session 与出身
    expect(revCount(wroot)).toBe(String(Number(before) + 1))
    expect(lastSubject(wroot)).toContain('fabric-write: memory/new-atom.md')
    expect(lastBody(wroot)).toContain('source=agent-inferred')
    expect(lastBody(wroot)).toContain('owner=ops-lead')
    expect(lastBody(wroot)).toContain('session=s-owner')
    expect(lastBody(wroot)).toMatch(/time=\d{4}-\d{2}-\d{2}T/)
  })

  test('kb/ 拒写：fail-closed 明确报错（镜像冲掉理由 + 指路 kb-inbox），织物零改动', async () => {
    const before = revCount(wroot)
    const out = await wsem.write({ path: 'kb/vault.md', ...WRITE_ARGS }, ADMIN)
    expect(out.ok).toBe(false)
    expect(out.message).toContain('kb/')
    expect(out.message).toContain('镜像')
    expect(out.message).toContain('kb-inbox')
    expect(revCount(wroot)).toBe(before) // 零副作用
  })

  test('kb-inbox/ 放行（agent 修订表达面）；子目录自动创建', async () => {
    const out = await wsem.write({ path: 'kb-inbox/修订-决策A.md', ...WRITE_ARGS }, ADMIN)
    expect(out.ok).toBe(true)
    const text = await readFile(join(wroot, 'kb-inbox', '修订-决策A.md'), 'utf8')
    expect(text).toContain('source: agent-inferred')
    const nested = await wsem.write({ path: 'memory/2026/深目录.md', ...WRITE_ARGS }, ADMIN)
    expect(nested.ok).toBe(true)
    expect(await readFile(join(wroot, 'memory', '2026', '深目录.md'), 'utf8')).toContain('新结论')
  })

  test('点前缀元数据面（.git/.obsidian）与非法 scope 顶层拒写；非 .md 拒', async () => {
    const gitHit = await wsem.write({ path: '.git/config.md', ...WRITE_ARGS }, ADMIN)
    expect(gitHit.ok).toBe(false)
    expect(gitHit.message).toContain('元数据面')
    const obsidian = await wsem.write({ path: '.obsidian/note.md', ...WRITE_ARGS }, ADMIN)
    expect(obsidian.ok).toBe(false)
    const rogueScope = await wsem.write({ path: 'notes/scratch.md', ...WRITE_ARGS }, ADMIN)
    expect(rogueScope.ok).toBe(false)
    expect(rogueScope.message).toContain('scope 硬限')
    const notMd = await wsem.write({ path: 'memory/atom.txt', ...WRITE_ARGS }, ADMIN)
    expect(notMd.ok).toBe(false)
    expect(notMd.message).toContain('.md')
  })

  test('路径逃逸拒绝：绝对路径 / ..（写面同护栏）', async () => {
    const abs = await wsem.write({ path: '/tmp/evil.md', ...WRITE_ARGS }, ADMIN)
    expect(abs.ok).toBe(false)
    expect(abs.message).toContain('相对路径')
    const dotdot = await wsem.write({ path: 'memory/../../evil.md', ...WRITE_ARGS }, ADMIN)
    expect(dotdot.ok).toBe(false)
    expect(dotdot.message).toContain('相对路径')
  })

  test('frontmatter 出身标注必填（137b §3.1）：缺 source/owner、source 非法枚举均拒', async () => {
    const noSource = await wsem.write({ path: 'memory/f1.md', content: 'x', frontmatter: { owner: 'u' } }, ADMIN)
    expect(noSource.ok).toBe(false)
    expect(noSource.message).toContain('参数不合法')
    const noOwner = await wsem.write({ path: 'memory/f2.md', content: 'x', frontmatter: { source: 'user-uttered' } }, ADMIN)
    expect(noOwner.ok).toBe(false)
    const badSource = await wsem.write({ path: 'memory/f3.md', content: 'x', frontmatter: { source: 'model-hallucinated', owner: 'u' } }, ADMIN)
    expect(badSource.ok).toBe(false)
    const noFm = await wsem.write({ path: 'memory/f4.md', content: 'x' }, ADMIN)
    expect(noFm.ok).toBe(false)
    // 拒绝路径零落盘
    await expect(readFile(join(wroot, 'memory', 'f1.md'))).rejects.toThrow()
  })

  test('正文超 64k 拒（读面 maxBytes 同值——写进去读不全的原子不允许造出）', async () => {
    const out = await wsem.write({ path: 'memory/huge.md', content: 'x'.repeat(65537), frontmatter: WRITE_ARGS.frontmatter }, ADMIN)
    expect(out.ok).toBe(false)
    expect(out.message).toContain('65536')
  })

  test('目标已存在 → 拒（不静默覆盖），文案指路 supersede 流', async () => {
    const before = revCount(wroot)
    const out = await wsem.write({ path: 'memory/old-atom.md', ...WRITE_ARGS }, ADMIN)
    expect(out.ok).toBe(false)
    expect(out.message).toContain('不静默覆盖')
    expect(out.message).toContain('supersede')
    expect(revCount(wroot)).toBe(before)
    const text = await readFile(join(wroot, 'memory', 'old-atom.md'), 'utf8')
    expect(text).toContain('旧结论：部署端口 3000') // 原文未动
  })

  test('supersede 流：旧文件标 superseded-by + 新文件落 supersedes 行，单 commit 双文件', async () => {
    const before = revCount(wroot)
    const out = await wsem.write({ path: 'memory/old-atom-v2.md', ...WRITE_ARGS, supersede: 'memory/old-atom.md' }, ADMIN)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('superseded-by')
    // 旧文件保留且标 superseded-by（指向新路径），原文仍在
    const oldText = await readFile(join(wroot, 'memory', 'old-atom.md'), 'utf8')
    expect(oldText).toContain('superseded-by: "memory/old-atom-v2.md"')
    expect(oldText).toContain('旧结论：部署端口 3000')
    // 新文件带 supersedes 指回旧路径
    const newText = await readFile(join(wroot, 'memory', 'old-atom-v2.md'), 'utf8')
    expect(newText).toContain('supersedes: "memory/old-atom.md"')
    expect(newText).toContain('新结论：部署端口 8093')
    // 单 commit 覆盖双文件
    expect(revCount(wroot)).toBe(String(Number(before) + 1))
    expect(lastBody(wroot)).toContain('supersedes=memory/old-atom.md')
  })

  test('supersede 非法形态拒：同路径（静默覆盖变体）/ 旧路径不存在 / 旧路径越 scope', async () => {
    const same = await wsem.write({ path: 'memory/x.md', ...WRITE_ARGS, supersede: 'memory/x.md' }, ADMIN)
    expect(same.ok).toBe(false)
    expect(same.message).toContain('新路径')
    const missing = await wsem.write({ path: 'memory/y.md', ...WRITE_ARGS, supersede: 'memory/nope.md' }, ADMIN)
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('不存在')
    const kbOld = await wsem.write({ path: 'memory/z.md', ...WRITE_ARGS, supersede: 'kb/vault.md' }, ADMIN)
    expect(kbOld.ok).toBe(false)
    expect(kbOld.message).toContain('kb/')
  })

  test('根非 git 仓 → 拒写（逐写 commit 可撤销性前提缺失）', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'fabric-nogit-'))
    try {
      await mkdir(join(bare, 'memory'), { recursive: true })
      const t = createFabricSemantics({ rootDir: bare })
      const out = await t.write({ path: 'memory/a.md', ...WRITE_ARGS }, ADMIN)
      expect(out.ok).toBe(false)
      expect(out.message).toContain('git 仓')
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  test('execImpl 注入缝：git 失败 = 写入失败如实呈报（部分落盘提示）', async () => {
    const out = await createFabricSemantics({
      rootDir: wroot,
      execImpl: async () => {
        throw new Error('git: lock file exists')
      },
    }).write({ path: 'memory/exec-fail.md', ...WRITE_ARGS }, ADMIN)
    expect(out.ok).toBe(false)
    expect(out.message).toContain('写入失败')
    expect(out.message).toContain('git: lock file exists')
  })
})

describe('语义核·fabric_tools_list（发现式供给目录，145号 §6）', () => {
  test('admin 会话：目录列三元 + 参数形状 + fabric_call_tool 用法 + memory-save 分流提示', async () => {
    const out = await wsem.toolsList({}, ADMIN)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('fabric-search')
    expect(out.message).toContain('fabric-read')
    expect(out.message).toContain('fabric-write')
    expect(out.message).toContain('fabric_call_tool')
    expect(out.message).toContain('kb-inbox')
    expect(out.message).toContain('memory-save')
  })

  test('目录零参数校验（strict 空对象）', async () => {
    const out = await wsem.toolsList({ rogue: 1 }, ADMIN)
    expect(out.ok).toBe(false)
    expect(out.message).toContain('参数不合法')
  })
})

describe('手写校验原语（zod 等价面）', () => {
  test('search/read 缺省值与范围', () => {
    expect(parseSearchInput({ query: 'x' })).toEqual({ query: 'x', scope: 'all', max: 20 })
    expect(parseReadInput({ path: 'a.md' })).toEqual({ path: 'a.md', maxBytes: 32768 })
    expect(() => parseSearchInput({ query: '' })).toThrow()
    expect(() => parseSearchInput({ query: 'x', max: 51 })).toThrow()
    expect(() => parseSearchInput({ query: 'x', scope: 'everything' })).toThrow()
    expect(() => parseReadInput({ path: 'a.md', maxBytes: 999 })).toThrow()
    expect(() => parseWriteInput({ path: 'a.md', content: 'c' })).toThrow('frontmatter')
    expect(parseWriteInput({ path: 'a.md', content: 'c', frontmatter: { source: 'user-uttered', owner: 'u' } })).toBeTypeOf('object')
  })
})

// ── 插件接线（apply）：注册形态 + 执行径贯通 ─────────────────────────────

describe('apply（接线）', () => {
  test('注册 fabric_tools_list + fabric_call_tool 发现式双元（三元不静态注入，145号 §6）', () => {
    const ctx = makeCtx()
    apply(ctx, {})
    expect([...ctx.registered.keys()]).toEqual(['fabric_tools_list', 'fabric_call_tool'])
    // 审批门不设：写面免审批是 137b §2 治理模型机械执行（可见+可撤销）
    expect(ctx.hooks.has('tools/pre-execute')).toBe(false)
    // export name 稳定（供给链 red line）——由模块断言钉住
  })

  test('fabric_call_tool：白名单内分发到语义核（admin 钉死 config 全链贯通）；未知名本地拒', async () => {
    const ctx = makeCtx()
    apply(ctx, { rootDir: wroot, admin: true })
    const call = ctx.registered.get('fabric_call_tool')
    // 未知工具名：本地白名单先拒（不到语义核）
    const bad = await call.execute({ tool: 'delete-everything' }, { agent: { id: 'session-x' } })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('search|read|write')
    const evil = await call.execute({ tool: '../.git/config', args: {} }, { agent: { id: 'session-x' } })
    expect(evil.ok).toBe(false)
    // 白名单内：语义核真执行（真实写盘 + commit 断言——全链无宿主）
    const out = await call.execute({ tool: 'write', args: { path: 'kb-inbox/via-call-tool.md', content: '经执行面落盘', frontmatter: { source: 'agent-inferred', owner: 'tester' } } }, { agent: { id: 'session-x' } })
    expect(out.ok).toBe(true)
    expect(out.message).toContain('kb-inbox/via-call-tool.md')
    // 语义核校验失败经同一投影面（参数不合法）
    const badArgs = await call.execute({ tool: 'write', args: { path: 'memory/nofm.md', content: 'x' } }, { agent: { id: 'session-x' } })
    expect(badArgs.ok).toBe(false)
    expect(badArgs.message).toContain('参数不合法')
  })

  test('目录与执行面经策略通道取身份（fetchPolicy 注入）：isAdmin=false → 不可用文案', async () => {
    const ctx = makeCtx()
    apply(ctx, { rootDir: wroot, hostBase: 'http://127.0.0.1:9', token: 'tk' })
    // 重打 identity resolver 注入不可行（apply 内部构造）——用真实 fetchPolicy 缺省实现
    // 指向不可达 hostBase 的形态已由 createIdentityResolver 传输失败用例覆盖；此处钉
    // 「非 admin 会话拿到不可用文案而非数据」端到端：normalizeConfig 空 admin → 走通道
    // → 传输失败 → false → 语义核拒。
    const list = ctx.registered.get('fabric_tools_list')
    const out = await list.execute({}, { agent: { id: 'session-y' } })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('非 admin 档')
  })

  test('会话身份缺席 → ok:false 文案拒发（目录与执行面同纪律）', async () => {
    const ctx = makeCtx()
    apply(ctx, { rootDir: wroot, admin: true })
    const noAgent = {}
    const listOut = await ctx.registered.get('fabric_tools_list').execute({}, noAgent)
    expect(listOut.ok).toBe(false)
    expect(listOut.message).toContain('会话身份不可用')
    const callOut = await ctx.registered.get('fabric_call_tool').execute({ tool: 'search', args: { query: 'x' } }, noAgent)
    expect(callOut.ok).toBe(false)
    expect(callOut.message).toContain('会话身份不可用')
  })
})

describe('ESM 纪律（#575 回归：本包 type:module 经 dsh/Node 直载，require 即插件激活失败）', () => {
  test('core.js/index.js 零 require（静态断言——bun 容忍 ESM 内 require 而 Node 不容，唯此可钉）', async () => {
    const { readFile } = await import('node:fs/promises')
    for (const f of ['core.js', 'index.js']) {
      const src = await readFile(join(import.meta.dir, f), 'utf-8')
      expect(src.match(/\brequire\s*\(/)).toBeNull()
    }
  })

  test('零依赖纪律：core.js/index.js 仅 node: 标准库 + 相对导入（禁 bare/zod，226号 red line）', async () => {
    const { readFile } = await import('node:fs/promises')
    for (const f of ['core.js', 'index.js']) {
      const src = await readFile(join(import.meta.dir, f), 'utf-8')
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const spec of imports) {
        // 白名单即红线：host-client（身份面本质通道）/ 本包相对 / node: 标准库——
        // bare import（含 zod）一律不在册
        expect(spec === '../genshu-dsh-host-client/index.js' || spec === './core.js' || spec.startsWith('node:')).toBe(true)
      }
    }
  })
})
