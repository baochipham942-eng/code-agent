# Claude Code 官方能力体系全面梳理

> 基于 Anthropic 官方文档（2026-02 版本），系统梳理 Claude Code CLI 工具的完整产品能力。
> 文档来源：https://code.claude.com/docs/

---

## 目录

1. [产品概览与运行环境](#1-产品概览与运行环境)
2. [Agentic Loop 核心循环](#2-agentic-loop-核心循环)
3. [内置工具集](#3-内置工具集)
4. [子代理系统 (Subagents)](#4-子代理系统-subagents)
5. [多 Agent 团队系统 (Agent Teams)](#5-多-agent-团队系统-agent-teams)
6. [上下文管理](#6-上下文管理)
7. [记忆系统 (Memory)](#7-记忆系统-memory)
8. [权限与安全](#8-权限与安全)
9. [Hooks 系统](#9-hooks-系统)
10. [Skills 技能系统](#10-skills-技能系统)
11. [MCP 集成](#11-mcp-集成)
12. [配置与定制](#12-配置与定制)
13. [CLI 命令与参数](#13-cli-命令与参数)
14. [交互模式](#14-交互模式)
15. [IDE 集成](#15-ide-集成)
16. [GitHub 集成](#16-github-集成)
17. [Agent SDK](#17-agent-sdk)
18. [模型能力与配置](#18-模型能力与配置)
19. [最佳实践](#19-最佳实践)
20. [云部署与企业特性](#20-云部署与企业特性)

---

## 1. 产品概览与运行环境

> 来源：https://code.claude.com/docs/en/overview

Claude Code 是 Anthropic 推出的 AI 编程代理工具，能读取代码库、编辑文件、执行命令、与开发工具集成。

### 1.1 运行环境

| 环境 | 说明 |
|------|------|
| **Terminal CLI** | 全功能命令行工具，直接在终端中操作 |
| **VS Code** | 扩展，支持内联 diff、@-mentions、plan review |
| **JetBrains** | 插件，支持 IntelliJ IDEA、PyCharm、WebStorm 等 |
| **Desktop App** | 独立桌面应用（macOS/Windows），可视化 diff 审查，多会话并行 |
| **Web (claude.ai/code)** | 浏览器版本，无需本地设置，支持长时间任务 |
| **Claude iOS App** | 移动端运行 Claude Code |
| **Chrome Extension** | 浏览器自动化和 Web 测试 |
| **Slack** | `@Claude` 提及触发，bug 报告到 PR 自动化 |

### 1.2 安装方式

- **Native Install** (推荐): `curl -fsSL https://claude.ai/install.sh | bash`（自动更新）
- **Homebrew**: `brew install --cask claude-code`（需手动更新）
- **WinGet**: `winget install Anthropic.ClaudeCode`（Windows）
- **Windows PowerShell**: `irm https://claude.ai/install.ps1 | iex`

### 1.3 核心能力概览

| 能力 | 描述 |
|------|------|
| 自动化繁琐任务 | 写测试、修 lint、解决 merge conflict、更新依赖 |
| 构建功能与修 Bug | 自然语言描述 -> 跨文件实现 |
| Git 操作 | stage、commit、branch、open PR |
| MCP 外部工具集成 | Google Drive、Jira、Slack、数据库 |
| 自定义指令与 Skills | CLAUDE.md、自定义 slash commands、Hooks |
| 多 Agent 协作 | 子代理并行、Agent Teams 协调 |
| CLI 管道与脚本 | `claude -p`、pipe、CI 集成 |
| 跨平台会话 | Web/iOS 启动 -> `/teleport` 拉到终端；`/desktop` 移交桌面应用 |

---

## 2. Agentic Loop 核心循环

> 来源：https://code.claude.com/docs/en/how-claude-code-works

### 2.1 三阶段循环

Claude Code 的 agentic loop 包含三个交织的阶段：

1. **Gather Context（收集上下文）**: 搜索文件、读代码、运行命令获取信息
2. **Take Action（执行操作）**: 编辑文件、运行命令、调用工具
3. **Verify Results（验证结果）**: 运行测试、检查输出、对比截图

这三个阶段不是线性的，而是自适应循环——每步的信息反馈到下一步。一个修 bug 的任务可能经历数十次循环。

### 2.2 循环特性

- **自主决策**: Claude 根据任务自动选择工具、读取文件、链式操作
- **可中断**: 用户随时可以 `Esc` 中断、重定向
- **工具链式调用**: 每次工具返回的信息都会影响下一步决策
- **自动验证**: 可配置测试、lint 作为自验证手段

### 2.3 上下文窗口

- 对话历史、文件内容、命令输出、CLAUDE.md、Skills、系统指令共享同一上下文窗口
- **自动压缩 (Auto-compact)**: 接近上下文限制时自动压缩，先清除旧的工具输出，再总结对话
- 可通过 `CLAUDE_CODE_AUTOCOMPACT_PCT_OVERRIDE` 环境变量调整触发阈值（1-100%）
- `/context` 命令可视化上下文使用情况
- `/compact [instructions]` 手动压缩，可指定关注点

---

## 3. 内置工具集

> 来源：https://code.claude.com/docs/en/how-claude-code-works, https://code.claude.com/docs/en/settings

### 3.1 工具分类

| 类别 | 工具 | 说明 | 需权限 |
|------|------|------|--------|
| **文件操作** | Read | 读取文件内容（支持图片、PDF、Jupyter notebooks） | Yes |
| | Edit | 精确字符串替换编辑 | Yes |
| | Write | 创建/覆盖文件 | Yes |
| **搜索** | Glob | 文件模式匹配（`**/*.ts`） | No |
| | Grep | 正则内容搜索（基于 ripgrep） | No |
| **执行** | Bash | 执行 shell 命令（可后台、可超时） | Yes |
| | TaskOutput | 获取后台任务输出 | No |
| **Web** | WebFetch | 抓取网页内容并 AI 处理 | Yes |
| | WebSearch | 网络搜索 | Yes |
| **代理** | Task | 创建子代理（可指定类型） | Yes |
| **交互** | AskUserQuestion | 向用户提问（多选题式） | No |
| | ExitPlanMode | 退出 Plan Mode 开始编码 | No |
| **笔记本** | NotebookEdit | 编辑 Jupyter notebook cell | Yes |
| **任务管理** | TaskCreate | 创建任务 | - |
| | TaskGet | 获取任务详情 | - |
| | TaskUpdate | 更新任务状态 | - |
| | TaskList | 列出所有任务 | - |
| **团队** | SendMessage | 发送消息给队友 | - |
| **工具发现** | ToolSearch | 搜索/加载 deferred tools | - |
| **MCP** | MCP tools | 通过 MCP 服务器提供的外部工具 | Yes |

### 3.2 工具详细能力

#### Bash
- 支持超时（`BASH_DEFAULT_TIMEOUT_MS`、`BASH_MAX_TIMEOUT_MS`）
- 支持后台运行（`run_in_background`），通过 `TaskOutput` 获取结果
- 输出长度限制（`BASH_MAX_OUTPUT_LENGTH`），中间截断
- Shell 可配置（`CLAUDE_CODE_SHELL`）
- 命令前缀（`CLAUDE_CODE_SHELL_PREFIX`）用于审计日志

#### Read
- 支持图片（PNG、JPG 等多模态）
- 支持 PDF（大文件需指定页码范围，最多 20 页/次）
- 支持 Jupyter notebooks（返回所有 cell 及输出）
- 可指定行偏移和限制

#### WebFetch
- URL + prompt 输入，AI 处理内容
- 自动 HTTP -> HTTPS 升级
- 15 分钟自清理缓存
- 重定向检测

#### WebSearch
- 支持域名过滤（`allowed_domains` / `blocked_domains`）
- 返回搜索结果块，含 markdown 链接

#### Task (子代理)
- 可指定 `subagent_type`: Explore, Plan, general-purpose, 或自定义
- 可指定 model 覆盖
- 支持前台/后台运行

### 3.3 代码智能（插件扩展）

通过安装代码智能插件可获得：
- 编辑后自动查看类型错误和警告
- 跳转到定义
- 查找引用

---

## 4. 子代理系统 (Subagents)

> 来源：https://code.claude.com/docs/en/sub-agents

### 4.1 概念

子代理是专门化的 AI 助手，每个运行在独立上下文窗口中，有自定义系统提示、特定工具访问和独立权限。

### 4.2 内置子代理

| 子代理 | 模型 | 工具 | 用途 |
|--------|------|------|------|
| **Explore** | Haiku（快速） | 只读（无 Write/Edit） | 代码搜索、文件发现、代码库探索 |
| **Plan** | 继承主会话 | 只读 | Plan Mode 下研究收集上下文 |
| **General-purpose** | 继承主会话 | 全部 | 复杂研究、多步操作、代码修改 |
| **Bash** | 继承 | 终端命令 | 独立上下文中运行命令 |
| **statusline-setup** | Sonnet | - | 配置状态行 |
| **Claude Code Guide** | Haiku | - | 回答关于 Claude Code 功能的问题 |

### 4.3 自定义子代理配置

子代理定义为 Markdown 文件（YAML frontmatter + 系统提示），存放位置决定作用域：

| 位置 | 作用域 | 优先级 |
|------|--------|--------|
| `--agents` CLI 参数 | 当前会话 | 1（最高） |
| `.claude/agents/` | 当前项目 | 2 |
| `~/.claude/agents/` | 所有项目 | 3 |
| Plugin `agents/` | 启用插件处 | 4（最低） |

### 4.4 Frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | Yes | 唯一标识符（小写字母+连字符） |
| `description` | Yes | Claude 何时委派给此子代理 |
| `tools` | No | 允许使用的工具列表 |
| `disallowedTools` | No | 禁止使用的工具列表 |
| `model` | No | `sonnet`/`opus`/`haiku`/`inherit` |
| `permissionMode` | No | `default`/`acceptEdits`/`dontAsk`/`bypassPermissions`/`plan` |
| `maxTurns` | No | 最大 agentic 轮次 |
| `skills` | No | 预加载到子代理上下文的 Skills |
| `mcpServers` | No | 可用的 MCP 服务器 |
| `hooks` | No | 子代理生命周期 hooks |
| `memory` | No | 持久记忆作用域：`user`/`project`/`local` |

### 4.5 子代理高级特性

- **前台/后台运行**: 前台阻塞主会话；后台并行工作，`Ctrl+B` 可切换
- **恢复 (Resume)**: 每次调用创建新实例，但可 resume 已有子代理
- **自动压缩**: 子代理也支持自动压缩（同主会话逻辑）
- **持久记忆**: 可配置 `memory` 字段，子代理跨会话积累知识
- **工具限制**: `Task(agent_type)` 语法限制可创建的子代理类型
- **条件规则**: 通过 `PreToolUse` hooks 实现动态工具控制
- **链式子代理**: 主会话中依次调用不同子代理
- **并行研究**: 多个子代理同时探索不同方向

---

## 5. 多 Agent 团队系统 (Agent Teams)

> 来源：https://code.claude.com/docs/en/agent-teams
> **状态: 实验性功能，默认禁用**

### 5.1 概念

Agent Teams 允许协调多个 Claude Code 实例协同工作。一个会话作为 team lead，协调工作、分配任务、综合结果。队友独立工作，各有独立上下文窗口，可直接通信。

### 5.2 与子代理的区别

| 特性 | 子代理 | Agent Teams |
|------|--------|-------------|
| 上下文 | 独立窗口，结果返回调用者 | 独立窗口，完全独立 |
| 通信 | 只能向主 Agent 报告 | 队友之间直接通信 |
| 协调 | 主 Agent 管理所有工作 | 共享任务列表，自协调 |
| 适用场景 | 只需结果的聚焦任务 | 需要讨论和协作的复杂工作 |
| Token 成本 | 较低 | 较高（每个队友是独立实例） |

### 5.3 架构组件

| 组件 | 作用 |
|------|------|
| Team Lead | 主会话，创建团队、分配任务、协调工作 |
| Teammates | 独立 Claude Code 实例 |
| Task List | 共享任务列表 |
| Mailbox | Agent 间消息系统 |

### 5.4 显示模式

- **In-process**: 所有队友在主终端内运行，`Shift+Down` 切换
- **Split panes (tmux/iTerm2)**: 每个队友独立窗格

### 5.5 核心能力

- **自然语言创建团队**: 描述任务和团队结构即可
- **计划审批**: 可要求队友先制定计划，lead 审批后才实施
- **直接对话队友**: 可绕过 lead 直接与队友交互
- **任务自认领**: 队友完成任务后自动认领下一个
- **质量门控 (Hooks)**: `TeammateIdle` 和 `TaskCompleted` hooks 强制质量检查
- **优雅关闭**: lead 发送 shutdown 请求，队友可批准或拒绝

### 5.6 启用方式

```json
// settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### 5.7 最佳用例

- 研究与评审（多角度同时调查）
- 新模块/功能（各自负责不同部分）
- 竞争假设调试（并行测试不同理论）
- 跨层协调（前端/后端/测试各有负责人）

### 5.8 已知限制

- 不支持 in-process 队友的会话恢复
- 任务状态可能滞后
- 关闭可能较慢
- 每个会话只能管一个团队
- 不支持嵌套团队
- Lead 固定不可转让
- 权限在 spawn 时设定

---

## 6. 上下文管理

> 来源：https://code.claude.com/docs/en/how-claude-code-works, https://code.claude.com/docs/en/best-practices

### 6.1 上下文窗口内容

- 对话历史（所有消息）
- 文件内容（Claude 读取的所有文件）
- 命令输出
- CLAUDE.md 文件
- 加载的 Skills 描述
- 系统指令
- MCP 工具定义

### 6.2 上下文管理策略

| 策略 | 说明 |
|------|------|
| **Auto-compact** | 接近限制时自动压缩，先清旧工具输出，再总结对话 |
| **手动 compact** | `/compact [instructions]` 可指定关注点 |
| **部分 compact** | `Esc+Esc` 或 `/rewind` 选择消息点，"Summarize from here" |
| **Clear** | `/clear` 在无关任务间完全重置上下文 |
| **子代理隔离** | 子代理在独立上下文中工作，只返回摘要 |
| **Skills 按需加载** | 只有描述在上下文中，完整内容按需加载 |
| **环境变量控制** | `CLAUDE_CODE_AUTOCOMPACT_PCT_OVERRIDE` 调整触发阈值 |
| **CLAUDE.md 持久化** | 关键指令放 CLAUDE.md 而非依赖对话历史 |

### 6.3 Checkpoint 系统

- 每次文件编辑前自动快照
- `Esc+Esc` 或 `/rewind` 打开回退菜单
- 可恢复对话、代码、或两者
- 可从选定消息点 "Summarize from here"
- Checkpoint 跨会话持久化
- 只追踪 Claude 的变更（不是 git 替代品）

### 6.4 会话管理

- **继续**: `claude --continue` 恢复最近会话
- **恢复**: `claude --resume` 选择历史会话
- **分叉**: `claude --continue --fork-session` 分叉新会话
- **重命名**: `/rename` 给会话命名
- **传送**: `/teleport` 从 Web 拉到本地终端
- **桌面移交**: `/desktop` 移交到桌面应用
- **PR 关联**: `--from-pr` 恢复与特定 PR 关联的会话

---

## 7. 记忆系统 (Memory)

> 来源：https://code.claude.com/docs/en/memory

### 7.1 两种记忆类型

1. **Auto Memory**: Claude 自动保存有用上下文（项目模式、调试洞察、架构笔记、用户偏好）
2. **CLAUDE.md 文件**: 用户手动编写和维护的指令/规则/偏好

### 7.2 记忆层级

| 类型 | 位置 | 用途 | 共享范围 |
|------|------|------|----------|
| **Managed Policy** | 系统级 | 组织级指令（IT/DevOps 管理） | 组织内所有用户 |
| **Project Memory** | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 团队共享的项目指令 | 通过源码控制 |
| **Project Rules** | `./.claude/rules/*.md` | 模块化、主题特定的项目指令 | 通过源码控制 |
| **User Memory** | `~/.claude/CLAUDE.md` | 所有项目的个人偏好 | 仅自己 |
| **Project Local** | `./CLAUDE.local.md` | 个人项目特定偏好（自动 gitignore） | 仅自己 |
| **Auto Memory** | `~/.claude/projects/<project>/memory/` | Claude 的自动笔记和学习 | 仅自己 |

### 7.3 CLAUDE.md 特性

- **Import 语法**: `@path/to/file` 导入其他文件（支持相对/绝对/`~` 路径）
- **递归导入**: 最多 5 层深度
- **递归查找**: 从 cwd 向上递归查找 CLAUDE.md
- **子目录按需加载**: 子目录中的 CLAUDE.md 在 Claude 读取该目录文件时加载
- **路径特定规则**: `.claude/rules/*.md` 支持 `paths` frontmatter 限定适用范围
- **符号链接**: `.claude/rules/` 支持符号链接共享跨项目规则

### 7.4 Auto Memory 机制

- `MEMORY.md` 前 200 行加载到系统提示
- 主题文件（如 `debugging.md`）按需读取
- 通过 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 控制开关
- `/memory` 命令打开记忆文件选择器
- 可直接要求 Claude "记住某事"

### 7.5 用户级规则

`~/.claude/rules/` 目录下的 `.md` 文件对所有项目生效，优先级低于项目规则。

---

## 8. 权限与安全

> 来源：https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/settings

### 8.1 权限模式

| 模式 | 说明 |
|------|------|
| `default` | 标准行为，首次使用工具时提示 |
| `acceptEdits` | 自动接受文件编辑，命令仍需确认 |
| `plan` | Plan Mode，只能分析不能修改 |
| `dontAsk` | 自动拒绝未预批准的工具 |
| `bypassPermissions` | 跳过所有权限检查（需隔离环境） |

### 8.2 权限规则语法

格式：`Tool` 或 `Tool(specifier)`

评估顺序：**deny -> ask -> allow**（第一个匹配的规则生效）

| 规则 | 效果 |
|------|------|
| `Bash` | 匹配所有 Bash 命令 |
| `Bash(npm run *)` | 匹配 `npm run` 开头的命令 |
| `Read(./.env)` | 匹配读取 .env 文件 |
| `Edit(./src/**)` | 匹配编辑 src/ 下文件 |
| `WebFetch(domain:example.com)` | 匹配特定域名 |
| `MCP(github/*)` | 匹配 GitHub MCP 工具 |
| `Task(Explore)` | 匹配 Explore 子代理 |
| `Skill(commit)` | 匹配特定 Skill |

### 8.3 通配符

- `*` 匹配单层路径
- `**` 递归匹配多层
- `?` 匹配单个字符
- `{a,b,c}` 匹配其中之一

### 8.4 沙盒

- OS 级文件系统和网络隔离
- 仅应用于 Bash 命令及其子进程
- 可配置 `allowedDomains`、`allowUnixSockets` 等
- 与权限互补：权限控制工具访问，沙盒限制 Bash 执行环境

### 8.5 Managed Settings（企业级）

- 系统级 `managed-settings.json`
- 不可被用户/项目设置覆盖
- 特有字段：
  - `disableBypassPermissionsMode`: 禁止 bypassPermissions 模式
  - `allowManagedPermissionRulesOnly`: 只允许管理员定义的权限规则
  - `allowManagedHooksOnly`: 只允许管理员定义的 hooks
  - `strictKnownMarketplaces`: 限制插件市场

---

## 9. Hooks 系统

> 来源：https://code.claude.com/docs/en/hooks

### 9.1 概念

Hooks 是在 Claude Code 生命周期特定点自动执行的用户定义 shell 命令或 LLM 提示。与 CLAUDE.md 指令（建议性）不同，Hooks 是确定性的、保证执行的。

### 9.2 Hook 事件类型

| 事件 | 触发时机 | 可阻止 |
|------|----------|--------|
| `SessionStart` | 会话开始或恢复 | No |
| `UserPromptSubmit` | 用户提交提示，Claude 处理前 | Yes |
| `PreToolUse` | 工具调用执行前 | Yes |
| `PermissionRequest` | 权限对话框出现时 | Yes |
| `PostToolUse` | 工具调用成功后 | No（可反馈） |
| `PostToolUseFailure` | 工具调用失败后 | No |
| `Notification` | 发送通知时 | No |
| `SubagentStart` | 子代理启动时 | No |
| `SubagentStop` | 子代理完成时 | Yes |
| `Stop` | Claude 完成响应时 | Yes |
| `TeammateIdle` | 队友即将空闲 | Yes |
| `TaskCompleted` | 任务被标记完成 | Yes |
| `PreCompact` | 上下文压缩前 | No |
| `SessionEnd` | 会话终止时 | No |

### 9.3 Hook 类型

| 类型 | 说明 | 默认超时 |
|------|------|----------|
| `command` | 执行 shell 命令 | 600s |
| `prompt` | LLM 单轮评估 | 30s |
| `agent` | 子代理多轮工具调用验证 | 60s |

### 9.4 Hook 配置位置

| 位置 | 作用域 |
|------|--------|
| `~/.claude/settings.json` | 所有项目 |
| `.claude/settings.json` | 单个项目（可提交版本控制） |
| `.claude/settings.local.json` | 单个项目（gitignored） |
| Managed policy | 组织级 |
| Plugin `hooks/hooks.json` | 插件启用时 |
| Skill/Agent frontmatter | 组件活跃时 |

### 9.5 决策控制

- **Exit code 0**: 成功，解析 stdout JSON
- **Exit code 2**: 阻止操作，stderr 反馈给 Claude
- **其他 exit code**: 非阻塞错误，继续执行
- **JSON 输出**: `continue`、`decision`、`permissionDecision`、`updatedInput`、`additionalContext` 等

### 9.6 高级特性

- **异步 Hooks**: `async: true` 后台运行不阻塞（仅 command 类型）
- **Matcher 模式**: 正则过滤（如 `Edit|Write`、`mcp__memory__.*`）
- **环境变量**: `$CLAUDE_PROJECT_DIR`、`$CLAUDE_ENV_FILE`（SessionStart）
- **MCP 工具 Hook**: 匹配 `mcp__<server>__<tool>` 模式
- **一次性 Hook**: `once: true` 每会话只运行一次

---

## 10. Skills 技能系统

> 来源：https://code.claude.com/docs/en/skills

### 10.1 概念

Skills 扩展 Claude 的知识和能力。创建 `SKILL.md` 文件，Claude 按需加载或通过 `/skill-name` 直接调用。

### 10.2 存储位置

| 位置 | 路径 | 适用 |
|------|------|------|
| Enterprise | managed settings | 组织内所有用户 |
| Personal | `~/.claude/skills/<name>/SKILL.md` | 所有项目 |
| Project | `.claude/skills/<name>/SKILL.md` | 当前项目 |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | 插件启用处 |

### 10.3 Frontmatter 字段

| 字段 | 说明 |
|------|------|
| `name` | 显示名称（也是 slash command 名） |
| `description` | 用途描述（Claude 据此决定何时使用） |
| `argument-hint` | 自动补全时显示的参数提示 |
| `disable-model-invocation` | `true` = 只能用户手动调用 |
| `user-invocable` | `false` = 从 `/` 菜单隐藏 |
| `allowed-tools` | 技能活跃时允许的工具 |
| `model` | 技能活跃时使用的模型 |
| `context` | `fork` = 在子代理中运行 |
| `agent` | `context: fork` 时使用的子代理类型 |
| `hooks` | 技能生命周期内的 hooks |

### 10.4 字符串替换

- `$ARGUMENTS`: 调用时传入的所有参数
- `$ARGUMENTS[N]` / `$N`: 按索引访问参数
- `${CLAUDE_SESSION_ID}`: 当前会话 ID

### 10.5 高级模式

- **动态上下文注入**: `` !`command` `` 语法在发送前执行 shell 命令
- **子代理中运行**: `context: fork` + `agent: Explore` 等
- **支持文件**: 技能目录可包含模板、示例、脚本等
- **可视化输出**: 技能可生成 HTML 文件在浏览器中打开
- **兼容旧 commands**: `.claude/commands/` 仍然有效

### 10.6 上下文加载机制

- 技能描述在会话启动时加载到上下文
- 完整内容仅在调用时加载
- `disable-model-invocation: true` 的技能连描述都不加载
- 字符预算：上下文窗口的 2%，fallback 16000 字符

---

## 11. MCP 集成

> 来源：https://code.claude.com/docs/en/mcp

### 11.1 概念

MCP (Model Context Protocol) 是 AI 工具连接外部数据源的开放标准。通过 MCP 服务器，Claude Code 可访问外部工具、数据库和 API。

### 11.2 传输类型

| 类型 | 命令 | 说明 |
|------|------|------|
| **HTTP** (推荐) | `claude mcp add --transport http <name> <url>` | 远程云服务 |
| **SSE** (已弃用) | `claude mcp add --transport sse <name> <url>` | 服务器发送事件 |
| **stdio** | `claude mcp add --transport stdio <name> -- <cmd>` | 本地进程 |

### 11.3 配置作用域

| 作用域 | 存储 | 说明 |
|--------|------|------|
| Local（默认） | `~/.claude.json` | 当前项目私有 |
| Project | `.mcp.json` | 团队共享（提交版本控制） |
| User | `~/.claude.json` | 跨项目个人使用 |

### 11.4 管理命令

```bash
claude mcp list           # 列出所有服务器
claude mcp get <name>     # 获取详情
claude mcp remove <name>  # 移除服务器
claude mcp add-json       # JSON 配置添加
claude mcp add-from-claude-desktop  # 从 Claude Desktop 导入
claude mcp reset-project-choices    # 重置项目审批选择
/mcp                      # 交互式管理（含 OAuth 认证）
```

### 11.5 高级特性

- **OAuth 2.0 认证**: 支持自动和预配置 OAuth
- **环境变量展开**: `.mcp.json` 中支持 `${VAR}` 和 `${VAR:-default}`
- **动态工具更新**: 支持 MCP `list_changed` 通知
- **Claude Code 作为 MCP 服务器**: `claude mcp serve`
- **MCP Resources**: `@server:protocol://resource/path` 引用
- **MCP Prompts**: `/mcp__server__prompt` 作为命令执行
- **Tool Search**: MCP 工具过多时自动按需加载（上下文 >10% 触发）
- **输出限制**: 默认 25000 tokens，可通过 `MAX_MCP_OUTPUT_TOKENS` 调整
- **插件提供的 MCP**: 插件可捆绑 MCP 服务器
- **claude.ai MCP**: 在 claude.ai 添加的 MCP 自动在 Claude Code 可用

### 11.6 Managed MCP（企业级）

- **Option 1**: `managed-mcp.json` 独占控制
- **Option 2**: `allowedMcpServers` / `deniedMcpServers` 策略控制
- 支持 serverName、serverCommand、serverUrl 三种限制方式

---

## 12. 配置与定制

> 来源：https://code.claude.com/docs/en/settings

### 12.1 配置四层优先级

1. **Managed** (最高): 系统级 `managed-settings.json`
2. **CLI Arguments**: 命令行参数
3. **Local**: `.claude/settings.local.json`
4. **Project**: `.claude/settings.json`
5. **User** (最低): `~/.claude/settings.json`

### 12.2 核心配置项

| 类别 | 配置项 | 说明 |
|------|--------|------|
| 模型 | `model` | 默认模型 |
| | `availableModels` | 可用模型列表 |
| | `alwaysThinkingEnabled` | 始终启用扩展思维 |
| 权限 | `permissions.allow/ask/deny` | 工具权限规则 |
| | `permissions.defaultMode` | 默认权限模式 |
| | `additionalDirectories` | 额外目录访问 |
| 环境 | `env` | 环境变量 |
| UI | `outputStyle` | 输出风格 |
| | `language` | 语言 |
| | `prefersReducedMotion` | 减少动画 |
| | `showTurnDuration` | 显示轮次耗时 |
| 会话 | `cleanupPeriodDays` | 清理周期 |
| | `plansDirectory` | 计划存储目录 |
| Attribution | `attribution.commit/pr` | 提交/PR 归属信息 |
| | `includeCoAuthoredBy` | 包含 Co-Authored-By |
| 团队 | `teammateMode` | `in-process`/`tmux`/`auto` |
| 更新 | `autoUpdatesChannel` | 自动更新通道 |

### 12.3 沙盒配置

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"],
      "allowLocalBinding": false
    }
  }
}
```

### 12.4 关键环境变量

| 类别 | 变量 | 说明 |
|------|------|------|
| **认证** | `ANTHROPIC_API_KEY` | API Key |
| | `ANTHROPIC_MODEL` | 使用的模型 |
| **云提供商** | `CLAUDE_CODE_USE_BEDROCK` | 启用 AWS Bedrock |
| | `CLAUDE_CODE_USE_VERTEX` | 启用 Google Vertex |
| **Bash** | `BASH_DEFAULT_TIMEOUT_MS` | 默认超时 |
| | `BASH_MAX_OUTPUT_LENGTH` | 最大输出长度 |
| **思维** | `MAX_THINKING_TOKENS` | 思维 token 上限 |
| | `CLAUDE_CODE_EFFORT_LEVEL` | 努力等级: low/medium/high |
| **输出** | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 最大输出 tokens (默认 32000, 最大 64000) |
| **上下文** | `CLAUDE_CODE_AUTOCOMPACT_PCT_OVERRIDE` | 压缩触发阈值 |
| **功能** | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 启用 Agent Teams |
| | `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 禁用自动记忆 |
| | `CLAUDE_CODE_ENABLE_TASKS` | 任务跟踪系统 |
| | `ENABLE_TOOL_SEARCH` | 工具搜索模式 |
| **网络** | `HTTP_PROXY`/`HTTPS_PROXY` | 代理设置 |
| **MCP** | `MCP_TIMEOUT` | MCP 启动超时 |
| | `MCP_TOOL_TIMEOUT` | MCP 工具执行超时 |
| | `MAX_MCP_OUTPUT_TOKENS` | MCP 输出上限 |
| **遥测** | `CLAUDE_CODE_ENABLE_TELEMETRY` | OpenTelemetry |
| | `DISABLE_TELEMETRY` | 关闭遥测 |

### 12.5 插件系统

- `enabledPlugins`: 启用的插件
- `extraKnownMarketplaces`: 额外插件市场
- `strictKnownMarketplaces`: 限定允许的市场（管理员专用）
- 插件可捆绑 Skills、Hooks、Agents、MCP 服务器

---

## 13. CLI 命令与参数

> 来源：https://code.claude.com/docs/en/cli-usage

### 13.1 核心命令

| 命令 | 说明 |
|------|------|
| `claude` | 启动交互式 REPL |
| `claude "query"` | 带初始提示启动 |
| `claude -p "query"` | SDK 模式查询后退出 |
| `cat file \| claude -p` | 管道输入 |
| `claude -c` | 继续最近对话 |
| `claude -r "<session>"` | 恢复指定会话 |
| `claude update` | 更新到最新版 |
| `claude mcp` | 配置 MCP 服务器 |

### 13.2 重要 CLI 参数

| 参数 | 说明 |
|------|------|
| `--model` | 指定模型 |
| `--print, -p` | 非交互式模式 |
| `--continue, -c` | 继续最近会话 |
| `--resume, -r` | 恢复特定会话 |
| `--add-dir` | 添加额外工作目录 |
| `--agents` | JSON 定义自定义子代理 |
| `--allowedTools` | 无需许可的工具 |
| `--disallowedTools` | 禁用的工具 |
| `--tools` | 限制可用工具 |
| `--system-prompt` | 替换系统提示 |
| `--append-system-prompt` | 追加系统提示 |
| `--output-format` | 输出格式: text/json/stream-json |
| `--json-schema` | JSON Schema 结构化输出 |
| `--max-turns` | 最大 agentic 轮次 |
| `--max-budget-usd` | 最大美元预算 |
| `--mcp-config` | MCP 配置文件 |
| `--permission-mode` | 权限模式 |
| `--dangerously-skip-permissions` | 跳过所有权限 |
| `--chrome` | 启用 Chrome 集成 |
| `--remote` | 创建 Web 远程会话 |
| `--teleport` | 恢复 Web 会话到本地 |
| `--teammate-mode` | 团队显示模式 |
| `--fork-session` | 分叉会话 |
| `--from-pr` | 恢复 PR 关联的会话 |
| `--fallback-model` | 过载时的备用模型 |
| `--verbose` | 详细日志 |
| `--debug` | 调试模式 |

### 13.3 系统提示参数

| 参数 | 行为 | 模式 |
|------|------|------|
| `--system-prompt` | 替换整个默认提示 | Interactive + Print |
| `--system-prompt-file` | 从文件替换 | Print only |
| `--append-system-prompt` | 追加到默认提示 | Interactive + Print |
| `--append-system-prompt-file` | 从文件追加 | Print only |

---

## 14. 交互模式

> 来源：https://code.claude.com/docs/en/interactive-mode

### 14.1 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` | 取消当前输入/生成 |
| `Ctrl+D` | 退出会话 |
| `Ctrl+G` | 在文本编辑器中编辑提示 |
| `Ctrl+L` | 清屏（保留对话） |
| `Ctrl+O` | 切换详细输出 |
| `Ctrl+R` | 反向搜索命令历史 |
| `Ctrl+V` | 从剪贴板粘贴图片 |
| `Ctrl+B` | 后台运行任务 |
| `Ctrl+T` | 切换任务列表 |
| `Esc+Esc` | 回退/总结 |
| `Shift+Tab` | 切换权限模式 |
| `Alt+P` | 切换模型 |
| `Alt+T` | 切换扩展思维 |

### 14.2 内置命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清除对话 |
| `/compact` | 压缩对话 |
| `/config` | 设置界面 |
| `/context` | 上下文使用可视化 |
| `/cost` | Token 使用统计 |
| `/debug` | 排查会话问题 |
| `/doctor` | 检查安装健康 |
| `/export` | 导出对话 |
| `/init` | 初始化 CLAUDE.md |
| `/mcp` | 管理 MCP 连接 |
| `/memory` | 编辑记忆文件 |
| `/model` | 切换模型（含 effort level） |
| `/permissions` | 管理权限 |
| `/plan` | 进入 Plan Mode |
| `/rename` | 重命名会话 |
| `/resume` | 恢复会话 |
| `/rewind` | 回退对话/代码 |
| `/stats` | 使用统计可视化 |
| `/status` | 显示版本/模型/账户 |
| `/statusline` | 设置状态行 |
| `/copy` | 复制最后响应 |
| `/tasks` | 管理后台任务 |
| `/teleport` | 恢复远程会话 |
| `/desktop` | 移交到桌面应用 |
| `/theme` | 更改颜色主题 |
| `/todos` | 列出 TODO 项 |
| `/usage` | 显示使用限制 |
| `/agents` | 管理子代理 |
| `/hooks` | 管理 Hooks |
| `/vim` | 启用 Vim 模式 |

### 14.3 输入模式

- **多行输入**: `\+Enter`、`Option+Enter`、`Shift+Enter`、`Ctrl+J`
- **Bash 模式**: `!` 前缀直接运行命令
- **文件引用**: `@` 触发文件路径自动补全
- **Vim 模式**: `/vim` 启用完整 vim 操作

### 14.4 提示建议

- 会话开始时显示基于 git 历史的示例命令
- Claude 响应后基于对话历史显示后续建议
- Tab 接受，Enter 接受并提交
- 可通过 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` 禁用

### 14.5 任务列表 (Task List)

- `Ctrl+T` 切换任务列表视图
- 最多显示 10 个任务
- 跨上下文压缩持久化
- `CLAUDE_CODE_TASK_LIST_ID` 跨会话共享

### 14.6 PR Review 状态

- Footer 显示可点击 PR 链接（需 `gh` CLI）
- 颜色编码：绿=approved，黄=pending，红=changes requested，灰=draft，紫=merged
- 每 60 秒自动更新

---

## 15. IDE 集成

> 来源：https://code.claude.com/docs/en/overview

### 15.1 VS Code

- 内联 diff
- @-mentions
- Plan review
- 对话历史
- 安装方式：Extension marketplace 搜索 "Claude Code"

### 15.2 JetBrains

- 交互式 diff 查看
- Selection context sharing
- 支持 IntelliJ IDEA、PyCharm、WebStorm 等
- JetBrains Marketplace 安装

### 15.3 Desktop App

- 独立应用（macOS/Windows）
- 可视化 diff 审查
- 多会话并行
- 支持云会话（Web sessions）
- `/desktop` 从 CLI 移交

---

## 16. GitHub 集成

> 来源：https://code.claude.com/docs/en/github-actions

### 16.1 GitHub Actions

- `@claude` 提及触发 PR/Issue 自动化
- 基于 Agent SDK 构建
- 自动模式检测（交互式 vs 自动化）

### 16.2 核心能力

- 即时 PR 创建
- 自动代码实现（Issue -> 代码）
- 遵循 CLAUDE.md 标准
- 安全默认（代码在 GitHub runner 运行）

### 16.3 配置参数

| 参数 | 说明 |
|------|------|
| `prompt` | 指令文本或 Skill（如 `/review`） |
| `claude_args` | CLI 参数传递 |
| `anthropic_api_key` | API Key |
| `github_token` | GitHub Token |
| `trigger_phrase` | 触发短语（默认 `@claude`） |
| `use_bedrock` | 使用 AWS Bedrock |
| `use_vertex` | 使用 Google Vertex AI |

### 16.4 使用方式

```yaml
# 基本工作流
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

# 带 Skills
- uses: anthropics/claude-code-action@v1
  with:
    prompt: "/review"
    claude_args: "--max-turns 5"
```

### 16.5 快速设置

```bash
# 在 Claude Code 中运行
/install-github-app
```

### 16.6 GitLab CI/CD

- 也支持 GitLab CI/CD 集成

---

## 17. Agent SDK

> 来源：https://code.claude.com/docs/en/overview, https://platform.claude.com/docs/en/agent-sdk/overview

### 17.1 概念

Agent SDK 允许编程式使用 Claude Code 的工具和能力构建自定义 Agent。

### 17.2 核心特性

- `claude -p "query"` headless 模式（非交互式）
- `--output-format json/stream-json` 结构化输出
- `--json-schema` 验证 JSON 输出匹配 Schema
- `--input-format stream-json` 流式 JSON 输入
- `--max-turns` 限制轮次
- `--max-budget-usd` 限制预算
- `--no-session-persistence` 禁用会话持久化

### 17.3 使用场景

- CI/CD 管道集成
- Pre-commit hooks
- 自定义自动化工作流
- 批量操作
- 数据处理管道

---

## 18. 模型能力与配置

> 来源：https://code.claude.com/docs/en/how-claude-code-works, https://code.claude.com/docs/en/settings

### 18.1 可用模型

| 模型 | 说明 |
|------|------|
| **Opus 4.6** (`claude-opus-4-6`) | 最强推理能力，复杂架构决策 |
| **Sonnet 4.6** (`claude-sonnet-4-6`) | 平衡能力和速度，大多数编码任务 |
| **Haiku 4.5** (`claude-haiku-4-5-20251001`) | 快速低延迟，探索和搜索 |

### 18.2 模型覆盖环境变量

```bash
ANTHROPIC_MODEL                    # 全局模型
ANTHROPIC_DEFAULT_HAIKU_MODEL      # Haiku 模型覆盖
ANTHROPIC_DEFAULT_SONNET_MODEL     # Sonnet 模型覆盖
ANTHROPIC_DEFAULT_OPUS_MODEL       # Opus 模型覆盖
```

### 18.3 Extended Thinking

- `Alt+T` 切换扩展思维模式
- `MAX_THINKING_TOKENS` 环境变量控制思维 token 预算
- `CLAUDE_CODE_EFFORT_LEVEL`: low/medium/high 控制努力等级
- `/model` 命令中左/右箭头调整 effort level（Opus 4.6）
- Skills 中包含 "ultrathink" 关键字可启用

### 18.4 Prompt Caching

- 默认启用
- 可通过 `DISABLE_PROMPT_CACHING` 全局禁用
- 可按模型禁用：`DISABLE_PROMPT_CACHING_HAIKU/SONNET/OPUS`

### 18.5 输出控制

- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`: 默认 32000，最大 64000
- `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`: 文件读取 token 上限

### 18.6 Fallback 模型

- `--fallback-model`: 主模型过载时的备用模型（仅 print 模式）

---

## 19. 最佳实践

> 来源：https://code.claude.com/docs/en/best-practices

### 19.1 核心原则

> **最重要的约束：上下文窗口填满快，性能随之下降。**

### 19.2 给 Claude 验证手段

- 提供测试用例、截图、预期输出
- 使用 Chrome 扩展验证 UI 变更
- 验证可以是测试套件、lint、Bash 命令

### 19.3 先探索、再计划、再编码

1. **Explore** (Plan Mode): 读代码、问问题
2. **Plan**: 制定详细实施计划
3. **Implement** (Normal Mode): 编码并验证
4. **Commit**: 提交并创建 PR

### 19.4 提供具体上下文

- 引用具体文件
- 提到约束条件
- 指向现有模式
- 描述症状、位置、"修复"标准

### 19.5 富内容提供

- `@` 引用文件
- 粘贴图片
- 提供 URL
- 管道输入数据
- 让 Claude 自己拉取上下文

### 19.6 CLAUDE.md 最佳实践

| 应包含 | 不应包含 |
|--------|----------|
| Claude 猜不到的 Bash 命令 | Claude 读代码能搞清的事 |
| 非默认的代码风格规则 | 标准语言约定 |
| 测试指令和偏好的测试运行器 | 详细 API 文档（用链接） |
| 仓库礼仪（分支命名、PR 约定） | 经常变化的信息 |
| 架构决策 | 文件逐一描述 |
| 开发环境怪癖 | "写干净代码"等不言自明的事 |

### 19.7 会话管理

- `/clear` 在无关任务间使用
- 纠正 2 次后仍不对？`/clear` + 更好的初始提示
- 用子代理隔离探索，保持主上下文清洁
- 用 checkpoint 大胆尝试，不对就回退

### 19.8 并行与规模化

- **多会话**: Desktop App、Web、Agent Teams
- **Writer/Reviewer 模式**: 一个写代码，另一个审查
- **Fan Out**: 循环调用 `claude -p` 处理文件列表
- **Headless 模式**: `claude -p` 用于 CI、脚本

### 19.9 常见失败模式

| 模式 | 修复 |
|------|------|
| Kitchen Sink 会话 | `/clear` 分隔无关任务 |
| 反复纠正 | 2 次后 `/clear`，用更好的初始提示 |
| 过长的 CLAUDE.md | 无情精简，如果不会导致错误就删 |
| 信任后不验证 | 始终提供验证手段 |
| 无限探索 | 缩小范围或用子代理 |

---

## 20. 云部署与企业特性

> 来源：https://code.claude.com/docs/en/settings

### 20.1 云提供商支持

| 提供商 | 环境变量 |
|--------|----------|
| **AWS Bedrock** | `CLAUDE_CODE_USE_BEDROCK=1` |
| **Google Vertex AI** | `CLAUDE_CODE_USE_VERTEX=1` |
| **Microsoft Foundry (Azure)** | `ANTHROPIC_FOUNDRY_BASE_URL` |
| **Direct API** | `ANTHROPIC_API_KEY` |

### 20.2 企业级特性

| 特性 | 说明 |
|------|------|
| Managed Settings | 系统级不可覆盖的配置 |
| Managed MCP | 集中管理的 MCP 服务器 |
| Managed Policy CLAUDE.md | 组织级指令 |
| 权限锁定 | `allowManagedPermissionRulesOnly` |
| Hooks 锁定 | `allowManagedHooksOnly` |
| 插件市场限制 | `strictKnownMarketplaces` |
| 强制登录 | `forceLoginMethod` + `forceLoginOrgUUID` |
| API Key Helper | `apiKeyHelper` 外部脚本生成 key |
| OTEL 监控 | OpenTelemetry 集成 |
| AWS 凭证管理 | `awsAuthRefresh`、`awsCredentialExport` |
| 客户端证书 | mTLS 支持 |
| 服务端管理设置 | Server-managed settings（无需 MDM） |

### 20.3 认证方式

- Claude.ai 账户（订阅）
- Anthropic Console API Key
- AWS Bedrock OIDC
- Google Vertex AI Workload Identity Federation
- Microsoft Foundry API Key
- 自定义 Auth Token (`ANTHROPIC_AUTH_TOKEN`)

---

## 附录：特性分类总结

### 核心能力

- Agentic Loop（三阶段自适应循环）
- 12+ 内置工具
- 上下文窗口自动管理（压缩、回退、清除）
- Checkpoint 系统（自动快照、回退）
- 多模型支持（Opus/Sonnet/Haiku + Extended Thinking）
- 会话持久化（继续、恢复、分叉、重命名）

### 扩展能力

- Skills（自定义 slash commands + 知识库）
- Hooks（生命周期事件 + 14 种事件类型）
- Subagents（内置 + 自定义子代理）
- Agent Teams（实验性多 Agent 协作）
- MCP 集成（数百种外部工具）
- Plugins（捆绑 Skills + Hooks + Agents + MCP）

### 平台集成

- Terminal CLI
- VS Code / JetBrains / Desktop App / Web / iOS
- Chrome Extension
- GitHub Actions / GitLab CI/CD
- Slack
- Agent SDK（编程式使用）

### 企业特性

- Managed Settings（组织级配置锁定）
- 沙盒隔离
- 权限精细控制
- 多云部署（Bedrock / Vertex / Foundry）
- OpenTelemetry 监控
- mTLS 客户端证书
- Server-managed Settings

---

*文档生成日期: 2026-02-19*
*基于 Claude Code 官方文档 (code.claude.com/docs)*
