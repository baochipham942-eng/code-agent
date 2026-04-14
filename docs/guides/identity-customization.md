# Identity Customization（人格定制）

Code Agent 的 system prompt 分两层：

1. **核心身份层（可定制）** — 回答"我是谁、我的交互风格、我的偏好"。
2. **工程层（内置，不要动）** — 工具纪律、任务执行指引、记忆系统规则。这些由代码维护，升级时自动更新，不在用户定制范围。

这个分层借鉴了 NousResearch/hermes-agent 的四层记忆架构里的 identity 层 — 稳定的人格靠"可缓存、可叠加的 prompt 基础设施"沉淀，而不是每次会话重复告诉模型"请友善一点"。

## 两个定制文件

| 文件 | 路径 | 作用 | 典型大小 |
|------|------|------|---------|
| `SOUL.md` | `~/.code-agent/SOUL.md` | 跨项目的核心自我（替换内置 IDENTITY 块） | 30-60 行 |
| `PROFILE.md` | `<project>/.code-agent/PROFILE.md` | 当前项目的上下文约束（追加为 `<project_profile>` 块） | 20-50 行 |

**语义区别**：
- SOUL = 我是谁（我的价值观、沟通风格、个人偏好，跨所有项目）
- PROFILE = 这个项目里我该怎么做（技术栈、代码风格、项目特定避坑）

工程层的规则（conciseness / task guidelines / tool discipline / memory system）**始终由内置代码注入**，SOUL.md 只替换核心自我块，PROFILE.md 只追加项目扩展。

## 快速上手

```bash
# 只生成用户级 SOUL.md
code-agent init-soul

# 同时生成项目级 PROFILE.md（当前目录）
code-agent init-soul --project .

# 只生成项目级 PROFILE.md
code-agent init-soul --profile-only --project .

# 覆盖已有文件
code-agent init-soul -f
```

生成后直接编辑对应文件，保存即生效（`soulLoader` 通过 `fs.watch` 热重载，无需重启 Code Agent）。

## 加载优先级

`src/main/prompts/soulLoader.ts` 的组合逻辑：

```
stable prefix =
    [ SOUL.md  (if exists)  OR  built-in IDENTITY ]     ← 用户核心自我
  + CONCISENESS_RULES                                    ← 内置工程层（始终注入）
  + TASK_GUIDELINES
  + TOOL_DISCIPLINE
  + MEMORY_SYSTEM
  + <project_profile>PROFILE.md</project_profile>  (if exists)  ← 项目扩展
```

**为什么 SOUL 只替换 IDENTITY 块而不是整段**：避免用户写一个 20 行的 SOUL.md 就丢失全部工具纪律 / 记忆系统规则。工程层规则是代码品质的底座，不应被人格定制破坏。

**为什么 PROFILE 追加而不是替换**：项目上下文是"叠加"关系，不是"覆盖"关系。同一份 SOUL 在不同项目下，应该能叠加不同的 PROFILE。

## 热重载机制

`soulLoader.watchSoulFiles(workingDirectory)` 监听两个文件的父目录变更，debounce 500ms 后清缓存并重新加载。日志会记录：

```
[SoulLoader] Soul file changed, reloading { path: '...' }
```

下一次调用 `getSoul()` 会读取新内容。

## 不做的事（out of scope）

- **双向用户建模**（类似 Hermes 的 Honcho）：code-agent 是本地单用户应用，用户自己手写 SOUL 足够，没必要引入外部服务。
- **多层 prompt pipeline**：当前 `stable prefix` / `dynamic section` 两层分层已能满足 prefix cache 需求，不再细化。
- **运行时修改 SOUL**：人格变更应该是用户显式行为（编辑文件），不应由 Agent 自动写入。Agent 如果发现用户偏好变了，应通过 `MemoryWrite` 工具写到 `feedback_*.md`，而不是改 SOUL.md。

## 模板字段说明

### SOUL.md 结构

```markdown
# Code Agent — Core Self

## 身份           ← 我是什么角色
## 交互风格       ← 我怎么说话
## 工作偏好       ← 我的工作方式偏好
## 安全规则       ← 必保留的硬边界（拒绝恶意代码、不执行破坏性命令等）
```

**必保留**：安全规则不要删。内置 IDENTITY 已有这些，但 SOUL.md 会替换整个 IDENTITY 块，所以你的 SOUL.md 里也要写。

### PROFILE.md 结构

```markdown
# Project Profile

## 项目定位       ← 项目名、目标、阶段
## 技术约束       ← 语言/框架/包管理器/数据库/部署
## 代码风格偏好   ← 具体到这个项目的约定
## 项目特定工作流 ← test/typecheck/commit 前必跑命令
## 避免的模式     ← 项目特有的避坑清单
```

## 常见问题

**Q: 我写了 SOUL.md 后系统 prompt 膨胀了吗？**
A: SOUL.md 替换的是内置 IDENTITY 块（~20 行），工程层规则总 token 不变。SOUL.md 自己控制在 60 行内即可。

**Q: SOUL.md 和 ~/.code-agent/memory/user_*.md 有什么区别？**
A: SOUL.md 是"我的人格"，每轮对话都会注入到 system prompt；memory 文件是"关于用户的事实/偏好"，由 LLM 按需 `MemoryRead` 调用。人格是常驻的，事实是按需的。

**Q: 项目有 CLAUDE.md，还需要 PROFILE.md 吗？**
A: CLAUDE.md 是用户维护的项目约定文档（通常给 Claude Code / Cursor 等多工具读），PROFILE.md 是专门注入 Code Agent system prompt 的精炼版。两者可以有交集但不同定位 — PROFILE 要求尽量精简（Agent prompt token 成本），CLAUDE.md 可以详细。
