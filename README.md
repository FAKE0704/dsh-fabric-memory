# dsh-fabric-memory

**fabric 织物工具的 dsh 插件**（自包含，零宿主依赖）——在 [dsh](https://github.com/deepseek-ai/dsh)（含社区桌面壳 dsh desktop）上访问你的「个人上下文织物」：一个 git 同步的 Obsidian 知识库镜像（`kb/`）+ 跨端记忆原子树（`memory/`）+ agent 修订收件箱（`kb-inbox/`）。

> 本仓是 [Genshu](https://github.com/FAKE0704/Genshu) monorepo 内 `packages/dsh-plugins/genshu-fabric-tools` 的**公共镜像**（monorepo 为真源，镜像脚本推送，内容同源同 commit 溯源）。npm 发布待定（占位：`npm i dsh-fabric-memory`，当前请用 github: 直装）。

## 工具面（发现式供给）

插件向 dsh 注册两个工具，三个真实工具经目录发现、按名分发执行：

| 工具 | 用途 |
|---|---|
| `fabric_tools_list` | 目录：返回三工具的紧凑参数说明（零参数） |
| `fabric_call_tool` | 执行面：`{tool: "search"\|"read"\|"write", args: {...}}` |

- **fabric-search**：子串检索（大小写不敏感），`scope: kb|memory|all`（默认 all），返回 `path:line` 命中行。
- **fabric-read**：读单文件全文（`maxBytes` 默认 32768，超限截断）。
- **fabric-write**：写/修正原子——scope 硬限 `memory/` 与 `kb-inbox/` 下的 `.md`；frontmatter 出身标注必填（`source: user-uttered|agent-inferred` + `owner`，`created` 由工具落）；改既有原子必须走 **supersede 流**（旧文件标 `superseded-by`、新文件落 `supersedes`，绝不静默覆盖）；**每次写一个 git commit**（作者/会话/时间入 message，撤销走 `git revert`）。

## 安装（github: 直装）

在你的 dsh profile（`~/.dsh/profiles/sdk/cordia.patch.yml` 或桌面壳的插件配置）中：

1. 依赖登记（pnpm/npm 形态）：

```json
{
  "dependencies": {
    "genshu-fabric-tools": "github:FAKE0704/dsh-fabric-memory"
  }
}
```

2. profile 插件段：

```yaml
plugins:
  insert:
    - id: genshu-fabric-tools
      name: 'genshu-fabric-tools'
      config:
        fabricRoot: /path/to/your/fabric-checkout
        admin: true
```

> 插件内部名保持 `genshu-fabric-tools`（dsh 工具实名 `fabric_tools_list` / `fabric_call_tool` 亦不变）——npm 包名 `dsh-fabric-memory` 只是发布名，两者不冲突。

## 配置

| config 键 | 说明 |
|---|---|
| `fabricRoot` | 织物 checkout 根目录（含 `kb/`、`memory/`、`kb-inbox/`）。也可用环境变量 `GENSHU_FABRIC_ROOT`（config 优先） |
| `admin` | `true` = 本机单用户直通（桌面形态）；`false` = 显式关闭；缺省 = 生产形态（见下） |
| `hostBase` / `token` / `timeoutMs` | 仅 Genshu server 宿主形态需要（见下），桌面零配置 |

### admin 门（fail-closed）

fabric 是运营者个人上下文，admin 门不可绕过、不可弱化：

- **桌面 / 单机**：`config.admin: true` 直通——你就是运营者本人。
- **Genshu server 宿主**：插件在会话创建窗口向宿主 `/api/internal/dsh/fabric-admin-check` 取走该会话的 admin 判定（users 表 role，宿主单点）；回调失败或未登记 → 一律拒绝。窗口回调失败/未配置 root 时工具返回不可用文案，不暴露任何织物内容。

### fabric root 的准备

```bash
mkdir -p ~/context-fabric/{kb,memory,kb-inbox}
git -C ~/context-fabric init
```

写面要求根是 git 仓（逐写 commit 是可撤销性的前提，非 git 仓拒写）。`kb/` 是你的单向镜像面（如 Obsidian vault 同步目标），插件**拒写** `kb/`——写进去会被下次镜像冲掉；agent 的修订表达请落 `kb-inbox/`，由你策展收编后经正向镜像变权威源。

## 治理语义速览

- **kb/ 拒写**是物理约束（镜像会冲掉）不是权限规则；`kb-inbox/` 是 agent 修订表达面。
- **逐写 commit，只 commit 不 push**：插件从不自动 push——织物仓的多端同步（Mac ↔ 服务器）是你自己的 git 工作流（`git pull` / `git push` 自理）。
- **不静默覆盖**：目标已存在即拒，改写走 supersede 流（历史链在 frontmatter `supersedes` / `superseded-by` 导航）。
- **沉淀新知识请用 memory-save 类通道**；fabric-write 只服务对既有织物的修正与 kb-inbox 修订表达。

## 开发

```bash
bun test   # keyless 单测（fs/git 注入；真实 git init 桩只落 /tmp）
```

零运行时依赖（Node 内置模块直用；入参校验手写）。LICENSE = MIT。
