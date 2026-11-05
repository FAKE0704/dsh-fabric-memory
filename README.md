# dsh-fabric-memory

fabric 织物工具的 dsh 自包含插件——把你的**个人上下文织物**（git 同步的知识库镜像 +
记忆原子树 + 修订收件箱）接入 dsh agent 会话：检索（`fabric-search`）、读全文
（`fabric-read`）、写/修正原子（`fabric-write`），经发现式双元
（`fabric_tools_list` 目录 + `fabric_call_tool` 执行面）供给，不占静态工具席位。

真源 = [Genshu monorepo](https://github.com/FAKE0704/Genshu) 的
`packages/dsh-plugins/genshu-fabric-tools`（本仓为镜像，经 `scripts/publish-dsh-fabric-memory.sh`
幂等组装推送）。

## 它解决什么问题

你的长期上下文（Obsidian 知识库、跨端记忆原子）散落在 markdown 仓里。本插件让
agent 会话能够：

- **检索**：跨 kb/memory 全量子串匹配（大小写不敏感），返回 `path:line` 命中行；
  `.git`/`.obsidian` 等元数据与超 256k 大文件不进检索面，单次命中数有上限（防拖垮上下文）；
- **读全文**：按相对路径读单文件，超 `maxBytes` 截断并标注全文字节数；
- **写/修正**：只服务「修正」通道——新事实沉淀请用你的 memory 工具导出，
  本工具只写既有织物的修正与修订表达。

## 安装（github 直装法）

```bash
# dsh 桌面壳插件直装（github: 前缀，与 npm: 同形；npm 发布前的 git 源直装）
dsh install github:FAKE0704/dsh-fabric-memory
```

你的桌面壳若无 `dsh install` 面（以你的桌面壳文档为准），手动等价法：

```bash
git clone https://github.com/FAKE0704/dsh-fabric-memory.git ~/.dsh/plugins/dsh-fabric-memory
```

然后在 dsh 配置（cordis patch，如 `~/.dsh/patches/` 下的挂载补丁）里挂载：

```yaml
- id: genshu-fabric-tools
  name: genshu-fabric-tools
  config:
    rootDir: /path/to/your/context-fabric   # 织物 checkout 根（必须是 git 仓，见下）
    admin: true                              # 单操作者桌面：显式放行本机身份（缺省 fail-closed）
```

> 插件内部 export name 保持 `genshu-fabric-tools`（与 Genshu 生产供给链同形）——
> 工具名 `fabric_tools_list` / `fabric_call_tool` 与内部三元 `search|read|write`
> 在两处部署完全一致，存量 prompt/白名单零迁移。

## fabric root 配置

织物根是一个 **git 仓**（逐写 commit 的可撤销性前提），目录形态：

```
<rootDir>/
├── kb/          # 知识库单向镜像（Obsidian vault 正向镜像落点）——插件拒写（见下）
├── memory/      # 跨端记忆原子（可写）
├── kb-inbox/    # agent 修订收件箱（可写）
└── .git/
```

root 来源两档：插件 `config.rootDir`（桌面直配，上例）＞ 环境变量
`GENSHU_FABRIC_ROOT`（Genshu 服务端生产沿用）。两者皆缺 = 整面不可用（工具返回
不可用文案，不报错崩溃）。

## admin 门（fail-closed）

fabric 是运营者的个人上下文，默认**任何会话都不可用**（fail-closed）：

- 桌面单操作者：`config.admin: true` 显式放行（配置文件是你自己的，与 env 同信任级）；
  `config.admin: false` 显式锁死；
- Genshu 服务端：不设 `config.admin`，身份走会话策略通道——宿主在 run 起点单点判定
  会话属主的 admin 角色，随策略注入（每会话取一次后缓存，工具时零回调）；
- 任何传输失败/身份缺席 = 本次拒绝，绝不 fail-open。

## 写入治理语义

- **scope 硬限**：只有 `memory/` 与 `kb-inbox/` 下的 `.md` 可写；顶层越界、
  点前缀元数据面（`.git`/`.obsidian`）一律拒。
- **kb/ 拒写是物理约束不是权限规则**：kb 是人策展的单向镜像，写进去会被下次镜像
  冲掉（静默丢失）——插件的拒绝报错会指路 `kb-inbox/`：agent 的修订落收件箱，
  人策展收编进 vault 后经正向镜像自动变权威源。
- **frontmatter 出身标注必填**：`source`（`user-uttered` | `agent-inferred`）+
  `owner` 由入参必填，`created` 时间由工具落——模型只交正文与出身字段，不自由拼 YAML。
- **不静默覆盖**：目标已存在即拒；改既有原子走 **supersede 流**——传
  `supersede=<旧原子路径>` 且 `path` 用新路径，旧文件自动标 `superseded-by` 指向新文件，
  新文件 frontmatter 带 `supersedes` 回链。
- **逐写 git commit**：每次写一个 commit（作者/会话/时间入 message），撤销走
  `git revert`；根非 git 仓 = 拒写（可撤销性前提缺失）。
- **只 commit 不 push**：同步到远端属于你自己的 git 工作流（插件绝不自动 push 你的织物）。

## npm（待发布）

```bash
npm install dsh-fabric-memory   # 占位：npm 发布另行拍板，当前请用上方 git 直装
```

`package.json` 已预留 `engines.dsh` 声明（发布时钉具体兼容范围）。License MIT。
