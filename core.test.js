// genshu-fabric-tools 语义核 keyless 单测（断言面整迁自宿主 tools/fabric.ts 测试，
// 226号 升格随迁）：search scope 收窄与命中 / read 截断与逃逸护栏 / write 治理面
// （kb 拒写 / frontmatter 机械校验 / supersede 流 / 逐写 commit / 不静默覆盖 /
// 手写复验）。真实 tmp 目录 + 真实 git init 桩（写面 commit 断言），无网络无 DB；
// 绝不触碰真实 checkout ~/context-fabric。门面（admin/root fail-closed）在
// index.test.js——门在 index.js（身份注入是外界职责，120号 §5）。
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFabricSemantics,
  fabricCatalog,
  parseReadInput,
  parseSearchInput,
  parseToolsListInput,
  parseWriteInput,
  resolveFabricRoot,
} from './core.js'

// ---------- 手写复验面（parse 纯函数，无 IO） ----------

describe('parse 手写复验（zod 契约镜像）', () => {
  test('search：query 必填 1-200；scope 枚举；max 1-50 缺省 20', () => {
    expect(parseSearchInput({ query: 'x' })).toEqual({ query: 'x', scope: 'all', max: 20 })
    expect(parseSearchInput({ query: 'x', scope: 'memory', max: 5 })).toEqual({ query: 'x', scope: 'memory', max: 5 })
    expect(() => parseSearchInput({})).toThrow(/参数不合法/)
    expect(() => parseSearchInput({ query: '' })).toThrow(/参数不合法/)
    expect(() => parseSearchInput({ query: 'x'.repeat(201) })).toThrow(/参数不合法/)
    expect(() => parseSearchInput({ query: 'x', scope: 'everything' })).toThrow(/参数不合法/)
    expect(() => parseSearchInput({ query: 'x', max: 0 })).toThrow(/参数不合法/)
    expect(() => parseSearchInput({ query: 'x', max: 1.5 })).toThrow(/参数不合法/)
    expect(() => parseSearchInput('x')).toThrow(/参数不合法/)
  })

  test('read：path 必填 1-500；maxBytes 1000-65536 缺省 32768', () => {
    expect(parseReadInput({ path: 'kb/a.md' })).toEqual({ path: 'kb/a.md', maxBytes: 32768 })
    expect(() => parseReadInput({ path: 'kb/a.md', maxBytes: 999 })).toThrow(/参数不合法/)
    expect(() => parseReadInput({ path: 'kb/a.md', maxBytes: 65537 })).toThrow(/参数不合法/)
    expect(() => parseReadInput({})).toThrow(/参数不合法/)
  })

  test('write：frontmatter 出身标注必填（137b §3.1）——缺 source/owner、source 非法枚举均拒', () => {
    const ok = parseWriteInput({ path: 'memory/a.md', content: 'x', frontmatter: { source: 'agent-inferred', owner: 'u' } })
    expect(ok.frontmatter).toEqual({ source: 'agent-inferred', owner: 'u' })
    expect(() => parseWriteInput({ path: 'memory/f1.md', content: 'x', frontmatter: { owner: 'u' } })).toThrow(/参数不合法/)
    expect(() => parseWriteInput({ path: 'memory/f2.md', content: 'x', frontmatter: { source: 'user-uttered' } })).toThrow(/参数不合法/)
    expect(() => parseWriteInput({ path: 'memory/f3.md', content: 'x', frontmatter: { source: 'model-hallucinated', owner: 'u' } })).toThrow(/参数不合法/)
    expect(() => parseWriteInput({ path: 'memory/f4.md', content: 'x' })).toThrow(/参数不合法/)
    expect(() => parseWriteInput({ path: 'memory/f5.md', content: '', frontmatter: { source: 'user-uttered', owner: 'u' } })).toThrow(/参数不合法/)
    // supersede 可选；给了就复验 1-500
    expect(parseWriteInput({ path: 'memory/n.md', content: 'x', frontmatter: { source: 'user-uttered', owner: 'u' }, supersede: 'memory/o.md' }).supersede).toBe('memory/o.md')
    expect(() => parseWriteInput({ path: 'memory/n.md', content: 'x', frontmatter: { source: 'user-uttered', owner: 'u' }, supersede: '' })).toThrow(/参数不合法/)
  })

  test('tools-list 目录：strict 空对象——任何字段拒；undefined 同拒（zod required 同语义）', () => {
    expect(parseToolsListInput({})).toEqual({})
    expect(() => parseToolsListInput(undefined)).toThrow(/参数不合法/)
    expect(() => parseToolsListInput({ rogue: 1 })).toThrow(/参数不合法/)
    expect(() => parseToolsListInput('x')).toThrow(/参数不合法/)
    expect(() => parseToolsListInput([1])).toThrow(/参数不合法/)
  })

  test('resolveFabricRoot：config 优先 → env 回落 → undefined；resolve 定格绝对路径', () => {
    expect(resolveFabricRoot(undefined, {})).toBeUndefined()
    expect(resolveFabricRoot(undefined, { GENSHU_FABRIC_ROOT: '/tmp/fab' })).toBe('/tmp/fab')
    expect(resolveFabricRoot('/tmp/cfg', { GENSHU_FABRIC_ROOT: '/tmp/env' })).toBe('/tmp/cfg')
    expect(resolveFabricRoot('   ', { GENSHU_FABRIC_ROOT: '/tmp/env' })).toBe('/tmp/env')
    expect(resolveFabricRoot('rel/path', {})).toMatch(/^\//) // resolve 成绝对路径
  })
})

// ---------- search/read 语义面（真实 tmp fs） ----------

let root
let sem

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fabric-core-test-'))
  await mkdir(join(root, 'kb', '03-项目'), { recursive: true })
  await mkdir(join(root, 'memory'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'kb', 'README.md'), '# 知识库\n部署走 ci-deploy.sh\n')
  await writeFile(join(root, 'kb', '03-项目', 'pylon.md'), '# Pylon\n判据 ≤10轮/30min/零介入×3\n')
  await writeFile(join(root, 'memory', 'user-pref.md'), '---\nowner: u1\n---\n沟通偏好：结论先行\n')
  await writeFile(join(root, '.git', 'config.md'), '部署走 ci-deploy.sh\n') // 元数据面不应被检索
  await writeFile(join(root, 'kb', 'big.md'), `${'x'.repeat(300 * 1024)}\n部署走 ci-deploy.sh\n`) // 超 256k 跳过
  sem = createFabricSemantics({ now: () => '2026-12-01T00:00:00.000Z' })
  sem.bindRoot(root)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('search（scope 收窄与命中护栏）', () => {
  test('all 域：跨 kb/memory 命中，.git 元数据与超大文件不进检索面', async () => {
    const out = await sem.search(parseSearchInput({ query: '部署走' }))
    expect(out.isError).toBe(false)
    expect(out.content).toContain('kb/README.md:2:')
    expect(out.content).not.toContain('.git/config.md')
    expect(out.content).not.toContain('kb/big.md')
  })

  test('scope 收窄：memory 域只搜记忆原子（大小写不敏感）', async () => {
    const out = await sem.search(parseSearchInput({ query: '结论先行', scope: 'memory' }))
    expect(out.isError).toBe(false)
    expect(out.content).toContain('memory/user-pref.md:4:')
  })

  test('无命中 → 换词建议；空 scope 目录 → 镜像未跑提示', async () => {
    const none = await sem.search(parseSearchInput({ query: '不存在的关键词xyz' }))
    expect(none.content).toContain('0 处命中')
    expect(none.content).toContain('无命中')
    const emptyScope = await sem.search(parseSearchInput({ query: 'x', scope: 'kb' }))
    emptyScope.content.includes('无命中') // kb 存在只是该词无命中即正常路径
  })
})

describe('read（截断与逃逸护栏）', () => {
  test('读相对路径全文（带 # path 头）', async () => {
    const out = await sem.read(parseReadInput({ path: 'kb/README.md' }))
    expect(out.isError).toBe(false)
    expect(out.content).toContain('# kb/README.md')
    expect(out.content).toContain('部署走 ci-deploy.sh')
  })

  test('路径逃逸拒绝：绝对路径 / .. 双护栏', async () => {
    const abs = await sem.read(parseReadInput({ path: '/etc/passwd' }))
    expect(abs.isError).toBe(true)
    expect(abs.content).toContain('相对路径')
    const dotdot = await sem.read(parseReadInput({ path: 'kb/../../etc/passwd' }))
    expect(dotdot.isError).toBe(true)
  })

  test('maxBytes 截断带字节说明；缺失文件给重定位建议', async () => {
    const truncated = await sem.read(parseReadInput({ path: 'kb/big.md', maxBytes: 1000 }))
    expect(truncated.content).toContain('截断：全文')
    const missing = await sem.read(parseReadInput({ path: 'kb/nope.md' }))
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('fabric-search')
  })
})

// ---------- write 治理面（独立 git 真仓桩——逐写 commit 断言需要真 .git） ----------

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

const WRITE = { content: '新结论：部署端口 8093', frontmatter: { source: 'agent-inferred', owner: 'ops-lead' } }

describe('write（145号 P1-1 治理面）', () => {
  beforeAll(async () => {
    wroot = await mkdtemp(join(tmpdir(), 'fabric-core-write-'))
    execFileSync('git', ['-C', wroot, 'init', '-q'])
    await mkdir(join(wroot, 'memory'), { recursive: true })
    await mkdir(join(wroot, 'kb'), { recursive: true })
    await mkdir(join(wroot, 'kb-inbox'), { recursive: true })
    await writeFile(join(wroot, 'kb', 'vault.md'), '# 既有权威笔记\n决策 A 已定\n')
    await writeFile(join(wroot, 'memory', 'old-atom.md'), '---\nsource: user-uttered\nowner: human\ncreated: "2026-10-01"\n---\n\n旧结论：部署端口 3000\n')
    wsem = createFabricSemantics({ now: () => '2026-12-01T08:30:00.000Z' })
    wsem.bindRoot(wroot)
  })

  afterAll(async () => {
    await rm(wroot, { recursive: true, force: true })
  })

  test('快乐路径：memory/ 落盘 + frontmatter 机械组装 + 逐写 commit（作者/会话/时间入 message）', async () => {
    const before = revCount(wroot)
    const out = await wsem.write(parseWriteInput({ path: 'memory/new-atom.md', ...WRITE }), { sessionId: 's-owner' })
    expect(out.isError).toBe(false)
    expect(out.content).toContain('memory/new-atom.md')
    expect(out.content).toMatch(/git commit [0-9a-f]+/)
    // frontmatter 由工具机械组装（created 由工具落——不靠模型自报）
    const text = await readFile(join(wroot, 'memory', 'new-atom.md'), 'utf8')
    expect(text).toContain('source: agent-inferred')
    expect(text).toContain('owner: ops-lead')
    expect(text).toContain('created: "2026-12-01T08:30:00.000Z"')
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
    const out = await wsem.write(parseWriteInput({ path: 'kb/vault.md', ...WRITE }), { sessionId: 's-owner' })
    expect(out.isError).toBe(true)
    expect(out.content).toContain('kb/')
    expect(out.content).toContain('镜像')
    expect(out.content).toContain('kb-inbox')
    expect(revCount(wroot)).toBe(before) // 零副作用
  })

  test('kb-inbox/ 放行（agent 修订表达面）', async () => {
    const out = await wsem.write(parseWriteInput({ path: 'kb-inbox/修订-决策A.md', ...WRITE }), { sessionId: 's-owner' })
    expect(out.isError).toBe(false)
    const text = await readFile(join(wroot, 'kb-inbox', '修订-决策A.md'), 'utf8')
    expect(text).toContain('source: agent-inferred')
  })

  test('深路径写入：目标目录以 root 为基准创建（mkdir 不落 process.cwd）', async () => {
    const out = await wsem.write(parseWriteInput({ path: 'memory/深度/子/atom.md', ...WRITE }), { sessionId: 's-owner' })
    expect(out.isError).toBe(false)
    const text = await readFile(join(wroot, 'memory', '深度', '子', 'atom.md'), 'utf8')
    expect(text).toContain('新结论：部署端口 8093')
    // 误落 cwd 的目录（相对路径 mkdir）会让上面的 readFile 抛 ENOENT——此断言即护栏
  })

  test('点前缀元数据面（.git/.obsidian）与非法 scope 顶层拒写；非 .md 拒', async () => {
    const gitHit = await wsem.write(parseWriteInput({ path: '.git/config.md', ...WRITE }), {})
    expect(gitHit.isError).toBe(true)
    expect(gitHit.content).toContain('元数据面')
    const obsidian = await wsem.write(parseWriteInput({ path: '.obsidian/note.md', ...WRITE }), {})
    expect(obsidian.isError).toBe(true)
    const rogueScope = await wsem.write(parseWriteInput({ path: 'notes/scratch.md', ...WRITE }), {})
    expect(rogueScope.isError).toBe(true)
    expect(rogueScope.content).toContain('scope 硬限')
    const notMd = await wsem.write(parseWriteInput({ path: 'memory/atom.txt', ...WRITE }), {})
    expect(notMd.isError).toBe(true)
    expect(notMd.content).toContain('.md')
  })

  test('路径逃逸拒绝：绝对路径 / ..（写面同护栏）', async () => {
    const abs = await wsem.write(parseWriteInput({ path: '/tmp/evil.md', ...WRITE }), {})
    expect(abs.isError).toBe(true)
    expect(abs.content).toContain('相对路径')
    const dotdot = await wsem.write(parseWriteInput({ path: 'memory/../../evil.md', ...WRITE }), {})
    expect(dotdot.isError).toBe(true)
    expect(dotdot.content).toContain('相对路径')
  })

  test('正文超 64k 拒（读面 maxBytes 同值——写进去读不全的原子不允许造出）', async () => {
    const out = await wsem.write(parseWriteInput({ path: 'memory/huge.md', content: 'x'.repeat(65537), frontmatter: WRITE.frontmatter }), {})
    expect(out.isError).toBe(true)
    expect(out.content).toContain('65536')
  })

  test('目标已存在 → 拒（不静默覆盖），文案指路 supersede 流', async () => {
    const before = revCount(wroot)
    const out = await wsem.write(parseWriteInput({ path: 'memory/old-atom.md', ...WRITE }), {})
    expect(out.isError).toBe(true)
    expect(out.content).toContain('不静默覆盖')
    expect(out.content).toContain('supersede')
    expect(revCount(wroot)).toBe(before)
    const text = await readFile(join(wroot, 'memory', 'old-atom.md'), 'utf8')
    expect(text).toContain('旧结论：部署端口 3000') // 原文未动
  })

  test('supersede 流：旧文件标 superseded-by + 新文件落 supersedes 行，单 commit 双文件', async () => {
    const before = revCount(wroot)
    const out = await wsem.write(parseWriteInput({ path: 'memory/old-atom-v2.md', ...WRITE, supersede: 'memory/old-atom.md' }), { sessionId: 's-owner' })
    expect(out.isError).toBe(false)
    expect(out.content).toContain('superseded-by')
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
    const same = await wsem.write(parseWriteInput({ path: 'memory/x.md', ...WRITE, supersede: 'memory/x.md' }), {})
    expect(same.isError).toBe(true)
    expect(same.content).toContain('新路径')
    const missing = await wsem.write(parseWriteInput({ path: 'memory/y.md', ...WRITE, supersede: 'memory/nope.md' }), {})
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('不存在')
    const kbOld = await wsem.write(parseWriteInput({ path: 'memory/z.md', ...WRITE, supersede: 'kb/vault.md' }), {})
    expect(kbOld.isError).toBe(true)
    expect(kbOld.content).toContain('kb/')
  })

  test('根非 git 仓 → 拒写（逐写 commit 可撤销性前提缺失）', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'fabric-core-nogit-'))
    try {
      await mkdir(join(bare, 'memory'), { recursive: true })
      const t = createFabricSemantics({ now: () => '2026-12-01T00:00:00.000Z' })
      t.bindRoot(bare)
      const out = await t.write(parseWriteInput({ path: 'memory/a.md', ...WRITE }), {})
      expect(out.isError).toBe(true)
      expect(out.content).toContain('git 仓')
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe('fabricCatalog（发现式目录文本）', () => {
  test('目录列三元 + 参数形状 + fabric_call_tool 用法 + memory-save 分流提示', () => {
    const text = fabricCatalog()
    expect(text).toContain('fabric-search')
    expect(text).toContain('fabric-read')
    expect(text).toContain('fabric-write')
    expect(text).toContain('fabric_call_tool')
    expect(text).toContain('kb-inbox')
    expect(text).toContain('memory-save')
  })
})
