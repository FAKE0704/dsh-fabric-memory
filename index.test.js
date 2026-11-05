// genshu-fabric-tools keyless 单测（226号 升格后形态）：发现式双元注册 / admin 门
// fail-closed（root 未配置 / 非 admin / 窗口回调失败）/ 生产身份窗口取走（fetchImpl
// 注入不触网）/ 桌面 config.admin 直通 / 执行面白名单与语义委托 / normalizeConfig。
// 语义断言面（scope/supersede/逐写 commit/逃逸/截断）在 core.test.js。
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, fetchFabricAdminCheck, FABRIC_TOOL_OPS, isFabricToolOp, normalizeConfig } from './index.js'

// 会话 shell env 隔离（bun test 每文件独立进程，不跨文件泄漏）：agent 会话 shell 继承
// GENSHU_FABRIC_ROOT / GENSHU_DSH_HOST_BASE（SUBAGENT-NOTES 2026-10-26 同族坑——env
// 穿透一切，测试里 apply() 吃 process.env 缺省会把真织物根/宿主 base 拉进断言面）。
for (const k of ['GENSHU_FABRIC_ROOT', 'GENSHU_DSH_HOST_BASE', 'GENSHU_DSH_HOST_TOKEN', 'GENSHU_DSH_HOST_TIMEOUT_MS']) {
  delete process.env[k]
}

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
  test('search|read|write 放行；畸形/未知/路径注入形态拒', () => {
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

describe('normalizeConfig（本地自管：fabricRoot/admin + 身份取走三键 env 回落）', () => {
  test('undefined config → 全缺省（admin 三态 undefined，hostBase/token 空）', () => {
    const cfg = normalizeConfig(undefined, {})
    expect(cfg).toEqual({ fabricRoot: undefined, admin: undefined, hostBase: '', token: '', timeoutMs: 5000 })
  })

  test('config 显式键优先；env 回落同 host-client 口径；hostBase 非法 URL 抛错', () => {
    expect(normalizeConfig({ fabricRoot: '/f', admin: true, hostBase: 'http://h/', token: 'tk', timeoutMs: 800 }, {}))
      .toEqual({ fabricRoot: '/f', admin: true, hostBase: 'http://h', token: 'tk', timeoutMs: 800 })
    expect(normalizeConfig({}, { GENSHU_DSH_HOST_BASE: 'http://e', GENSHU_DSH_HOST_TOKEN: 'ek' }))
      .toMatchObject({ hostBase: 'http://e', token: 'ek' })
    expect(normalizeConfig({ admin: false }, {})).toMatchObject({ admin: false }) // 显式关
    expect(() => normalizeConfig({ hostBase: 'ftp://x' }, {})).toThrow(/http\(s\)/)
  })
})

describe('fetchFabricAdminCheck（身份取走通道，fetchImpl 注入不触网）', () => {
  const cfg = normalizeConfig({ hostBase: 'http://h', token: 'tk', timeoutMs: 500 }, {})

  test('成功：POST 载荷 {dshSessionId} + token 头 → {isAdmin} 投影', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')), headers: init?.headers })
      return new Response(JSON.stringify({ isAdmin: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const out = await fetchFabricAdminCheck('dsh-1', cfg, { fetchImpl })
    expect(out).toEqual({ isAdmin: true })
    expect(calls[0].url).toBe('http://h/api/internal/dsh/fabric-admin-check')
    expect(calls[0].body).toEqual({ dshSessionId: 'dsh-1' })
    expect(calls[0].headers['x-genshu-local-token']).toBe('tk')
  })

  test('fail-closed：非 2xx / 网络抛错 / 畸形 body / 缺 base·token → null（不设 → 门拒）', async () => {
    expect(await fetchFabricAdminCheck('dsh-1', cfg, { fetchImpl: async () => new Response('no', { status: 500 }) })).toBeNull()
    expect(await fetchFabricAdminCheck('dsh-1', cfg, { fetchImpl: async () => { throw new Error('boom') } })).toBeNull()
    expect(await fetchFabricAdminCheck('dsh-1', cfg, { fetchImpl: async () => new Response('{"x":1}', { status: 200 }) })).toBeNull()
    expect(await fetchFabricAdminCheck('dsh-1', normalizeConfig({}, {}), { fetchImpl: async () => new Response('{}') })).toBeNull()
  })
})

describe('apply（接线与门）', () => {
  test('注册 fabric_tools_list + fabric_call_tool 发现式双元（三元不静态注入，145号 §6）', () => {
    const ctx = makeCtx()
    apply(ctx, {})
    expect([...ctx.registered.keys()]).toEqual(['fabric_tools_list', 'fabric_call_tool'])
    // 审批门不设：写面免审批是 137b §2 治理模型机械执行（可见+可撤销）
    expect(ctx.hooks.has('tools/pre-execute')).toBe(false)
    // 身份窗口钩子在（agent/created 取走 + agent/disposed 清理）
    expect(ctx.hooks.has('agent/created')).toBe(true)
    expect(ctx.hooks.has('agent/disposed')).toBe(true)
  })

  test('root 未配置 → 双元统一不可用文案（fail-closed，不暴露织物内容）', async () => {
    const ctx = makeCtx()
    apply(ctx, {})
    const listOut = await ctx.registered.get('fabric_tools_list').execute({}, { agent: { id: 's1' } })
    expect(listOut.ok).toBe(false)
    expect(listOut.message).toContain('fabric root 未配置')
    expect(listOut.message).toContain('GENSHU_FABRIC_ROOT')
    const callOut = await ctx.registered.get('fabric_call_tool').execute({ tool: 'search', args: { query: 'x' } }, { agent: { id: 's1' } })
    expect(callOut.ok).toBe(false)
    expect(callOut.message).toContain('不可用')
  })

  test('生产形态：窗口取走 isAdmin=true → 放行执行语义核；false / 回调失败 / 未取走 → 拒', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fabric-idx-'))
    try {
      await mkdir(join(root, 'memory'), { recursive: true })
      await writeFile(join(root, 'memory', 'a.md'), '---\nsource: user-uttered\nowner: u\n---\n\n结论先行\n')
      const makeFetch = (isAdmin) => async () => new Response(JSON.stringify({ isAdmin }), { status: 200, headers: { 'content-type': 'application/json' } })
      const cfgIn = { hostBase: 'http://h', token: 'tk', fabricRoot: root }

      // isAdmin=true：窗口取走后 search 真实执行
      const ctxTrue = makeCtx()
      apply(ctxTrue, { ...cfgIn, impls: { fetchImpl: makeFetch(true) } })
      await ctxTrue.hooks.get('agent/created')({ agent: { id: 's-admin' } })
      const out = await ctxTrue.registered.get('fabric_call_tool').execute({ tool: 'search', args: { query: '结论' } }, { agent: { id: 's-admin' } })
      expect(out.ok).toBe(true)
      expect(out.message).toContain('memory/a.md')

      // isAdmin=false：窗口明确拒
      const ctxFalse = makeCtx()
      apply(ctxFalse, { ...cfgIn, impls: { fetchImpl: makeFetch(false) } })
      await ctxFalse.hooks.get('agent/created')({ agent: { id: 's-other' } })
      const denied = await ctxFalse.registered.get('fabric_call_tool').execute({ tool: 'search', args: { query: '结论' } }, { agent: { id: 's-other' } })
      expect(denied.ok).toBe(false)
      expect(denied.message).toContain('非 admin 档')

      // 回调失败（非 2xx）：不设 → 同拒（fail-closed）
      const ctxFail = makeCtx()
      apply(ctxFail, { ...cfgIn, impls: { fetchImpl: async () => new Response('x', { status: 403 }) } })
      await ctxFail.hooks.get('agent/created')({ agent: { id: 's-lost' } })
      const lost = await ctxFail.registered.get('fabric_tools_list').execute({}, { agent: { id: 's-lost' } })
      expect(lost.ok).toBe(false)
      expect(lost.message).toContain('非 admin 档')

      // 未经过窗口（同 root 新实例）：Map 空 → 拒（目录只说真话）
      const ctxNoWindow = makeCtx()
      apply(ctxNoWindow, cfgIn)
      const noWindow = await ctxNoWindow.registered.get('fabric_tools_list').execute({}, { agent: { id: 's-any' } })
      expect(noWindow.ok).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('桌面形态：config.admin=true 直通（零回调、零窗口即可执行）；admin=false 显式关', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fabric-idx-desktop-'))
    try {
      await mkdir(join(root, 'memory'), { recursive: true })
      await writeFile(join(root, 'memory', 'd.md'), '桌面原子\n')
      const ctxDesk = makeCtx()
      let fetched = false
      apply(ctxDesk, { fabricRoot: root, admin: true, impls: { fetchImpl: async () => { fetched = true; return new Response('{"isAdmin":false}') } } })
      // 不触发窗口直接执行——直通
      const out = await ctxDesk.registered.get('fabric_call_tool').execute({ tool: 'read', args: { path: 'memory/d.md' } }, { agent: { id: 's-desk' } })
      expect(out.ok).toBe(true)
      expect(out.message).toContain('# memory/d.md')
      expect(fetched).toBe(false) // admin 已定：身份取走通道零触达
      // 窗口钩子在桌面形态也是零回调（cfg.admin !== undefined 早退）
      await ctxDesk.hooks.get('agent/created')({ agent: { id: 's-desk' } })
      expect(fetched).toBe(false)

      const ctxOff = makeCtx()
      apply(ctxOff, { fabricRoot: root, admin: false })
      const denied = await ctxOff.registered.get('fabric_call_tool').execute({ tool: 'read', args: { path: 'memory/d.md' } }, { agent: { id: 's-desk' } })
      expect(denied.ok).toBe(false)
      expect(denied.message).toContain('非 admin 档')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('执行面：未知工具名本地拒（不走语义层）；目录 strict 零参数；write 委托带会话身份', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fabric-idx-call-'))
    try {
      execFileSync('git', ['-C', root, 'init', '-q'])
      await mkdir(join(root, 'memory'), { recursive: true })
      const ctx = makeCtx()
      apply(ctx, { fabricRoot: root, admin: true })
      const call = ctx.registered.get('fabric_call_tool')
      const bad = await call.execute({ tool: 'delete-everything' }, { agent: { id: 's1' } })
      expect(bad.ok).toBe(false)
      expect(bad.message).toContain('search|read|write')
      const evil = await call.execute({ tool: '../.git/config', args: {} }, { agent: { id: 's1' } })
      expect(evil.ok).toBe(false)
      const rogue = await ctx.registered.get('fabric_tools_list').execute({ rogue: 1 }, { agent: { id: 's1' } })
      expect(rogue.ok).toBe(false)
      expect(rogue.message).toContain('参数不合法')
      // write 委托：参数不合法归一 isError（不外抛）；合法写面走语义核
      const badWrite = await call.execute({ tool: 'write', args: { path: 'memory/x.md', content: 'x' } }, { agent: { id: 's1' } })
      expect(badWrite.ok).toBe(false)
      expect(badWrite.message).toContain('参数不合法')
      const okWrite = await call.execute({ tool: 'write', args: { path: 'memory/n.md', content: '正文', frontmatter: { source: 'user-uttered', owner: 'u' } } }, { agent: { id: 's-owner' } })
      expect(okWrite.ok).toBe(true)
      expect(okWrite.message).toContain('git commit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('agent/disposed 清理窗口判定（同 id 再入 = 重新取走语义——Map 清空后门拒）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fabric-idx-dispose-'))
    try {
      await mkdir(join(root, 'memory'), { recursive: true })
      const cfgIn = { hostBase: 'http://h', token: 'tk', fabricRoot: root, impls: { fetchImpl: async () => new Response('{"isAdmin":true}', { status: 200 }) } }
      const ctx = makeCtx()
      apply(ctx, cfgIn)
      await ctx.hooks.get('agent/created')({ agent: { id: 's-cycle' } })
      const allowed = await ctx.registered.get('fabric_call_tool').execute({ tool: 'search', args: { query: 'x' } }, { agent: { id: 's-cycle' } })
      expect(allowed.ok).toBe(true)
      ctx.hooks.get('agent/disposed')({ agent: { id: 's-cycle' } })
      const after = await ctx.registered.get('fabric_call_tool').execute({ tool: 'search', args: { query: 'x' } }, { agent: { id: 's-cycle' } })
      expect(after.ok).toBe(false)
      expect(after.message).toContain('非 admin 档')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
