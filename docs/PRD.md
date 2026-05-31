# Agent Neo / Code Agent - 产品需求文档 (PRD)

> 版本: 3.0
> 日期: 2026-05-26
> 作者: Lin Chen

---

## 一、产品定义

### 1.1 一句话描述

**Agent Neo** = 评测驱动的多模型生活 / 工作 AI 助手，保留强编程、本地执行、外部 agent 接力和可验收交付能力。

`Code Agent` 是代码仓库、历史包名和旧文档名；`Agent Neo` 是 2026-05-16 起的产品品牌。

### 1.2 核心差异化

| 维度 | Agent Neo | 竞品（Claude Code / Cursor / Windsurf） |
|------|-----------|----------------------------------------|
| 模型与 agent 选择 | 14+ Provider 智能路由 + Native / Codex CLI / Claude Code 三类 Agent Engine；模型目录已同步 GPT-5.5 / DeepSeek V4 / Kimi K2.6 / 小米 MiMo v2.5 Pro | 多数锁定 1-2 家 Provider 或单一 agent runtime |
| 成本控制 | 自适应路由降本 60%（简单任务→免费模型） | 固定模型，无成本优化 |
| 质量闭环 | 内置 Swiss Cheese 评测框架，132→164/200 可量化 | 无内置评测 |
| 记忆系统 | Light Memory 文件即记忆 + 记忆导入、候选收件箱、注入追踪和设置页管理 | 无跨会话学习 |
| 协作模式 | DAG 多 Agent 并行编排 | 单 Agent |
| 自治目标循环 | `/goal` 三层闸：完成判定权落**代码层**（确定性 verify exec + 软条件 Reviewer + 代码层兜底），不靠模型自报完成 | Ralph/Codex/Claude 的 goal 多为单层判定（字符串匹配或盲判卷） |
| 原生上下文捕获 | Appshots：左右 Command 双击截当前窗口（截图 + AX 文本/OCR）注入多模态上下文（macOS） | 多数需手动截图 / 复制粘贴 |
| 浏览器/桌面执行 | in-app managed browser + Browser Surface + In-App HTML Validation + Computer Surface，带会话、profile、artifact、TargetRef 和安全恢复路径 | 多数停留在单步浏览器或前台桌面点击 |
| 执行隔离 | bypassPermissions 档接 OS 级沙箱（sandbox-exec/bwrap）+ 沙箱不可用 fail-fast | 多数 YOLO 档无内核级 blast-radius 兜底 |
| 管理与部署 | Tauri 桌面 + Web 双模式 + 本地 API Key 配置 + 可选自动更新 + 管理员用户/邀请码页面 | 仅桌面或仅 IDE 插件 |

### 1.3 目标用户

个人开发者 / AI 产品经理（自用工具 + 架构研究 + Portfolio 展示）

---

## 二、产品架构

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────┐
│                   技能层（扩展）                       │
│  PPT 生成 · Excel/DOCX · 研究模式 · 桌面活动追踪      │
├─────────────────────────────────────────────────────┤
│                   智能层（差异化）                     │
│  多模型路由 · 评测框架 · Light Memory · 多Agent编排    │
├─────────────────────────────────────────────────────┤
│                   工程层（核心）                       │
│  Agent Loop · 工具系统 · 上下文管理 · 权限安全         │
└─────────────────────────────────────────────────────┘
```

### 2.2 技术栈

| 层级 | 技术选型 |
|------|---------|
| 桌面框架 | Tauri 2.x（~33MB DMG） |
| 前端 | React 18 + TypeScript + Tailwind + Zustand |
| 构建 | esbuild（main/preload）+ Vite（renderer） |
| 数据库 | SQLite（better-sqlite3）+ Supabase（云同步） |
| AI 模型 | 小米 MiMo v2.5 Pro（默认对话）/ GPT-5.5 / DeepSeek V4 / Kimi K2.6 / Claude / 智谱 等 14+ Provider |
| Provider 层 | Vercel AI SDK 双引擎（`CODE_AGENT_MODEL_ENGINE` 默认 aisdk、可回退 legacy），归一流式/非流式 tool-call |
| 执行隔离 | macOS `sandbox-exec` / Linux `bwrap`（仅 bypassPermissions 档，`SANDBOX.OS_SANDBOX_ENABLED` 门控） |

---

## 三、功能需求

### 3.1 工程层（核心）

#### 3.1.1 对话交互系统

| 功能 | 状态 | 说明 |
|------|------|------|
| Markdown 渲染 | ✅ | 完整的 GFM 支持 |
| 代码块语法高亮 | ✅ | 多语言 |
| 工具调用可视化 | ✅ | 展开/折叠，耗时显示，diff 预览 |
| 流式输出 | ✅ | SSE 实时推送 |
| 消息历史 | ✅ | 分页加载 + 归档 |
| 多模态输入 | ✅ | 图片粘贴/拖放 + PDF/Excel/代码文件附件 |
| 语音输入 | ✅ | ASR 转写 |
| 输入历史 | ✅ | 上下箭头浏览历史命令 |
| Toast 通知 | ✅ | 全局操作反馈（成功/错误/警告/信息） |
| 工具调用自动分组 | ✅ | 3+ 连续同类工具自动合并显示（收集上下文 / 文件操作） |
| 流式分阶段反馈 | ✅ | 5 阶段渐进提示 + 已运行计时器 + Force Stop |
| Cancel 终态 | ✅ | cancel 进入 `agent_cancelled`，不再伪装成普通 complete；长工具支持 run-level abort |
| 消息编辑/重试 | ✅ | 用户消息内联编辑，助手消息重新生成 |
| Artifact 追踪 | ✅ | 自动提取 chart/spreadsheet/mermaid artifacts 并展示 |
| 推理强度控制 | ✅ | 4 级 Effort Selector（Low/Med/High/Max） |
| Code/Plan/Ask 模式 | ✅ | 三种交互模式一键切换 |
| Semantic Tool UI | ✅ | 工具调用通过 `_meta.shortDescription` 或 fallback generator 展示产品语义标题，减少裸工具名/路径噪音 |
| Memory Citation 展示 | ✅ | Memory 引用折叠成 rationale + source chips，避免长引用挤占工具详情 |
| 会话级 Diff 聚合 | ✅ | 当前 session 汇总 `X files changed`，不需要逐条翻 Write/Edit |
| 链接预览 chip | ✅ | raw URL 渲染为 favicon + 域名标签，带文字的 markdown link 保持原样 |
| 新会话首屏入口卡 | ✅ | 新 session 首屏从"示例 prompt 卡"改为四类具体任务入口：写邮件/排日程、做方案/文档/PPT、调研/对比、代码改动 |
| Prompt Rewind | ✅ | 从任意用户提示词回退：隐藏该提示及之后的 active 消息，恢复最近文件 checkpoint，把原提示词和附件回填到输入框 |
| Hook Activity 展示 | ✅ | Turn 卡片在用户提示词下方展示本轮 Hook 执行摘要，包括 allow/block、改写输入、错误数、耗时和触发事件 |
| Run Status Rail | ✅ | Chat 顶部在后台任务、队列或 Agent Team 活跃时显示轻量状态栏，展示 running/queued、活跃 session、swarm chip、进度，并可跳转 session 或打开 TaskPanel/Agent Team |

#### 3.1.2 工具系统

**核心工具（CORE_TOOLS）**:

| 工具 | 功能 |
|------|------|
| Bash | 执行 shell 命令 |
| Read | 读取文件（支持 PDF、图片、Notebook） |
| Write | 创建/覆盖文件 |
| Edit | 精确字符串替换编辑 |
| Glob | 文件模式匹配搜索 |
| Grep | 内容搜索（基于 ripgrep） |
| LS | 列出目录内容 |
| Task | 子 Agent 任务分发 |
| AskUserQuestion | 交互式询问 |
| MemoryWrite | 持久化记忆写入 |
| MemoryRead | 记忆检索 |

**扩展工具**:

| 类别 | 工具 |
|------|------|
| 网络 | WebFetch, WebSearch, ChartGenerate |
| 文档 | PPTGenerate, ExcelGenerate, DOCXGenerate |
| 多 Agent | AgentSpawn, AgentMessage, WorkflowOrchestrate |
| 视觉 | Screenshot, ComputerUse, BrowserTool |
| 版本控制 | GitCommit, GitDiff, GitWorktree |
| 集成 | MCP, Skill, LSP |
| 连接器 | Calendar, Mail, Reminders |
| 桌面 | DesktopActivitySearch, DesktopActivityTimeline |

**2026-05 工具协议原生化与可靠性补强**:

| 能力 | 状态 | 说明 |
|------|------|------|
| Level 1 native tool protocol | ✅ | Web/Search、Excel、Document、MCP、Skill、LSP、Multiagent、Planning、Vision、Network/Media/Docgen/PPT 等工具按 wave 迁到原生模块，旧 wrappers/legacy path 分批移除 |
| WebFetch 强约束 | ✅ | `WebFetch` 必须显式带 URL；搜索/抓取循环提示词收紧，避免模型把 search 和 fetch 混成一步 |
| LSP 自动安装与失败提示 | ✅ | 语言扩展映射从 13 扩到 100+；npm LSP server 可自动安装，失败时工具结果返回 `installCmd` 修复提示 |
| Edit 最近锚点提示 | ✅ | `old_text` 不匹配时返回最近 anchor lines，减少盲改和重复读文件 |
| native module 回归边界 | ✅ | 迁移 SOP 记录 wave1-4 lessons；每类工具迁移要求 schema、registry、legacy drop、定向测试四件套 |
| 工具搜索失败语义 | ✅ | 没有 callable tool 命中时返回明确 failure，避免模型误以为已加载能力 |

#### 3.1.3 上下文管理

三层递进压缩：

| 层级 | 触发条件 | 策略 | 效果 |
|------|---------|------|------|
| L1 Observation Masking | ≥60% 上下文占用 | 替换旧工具结果为占位符 | 保留逻辑骨架 |
| L2 Truncate | ≥85% | 截断中间段，保留代码块 | 保留首尾 |
| L3 AI Summary | ≥80% | 生成语义摘要 | 最大压缩 |

#### 3.1.4 Agent Runtime Capability Hardening（2026-04-27）

这一组不新增入口，目标是把 agent 主链路的可靠性补到可验收状态。产品口径是：代码和定向测试闭环已完成，真实 app smoke 仍按风险项继续补。

| 能力 | 状态 | 说明 |
|------|------|------|
| Run lifecycle 终态 | ✅ | `completed / failed / cancelled / interrupted` 统一进入 finalizer；cancel 发 `agent_cancelled` |
| Run-level abort | ✅ | cancel signal 贯穿 ToolExecutionEngine、ToolExecutor、ToolResolver、Bash/http 等长工具 |
| Chat run owner | ✅ | desktop chat send/interrupt 走 TaskManager-owned path，减少 session/task 状态漂移 |
| MCP dynamic tool direct execute | ✅ | `mcp__server__tool` 可从 ToolSearch loaded tool 直接执行到 `MCPClient.callTool` |
| ToolSearch loadable 语义 | ✅ | 搜索命中但不可调用的项返回 `loadable:false` 与 `notCallableReason` |
| Skill allowed-tools trust gate | ✅ | project/user skill 不再靠 frontmatter 自动扩权；builtin/plugin skill 才可自动 preapproval |
| Multiagent reliability | ✅ | parallel inbox、dependsOn success gate、failed/blocked/cancelled aggregation、run-level cancel |
| Runtime state recovery | ✅ | todos、session tasks、context interventions、compression state、persistent system context 落 SQLite |
| Eval completeness gate | ✅ | `real-agent-run` 需要 `sessionId + replayKey + telemetryCompleteness`，缺结构化 replay 证据会 fail/degraded |

#### 3.1.5 Chat-Native Workbench（主链路交互结构）

把 `workspace / skills / MCP / connectors / routing / browser` 从分散的侧面板收到聊天主链路里。用户不需要先去几个不同的入口设置好，再回来发消息。

| 能力 | 说明 |
|------|------|
| `ConversationEnvelope` 消息外壳 | 发送 payload 携带 workspace / routing / capability / browser 上下文；旧 payload 由 `normalizeEnvelope()` 兼容，不回归 |
| `InlineWorkbenchBar` | 输入框上方的能力栏：workspace chip、routing chip（Auto/Direct/Parallel）、skills/connectors/MCP 选择 |
| 内联启动卡片 | swarm launch approval 以 `LaunchRequestCard` 方式出现在聊天 turn 内，同一组件与 TaskPanel 复用 |
| Direct Routing（@agent） | `@agent` mention → 主进程持久化 → fanout；持久化失败 renderer 回滚 optimistic 消息 |
| Turn 级执行解释 | 每个 turn 内投影 `workbench_snapshot` / `capability_scope` / `blocked_capabilities` / `routing_evidence` / `hook_activity` / `artifact_ownership` |
| Hook Activity Timeline | Hook trigger history 汇入 turn timeline，聊天卡片稳定展示本轮自动化/权限拦截的真实执行情况 |
| Session-Native Workspace | Sidebar `Resume / Reopen Workspace / Export`；历史 session 的 workbench 选择可回灌当前 composer |
| Unified Trace Identity | Replay / Review Queue / Eval Center / session list 共享同一 `session:<sessionId>` trace identity |
| Prompt Rewind | 回退到历史用户提示词时，active transcript 保持干净，rewound 消息保留审计记录，文件按 checkpoint 恢复 |
| 显式 Browser / Desktop 入口 | `browserSessionMode` 区分 `managed / desktop`；blocked 时展示 reason 与 hint |

**核心定位**：Workbench 不改 orchestration 引擎，只改它的产品暴露方式。`TaskPanel` 已收敛为 task-first 状态工作面：过滤工具性步骤，只露出用户能理解的当前动作、检查项、产物、approval、上下文、MCP、memory 和待审项；SwarmMonitor 的信息通过 Task rail 与顶部 Run Status Rail 进入日常视图。

详细架构见 [docs/architecture/workbench.md](./architecture/workbench.md)，决策背景见 [ADR-011](./decisions/011-chat-native-workbench.md)。

当前产品边界：
- Native connector lifecycle 已有启用、检查、修复权限、断开、移除和设置页入口；非 native connector 与完整统一管理面仍是 backlog
- 命名 `preset` 已有本地资产库，`recipe` 已有 contract/store 能力层；管理 UI、多步执行编排、搜索、分享、版本化仍未产品化
- Failure-to-Capability 已有 `skill / dataset / prompt-policy / capability-health` metadata 与本地 `failureAsset` draft；triage、批处理、apply/export 仍是 backlog

#### 3.1.6 Prompt / Hook / Rewind 管理面（v0.16.74，2026-05-11）

这组能力把"运行前怎么塑形"和"运行后怎么退回"补到产品入口，不把入口留在代码和配置文件里。

| 能力 | 状态 | 说明 |
|------|------|------|
| Prompt Registry + 实时 override | ✅ | 50+ prompt 模块接入 `applyOverride()`；`SYSTEM_PROMPT` 和组合 prompt 通过 `dynamic()` 在下一轮构建时读取最新 override |
| Prompt Manager UI | ✅ | Sidebar User Menu 进入"提示词"管理器，按 category 浏览默认文本和当前生效文本，可保存、复制、恢复默认 |
| Prompt override 持久化 | ✅ | 保存到 `~/.code-agent/prompts-overrides/<id>.md`，不要求重启 webServer；下一轮对话立即生效 |
| Hooks Settings tab | ✅ | 设置 → 能力与连接 → Hook 展示已启用/未启用事件、matcher、hook type、来源、并行标记，并提供打开/定位配置文件 |
| Hook 配置入口 | ✅ | 首选 `~/.code-agent/hooks/hooks.json` 与项目级 `.code-agent/hooks/hooks.json`，兼容旧 `.claude/settings.json` |
| CLI hooks 默认启用 | ✅ | CLI `buildCLIConfig()` 显式打开 `enableHooks`，Hook 不再只跟 planning mode 绑定 |
| Chat workspace defaults | ✅ | 新建会话/新 tab 默认 `workingDirectory:null`，进入 Chats bucket；TitleBar 选择目录后通过 `session:update` 写回当前 session |
| Prompt Rewind | ✅ | `domain:session/rewindToPrompt` 校验 session 非 running，恢复 checkpoint，隐藏 active 消息尾段，写入 `session_rewinds` 审计记录 |

#### 3.1.7 Workbench 信息架构（v0.16.60-65+）

Task / Skills / Preview / Files 从三个独立面板合并为统一右侧工作面板，用 `WorkbenchTabs` 顶栏切换，避免多面板同时展开抢宽度。

| 能力 | 状态 | 说明 |
|------|------|------|
| 统一 tab 模型 | ✅ | `appStore.openWorkbenchTab(id)` 单一 action，弃用 legacy `show*Panel`；Task/Skills/Files 单例 tab，Preview 支持多 tab |
| WorkbenchTabs 顶栏 | ✅ | 面板头部 tab bar，显示当前 tab + 关闭按钮，X 关闭后自动切到幸存 tab |
| Preview 多 tab + LRU | ✅ | 最多同时保留 8 个 Preview tab（`MAX_PREVIEW_TABS`），超出自动 LRU 淘汰 |
| Preview 代码编辑器 | ✅ | ts/tsx/js/jsx/json/yaml/yml 用 CodeMirror 6 呈现 |
| Preview Markdown 编辑 | ✅ | md/csv/tsv/txt 可切到编辑模式（CodeMirror 6 + 语法高亮） |
| Preview CSV/TSV | ✅ | 表格视图，支持列宽自适应 |
| Preview 图片 / PDF | ✅ | base64 data URL 内嵌渲染，无需外部文件服务 |
| Preview 面板整合 | ✅ | Task/Skills/Preview header 去掉重复标题和关闭按钮，由顶栏统一管理 |
| WorkbenchTabs `+` | ✅ | 关闭 Task/Skills/Files 后可在右侧 tab bar 就地重开，不回 TitleBar 找入口 |
| ChatInput `+` 菜单 | ✅ | 附件、slash command、Code/Plan/Ask 等低频或模式动作收进一个二级菜单 |
| 模型 + effort 胶囊 | ✅ | 模型名与 reasoning effort 合并为单一配置入口 |
| Settings “对话”tab | ✅ | Routing 与 Browser 从 ChatInput 移到设置页，作为低频全局对话偏好 |
| Settings 分组导航 | ✅ | 设置页按基础偏好、能力与连接、记忆与隐私、系统分组；搜索结果使用统一 tab registry 跳转 |
| Settings 页面骨架 | ✅ | `SettingsLayout` 提供 page / section / details primitives，MCP 诊断与本地桥状态收进折叠详情 |
| Sidebar User Menu | ✅ | Eval / Lab / Automation / Agent Flow / Desktop 等全局工具从 TitleBar 移到左下用户菜单 |

**死代码清理与入口收敛**：CloudTaskToggle / TaskListToggle / DAGToggle / ObservabilityToggle 及其 orphan state 全部移除。TitleBar 只保留核心工作区入口和最小 Task 入口，全局工具不再挤在顶栏右侧。

#### 3.1.8 文件资源管理器（v0.16.60-65）

| 能力 | 状态 | 说明 |
|------|------|------|
| 同步 session 工作目录 | ✅ | 切换 session 时 Explorer 自动跟随 `workingDirectory`，不需要手动 reload |
| 内联新建 | ✅ | 文件树内直接新建 File / Folder，不弹独立对话框 |
| `openOrFocusTab` action | ✅ | 点击文件名调用统一 store action 打开或聚焦已有 Preview tab |
| TitleBar 入口 | ✅ | 顶栏 File Explorer toggle 按钮 |
| 原生文件选择器 | ✅ | `workspace:selectDirectory` 经 `@tauri-apps/plugin-dialog` 调起系统原生选择器，Web 模式 domain API fallback |
| 原生 reveal / open | ✅ | Write tool row 文件名可点击 + Preview `Reveal` 按钮，经 `@tauri-apps/plugin-opener` 调起 Finder |

#### 3.1.9 Sidebar（v0.16.64）

| 能力 | 状态 | 说明 |
|------|------|------|
| Codex-style workspace grouping | ✅ | Session 按 workingDirectory 分组，每组一个可折叠 header |
| 折叠状态持久化 | ✅ | 折叠偏好写入 `appStore`，跨会话保持 |

#### 3.1.10 权限安全

| 功能 | 说明 |
|------|------|
| 三级权限模式 | 安全模式（全确认）/ 自动编辑 / YOLO 模式 |
| 敏感命令拦截 | rm -rf, git push --force 等二次确认 |
| 工作目录隔离 | Agent 只能操作指定工作目录 |
| API Key 安全 | 本地存储，不打包进 DMG |
| 全局权限模式 | Default / Full Access 一键切换，确认浮窗 |
| 决策审计 | DecisionHistory 缓冲区（50 条），8 种决策类型，/permissions 可观测 |
| Generative UI 安全 | postMessage 来源校验 + CSP + prompt injection XML 隔离 |

#### 3.1.11 Live Preview + visual_edit（视觉定位编辑，v0.16.65+ / 2026-04-24~26）

把"看见什么改什么"做成闭环 —— 用户在 iframe 里点元素，Agent 直接拿到源码位置去改，省掉"描述元素位置 / 给截图给坐标"的交互成本。

| 能力 | 状态 | 说明 |
|------|------|------|
| Live Preview 入口 | ✅ | 从 ChatInput AbilityMenu 迁出，进入 SessionActionsMenu / DevServerLauncher；入口跟当前 session 和 working directory 绑定 |
| DevServerLauncher | ✅ | 可探测 Vite/CRA 等本地项目，启动 dev server、等待 ready、查看 logs；关闭 live tab 后自动 stop |
| iframe 点击 → 源码定位 | ✅ | iframe 内点任意元素，bridge 通过 `data-code-agent-source="file:line:col"`（vite 插件编译期注入）回传 `SelectedElementInfo` |
| 蓝框视觉反馈 | ✅ | 选中元素在 iframe 内加 2px 蓝色 outline，面板底部同时显示 `<tag> file:line:col` |
| selectedElement 自动进入 envelope | ✅ | `composerStore.buildContext()` 读活动 liveDev tab 的 selection，塞入 `ConversationEnvelopeContext.livePreviewSelection` 随消息走，下游 visual_edit / system prompt 消费 |
| HMR 回流恢复 selection | ✅ | iframe reload（手动 Refresh / vite full reload）后 bridge 重新挂载，parent 自动发 `vg:restore-selection` 让 bridge 按 file:line 反查 DOM 重新高亮 —— 改代码 → 看效果 → 再微调循环不被打断 |
| Stale 自动清理 | ✅ | bridge 按 source location 找不到元素时发 `vg:selection-stale`，前端清 appStore selection，UI 回未选中态 |
| Bridge protocol 0.3.0 | ✅ | `SelectedElementInfo` 多回传 `className` 与 `computedStyle`，供样式面板读取当前值 |
| TweakPanel | ✅ | 支持 spacing / color / fontSize / radius / align 5 类 Tailwind 原子操作，走 `applyTweak` IPC 和 `tweakWriter`，不必每次调 LLM |
| visual_edit 工具（Mode A） | ✅ | GLM-4.7 读 selection 上下文 → 输出严格 JSON `{old_text, new_text, summary}` → `old_text` 唯一命中 → atomicWrite 原子替换（0ki 订阅下无 vision 走纯文本推理） |
| 协议 SemVer 管理 | ✅ | `vite-plugin-code-agent-bridge` 协议独立仓库（v0.3.0），与 `src/shared/livePreview/protocol.ts` 同步 |
| 安全边界 | ✅ | iframe postMessage 强制 source+origin 校验；`validateDevServerUrl` IPC URL 白名单 + path-escape 防护；`resolveSourceLocation` IPC 规范化 file 路径，拒绝 workingDirectory 外 |

**典型工作流**：
1. 用户开 dev server（任意 vite 项目，`npm install vite-plugin-code-agent-bridge`）
2. 在会话动作或 DevServerLauncher 打开 Live Preview → 右侧出 iframe
3. 点击 iframe 中想改的按钮 / 卡片 / 文本 → 蓝框 + 底部 source location
4. 在 Chat 发消息"把这个按钮改成圆角"→ envelope 自动带 selectedElement → visual_edit 工具用 source location 做 grounding 去 Edit
5. 简单样式可直接用 TweakPanel 改 Tailwind class；复杂修改仍走 Agent / visual_edit
6. 保存触发 vite HMR → iframe 重载 → 蓝框自动回到原元素 → 用户直接再发下一轮指令

**当前边界**：
- V2 当前口径是 Vite-only MVP；Next.js App Router 支持按 ADR-012 延期，不计入 V2 完成定义
- 只覆盖 full reload 场景（手动 Refresh / vite 判断 full reload）；partial HMR 下 DOM 原地替换的 case 暂不自动恢复（需 DOM MutationObserver）
- visual_edit 只支持"精确唯一命中"模式，大段重构 / 跨文件改造仍走 Agent 主链路
- bridge 插件需 Vite + 可注入源码定位的前端项目；非 JSX / 非 Vite 框架不写成当前已支持

#### 3.1.12 Browser / Computer Workbench 生产化（2026-04-26）

Browser/Computer 已从底层工具上移到 workbench 的显式执行面。主路径优先 in-app managed browser；desktop/computer surface 负责当前桌面上下文、后台 AX/CGEvent 受控动作，以及前台 fallback 边界说明。

| 能力 | 状态 | 说明 |
|------|------|------|
| System Chrome + CDP 验收 | ✅ | acceptance 默认走系统 Chrome headless + CDP，不依赖 Playwright bundled Chromium |
| BrowserSession/Profile | ✅ | managed session 带 `sessionId / profileId / profileMode / workspaceScope / artifactDir`；persistent 兼容旧 profile，isolated profile 关闭后安全清理 |
| AccountState | ✅ | 支持 storageState import/export、cookie/localStorage/sessionStorage summary 与 expired cookie 分类 |
| TargetRef / Snapshot | ✅ | DOM/a11y snapshot 带 `snapshotId`，interactive element 带 `targetRef`；stale targetRef 返回 recoverable metadata |
| Download / Upload Artifact | ✅ | local fixture download/upload 产物进入 managed browser artifact 区，只暴露 name/hash/mime/size/session 摘要 |
| Lease / Proxy / External Bridge boundary | ✅ | managed browser 有 lease/TTL、proxy schema；external bridge 默认 `unsupported` 且需要显式授权后才可能扩展 |
| Browser Task Benchmark | ✅ | 本地 fixture 覆盖 navigation、form、extract、login-like、download/upload、failure recovery、redaction export、recipe rerun |
| Computer Surface background AX | ✅ | 可对临时 native target 用 `targetApp + axPath` 后台 type/click，真实操作限定在受控目标 |
| Computer Surface background CGEvent | ✅ | 可对指定 `pid + windowId + windowLocalPoint` 的临时目标窗口发后台 click |
| Computer Surface `locate_role` 后台路径 | ✅ | `locate_role + targetApp` 走 macOS background AX 直连指定 app 控件树，避免唤起前台；`type` / `key` 没有 background target 时降级前台键盘事件，bridge 显式 warn 提醒 |
| Per-agent BrowserService pool | ✅ | 子 agent 调 Browser/BrowserAction/BrowserNavigate/Screenshot 时带 `agentId` 路由到独立 BrowserService；cookie/localStorage/sessionStorage 经真实 Chromium smoke 验证隔离 |
| Ephemeral browser FIFO semaphore | ✅ | 临时 Chromium 启动有全局并发上限和 FIFO 排队，避免多 agent 同时拉起浏览器把本机打满 |
| ComputerSurface 写操作互斥 | ✅ | click/type/key/clipboard 等写动作经 mutex 串行化；launch/observe 类动作保持豁免，减少多 agent 抢前台/抢输入 |
| 新增桌面动作原语 | ✅ | `mouse_down/up`、`open_application`、`write_clipboard`、`computer_batch`、`hold_key`、`triple_click`、`cursor_position` 已进入 computer-use 能力面 |
| Multi-agent targetApp 截图裁剪 | ✅ | Agent Team 模式下可对目标 app 做截图裁剪和 escalated warning，避免把无关桌面内容混入子 agent 视觉上下文 |
| Computer/computer_use 别名清单 | ✅ | 文档化两套别名映射、动作覆盖矩阵和截图可见性规则，避免下游对 surface 行为产生歧义 |
| Privacy / Recovery UI | ✅ | typed text、cookie、screenshot base64、local path 在 trace/replay/export/UI 中脱敏；失败卡只暴露安全恢复动作 |

当前边界：
- 不做远程浏览器池、外部 Chrome profile、外部 CDP attach、extension bridge
- 不自动处理 CAPTCHA / 反 bot；遇到这类场景分流到人工接管或 unsupported
- Computer foreground fallback 明确表示当前前台 app/window 动作，需要人工确认

#### 3.1.13 Activity Providers / Screen Memory（2026-04-26）

OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis 已被统一到 provider-neutral activity context 模型里。它们可以一起生成 prompt-ready context，但 source、privacy、evidenceRefs 和 token budget 必须保留。

| 能力 | 状态 | 说明 |
|------|------|------|
| ActivityProvider contract | ✅ | `bundled / sidecar / daemon` 三类 provider，描述 lifecycle、capture source、privacy boundary |
| ActivityContextProvider | ✅ | 汇总 OpenChronicle、Tauri native events、audio segments、screenshot analysis，输出统一 `ActivityContext` |
| Prompt formatter | ✅ | 默认保留 legacy separate blocks，也支持 unified activity context block |
| OpenChronicle daemon | ✅ | 外部 daemon supervisor + MCP health + settings UI + blacklist app/url/secure fields filter |
| Tauri Native Desktop | ✅ | bundled provider，继续由 Tauri/Rust collector 管采集，Node 侧读 timeline / current context / recent events |
| Renderer preview | ✅ | 设置页能看到 activity context sources、摘要和不可用原因 |

安全边界：activity context 可以帮助理解当前工作现场，但不等于授权工具行动。屏幕、URL、标题、截图、音频和衍生摘要必须在 UI 与 prompt metadata 中保持来源可追踪。

#### 3.1.14 Design Brief 生产化工作流（v0.16.70-71，2026-04-29）

把"设计意图"从对话独白搬到产品里的一个可被检视、可被打分、可被回写的 artifact。Phase A→C.3 在主链路里串成完整生产路径：用户回答结构化问题 → 生成 brief → 多维 critique 评分 → 自反思预发 gate。

| 阶段 | 能力 | 状态 | 说明 |
|------|------|------|------|
| Phase A | Question-Form artifact + brief 生产路径 | ✅ | `src/artifacts/question-form.ts` + `QuestionFormPreview` 把意图采集做成可投影 artifact，brief 编排把回答聚合进 `designBrief` envelope 元数据 |
| Phase B | Direction Tokens + DESIGN.md loader | ✅ | `src/design/direction-tokens.ts` 提供方向化 design tokens；DESIGN.md loader 把仓库内既有设计规范注入 system context，避免每轮 LLM 重复猜测项目调性 |
| Phase C | 5-dimension critique judge | ✅ | brief 出来后跑 5 维 critique（视觉一致性、信息层级、品牌契合、可达性、生产可行性），结构化输出，可独立显示给用户 |
| Phase C.2 | Critique batch eval harness | ✅ | brief × critique 形成可批量评测的 harness，沉淀 case 集做迭代回归 |
| Phase C.3 | Self-critique pre-emit gate（路线 A） | ✅ | 模型在 emit brief 前先跑一轮 silent self-critique，gate 分 < 3 触发最多 2 轮重写；借鉴 nexu-io silent self-critique 模式注入 system context |

**关键产物**：
- 共享契约：`src/shared/contract/designBrief.ts`、`src/shared/contract/workspacePreview.ts`
- 前端：`QuestionFormPreview`、`WorkspacePreviewPanel`、`useWorkspacePreviewModel`
- 主进程：`workbenchTurnContext` + `messageBuild` 把 design 元数据塞进 envelope 与 system prompt

**当前定位**：作品集 / portfolio 类设计任务的协作骨架，主聊天对所有用户透明（不影响普通编程问答）。

#### 3.1.15 Channel Inbox / Outbox 实时事件（v0.16.71）

打通"外部渠道（飞书 Webhook 等）→ Code Agent → 渠道回写"的双向实时通道，作为多渠道接入的基础事件层。

| 能力 | 状态 | 说明 |
|------|------|------|
| Channel inbox 实时事件 | ✅ | 入站事件流统一进入 inbox 通道，UI / Agent 可订阅 |
| Channel outbox 实时事件 | ✅ | 出站消息走 outbox，渠道发送状态可追踪 |
| IPC `list / dismiss` | ✅ | renderer 可列出 / 关闭 inbox 项；TaskMonitor / 任务分解视图承接能力状态与事件摘要 |

#### 3.1.16 Workspace Preview Panel（v0.16.71）

新增右侧 workbench tab `WorkspacePreviewPanel`，从早期 design brief / question form 预览升级为 artifact workbench。它负责预览生成物、展示 Design PPT / Prompt Apps / Gallery，并和 TaskMonitor scope inspector 联动。旧 Delivery Review / Preview Feedback 链路已随 evaluation 子系统下线。

| 能力 | 状态 | 说明 |
|------|------|------|
| `WorkspacePreviewPanel` tab | ✅ | 走统一 `WorkbenchTabs` 模型，单例 tab，tab id 与 session 同步 |
| Design brief 元数据预览 | ✅ | `useWorkspacePreviewModel` 订阅 envelope `designBrief` 元数据，brief / critique / self-critique 进展实时可视 |
| Question form 预览 | ✅ | `QuestionFormPreview` 在面板内呈现结构化问答 artifact，与 chat 主链路共享同一份 state |
| TaskMonitor scope inspector | ✅ | TaskMonitor 增加 scope inspector，与 Workspace Preview 联动定位"当前 turn 在编辑哪个 artifact / 哪个 scope" |
| Design PPT Preview | ✅ | `design_ppt` artifact 专用 renderer，展示 slides、theme、iterations、截图网格、prompt/code path，并提供 Open PPTX / Edit code |
| Delivery Review | 已下线 | 旧 `delivery_review` queue / Preview Feedback 已在 5/19 evaluation cleanup 中删除 |
| Acceptance UI entry | 设计中 | game/deck/dashboard verifier 继续保留，后续按新的 artifact issue 模型接入 TaskPanel / Workspace Preview |

#### 3.1.17 调试快照 + CLI debug 命令树（v0.16.68，ADR-014）

把"事后回放 agent loop 异常"做成一等公民。每 turn 进入态、每次上下文压缩前后双 snapshot 都有结构化记录，并在 settings 与 CLI 都暴露入口。

| 能力 | 状态 | 说明 |
|------|------|------|
| `turn_snapshots` 表 | ✅ | 每 turn 进入时由 `turnSnapshotWriter` 写入完整上下文（messages + system prompt + tool registry + memory inject） |
| `compaction_snapshots` 表 | ✅ | `autoCompressor.compress()` 调用前后双写，方便复盘"压缩前后 context diff" |
| Step pause | ✅ | dev 模式可让 agent loop 跑到指定 turn 暂停，等用户检视后恢复 |
| Settings "调试快照" section | ✅ | 设置页可看快照统计、清理、配置保留窗口（retention selector） |
| IPC `data` 域 | ✅ | `data:snapshot.stats / clear / setRetention` 暴露给 renderer 与 CLI |
| CLI `code-agent debug` 命令树 | ✅ | `code-agent debug snapshot list / show / clear` 等子命令在 CLI 模式下复用相同能力 |

详细设计：[ADR-014: 调试快照系统](./decisions/014-debug-snapshot-system.md)。

#### 3.1.18 Runtime / Web / Context 主链路加固（2026-05-01~05-03）

这一组集中修复长会话和 Web 模式里最容易被用户感知为"跑丢了"的问题。

| 能力 | 状态 | 说明 |
|------|------|------|
| Compaction + browser recovery | ✅ | 上下文压缩、浏览器恢复和 tool-call hydrate helper 串进 contextHealth，agent error 可回到可解释状态 |
| Partial failure status | ✅ | chat trace 可展示部分失败状态，active turn 自动滚入视图，不再让用户误判为无响应 |
| Web REST session 修复 | ✅ | 本地 auth token mismatch 触发 401/403 时可恢复；user message 在 run 前持久化；model session override 与 activeAgentLoops flush 统一 |
| Telemetry error classifier | ✅ | structured error classifier、intent extension、turn auto-finalize、token-trigger compaction 串成闭环 |
| Context fill 估算 | ✅ | context fill estimate 纳入 tool schemas token，避免长工具列表下低估上下文占用 |
| Failure-mode loop breaker | ✅ | anti-scraping hint、stagnation detector、ground-truth gate 和重复警告后断环，减少无效搜索/抓取循环 |
| Assistant message 持久化 | ✅ | assistant messages 可靠落库，Web / app reload 后不再只依赖 live stream 内存态 |
| 中文输出长度识别 | ✅ | complexity analyzer 能识别中文里的输出长度约束，长报告/短答不再全靠模型自由发挥 |

#### 3.1.19 Artifact Acceptance / Repair 质量门禁（2026-05-07~05-09）

artifact 不再只看"有没有生成文件"，而是进入按类型验证、失败指导、受限修复的循环。重点先落在游戏、PPT deck 和 dashboard / interactive app。

| 能力 | 状态 | 说明 |
|------|------|------|
| 通用 repair toolkit | ✅ | 从 platformer 多轮失败中抽出 issue code → repair instruction → scope guard、prompt limit、monotonic baseline 等通用模式 |
| Game subtype architecture | ✅ | game validator 从平台跳跃类过拟合迁到 subtype registry / skill loader / scope guard 自注册；runner subtype 验证扩展性 |
| Best-of-N + repair cap | ✅ | repair 有次数上限和单调改进门禁，避免越修越差或无限循环 |
| DeckVerifier | ✅ | Deck 验收从旧 `validateNarrative` 迁到 `DeckVerifier`，包含 schema probe、声明式/命令式 narrative probes、baseline harness，并接入 `pptGenerate` |
| `deck-generation.ts --live` | ✅ | 外部产品可用 live mode 跑 deck generation acceptance，避免只靠 fixture 假成功 |
| DashboardVerifier | ✅ | interactive app / dashboard 验证进入独立 verifier：HTML probes、browser visual smoke、state_change_on_click 反 Potemkin probe |
| Cross-kind verifier 决策 | ✅ | ADR-016 明确不强抽统一 ArtifactKindVerifier；Game / Deck / Dashboard 按自身输入形态演进，等第三类跑通后再讨论共接口 |
| Game artifact repair guidance | ✅ | 5/9 补强 game artifact validation 和 repair guidance，Task rail UI 同步聚焦真实验收状态 |

#### 3.1.20 Typed IPC / Provider / Async 质量门禁（2026-05-04~05-06）

这组是架构健康层，不直接增加用户入口，但会降低后续迭代成本和运行时隐性错误。

| 能力 | 状态 | 说明 |
|------|------|------|
| ConfigService 单源 | ✅ | `IReadConfigService` 抽象后，CLI 和 webServer 共享 main ConfigService，避免 CLI/Tauri/Web 默认配置分叉 |
| strict `no-explicit-any` | ✅ | ESLint 将 `no-explicit-any` 提到 error，263 个 latent sites 收口；保留的 54 个 `as any` 必须带 TODO 和上下文 |
| zod IPC 基建 | ✅ | `shared/ipc` schema、`defineHandler`、renderer `typedInvoke`、web `parseBody` 形成 typed IPC / HTTP payload 校验起点 |
| Provider wrappers | ✅ | OpenAI / Anthropic / DeepSeek / Gemini response 解析走 zod safeParse wrappers；SSE stream 也切到 wrappers，51 个 fixtures 做 contract tests |
| Provider symmetry guard | ✅ | provider list、default、model catalog、UI picker、routing fallback 通过脚本、Husky 和 GitHub Actions 保持对称；volcengine / grok 补入 supported list |
| Async correctness | ✅ | 14 处 `Promise.race` 收敛到 `withTimeout`；module-level timer 接 graceful shutdown + `.unref()`；`new URL()` 在 Promise executor 顶部加 try/catch |
| God-file split | ✅ | HookManager execution engine、telemetryQueryService transcript replay、TaskDAG graph algorithms 拆分，配合 `max-lines` 守门继续压大型单体 |
| Dead code retirement | ✅ | POC subsystem、cloud agent module、legacy provider functions、old decorated tools、orphan resume、unused exports 清理；Message 类型统一到 shared/contract |

#### 3.1.21 自定义 Agent + 权限继承 + Doctor 诊断（2026-05-13）

把多 Agent 的两个基础承诺（可复用 agent、subagent 不能绕权限）和环境自检补实。

| 能力 | 状态 | 说明 |
|------|------|------|
| Custom Agent Registry | ✅ | 用户级 `~/.code-agent/agents/*.md` 和项目级 `<cwd>/.code-agent/agents/*.md` 进入 `agentRegistry` 单一来源，合并顺序 project > user > builtin；double-buffer 热加载避免 in-flight spawn 读到半填充态 |
| Agent 全链路暴露 | ✅ | `ca list-agents` 显示来源，`spawn_agent` / Task 工具共用最新 agent id 集，renderer StatusBar AgentSwitcher 通过 `agents:list` / `agents:changed` 刷新 |
| Subagent 权限继承 | ✅ | 三档模式 `strict-inherit`（默认）/ `child-narrow` / `independent`；子 tools = parent ∩ child、deny 取并集、permission mode 取更严格者；reviewer/readonly 父 agent 禁止派生写能力子 agent |
| 用户规则级联 | ✅ | `settings.permissions.deny/ask/allow` 经 `UserConfigSource` 进入 GuardFabric，主 agent 和 subagent 同时生效，General settings 可配置 |
| Doctor 诊断 | ✅ | `/doctor` 聚合环境检查项，CLI 和 GUI 共享 `DoctorReport`；MCP lazy 计 skip，网络/版本失败降级 warn 而非 fail |

#### 3.1.22 Context Health 溯源 + 取消级联 + Computer-use MCP 入口归位 + 工作台诊断面板群（2026-05-13~05-14）

这一轮把「上下文 token 从哪来」「取消怎么往下传」「Computer 工具为什么失败」做成可观测、可控制的主链路能力。

| 能力 | 状态 | 说明 |
|------|------|------|
| Context Health Token 溯源 | ✅ | `TokenBreakdown.bySource` 按 rules/skills/mcp/subagents/fileReads/conversation 六维拆分；skill mount/unmount、AGENTS.md 注入、fileRead、MCP 结果、subagent 输出统一上报 |
| Context Panel | ✅ | workbench 新增 `context` tab，一级按消息结构、二级按产品来源展开，每项可跳转（联动 SkillsPanel）或 ✕ 卸载（MCP 走 `setServerEnabled` IPC） |
| 取消级联 | ✅ | `CancellationReason` 分 CASCADE（user-cancel/session-switch/parent-cancel 向下穿透）和 NON_CASCADE（child-error/timeout/idle-timeout/budget-exceeded 只熔断单 agent）；四阶段 shutdown + 2 分钟 idle watchdog |
| Per-agent Stop UI | ✅ | SwarmMonitor 每个 agent 卡片可独立 Stop，取消单 agent 不级联兄弟 |
| Computer-use MCP 入口归位（Level 1） | ✅ | Computer + Screenshot 暴露成独立 native ToolModule，统一走 MCP 入口；当前是 wrapper-mode，执行仍委托 legacy `ComputerTool`，为 Level 2 原生重写留接口 |
| 工作台诊断面板群 | ✅ | Context Health、Knowledge Memory Audit、Activity Entry、Computer-use Diagnostics、Time Capability 五类诊断面板进入聊天主链路，Workspace Preview 露出工作区产物 |
| Runtime Steer | ✅ | 运行中途用户输入排队进当前轮次消息历史，下轮推理生效，guided UI 标记 `queued_next_turn`；web host follow-up 带 `clientMessageId` 供 rewind 溯源 |
| Vision 模型切换 | ✅ | 视觉模型切到免费档 `glm-4.1v-thinking-flash`（带推理链），8 个视觉模块统一从 `ZHIPU_VISION_MODEL` 常量读取 |
| Channel / 本地活动隐私防火墙 | ✅ | 渠道入站消息与本地桌面活动落地前统一脱敏：`ChannelPrivacyMode` 三档（local-redact/allow-raw/off）+ 飞书接入 + 设置 UI；本地活动事件脱敏 + 截图区域级 blur；`sensitiveDataGuard` 补 SSN / 信用卡 Luhn 脱敏；Rust 采集器侧对称脱敏。是 Sensitive Data Guard 派生数据脱敏层的延伸，raw session 消息仍全保真 |

#### 3.1.23 Agent Neo 0.16.75 近两天产品增量（2026-05-15~05-17）

这一轮把产品从"能跑的 agent workbench"推进到"能让用户配置、接力、验收和运营的 Agent Neo"。重点是把高频入口留给聊天，把低频能力收到设置与管理面，把生成物验证从外部脚本带回 app 内。

| 能力 | 状态 | 说明 |
|------|------|------|
| Agent Neo 品牌与站点 | ✅ | App 名称、Tauri bundle、icon、About/Update/terminal 文案、MCP server 标识和公开 landing page 已切到 Agent Neo；代码仓库和 npm 包仍沿用 `code-agent` |
| 新用户模型配置 onboarding | ✅ | 登录/注册后引导用户设置本地 API Key；`ModelSettings` 负责 Provider 配置、连通性测试和模型目录发现，避免首次运行卡在无模型状态 |
| 本地 API Key 模型策略 | ✅ | 服务器侧 cloud proxy 已退场；模型请求默认使用本机配置的 provider key，图像/PDF/PPT 等网络模型工具也走相同配置边界 |
| Agent Engine 选择器 | ✅ | Native Agent Neo、Codex CLI、Claude Code 进入同一模型胶囊；外部 engine 默认 read-only、cwd 必须在 workspace 内，运行日志和输出引用进入 TaskPanel |
| 外部会话导入 | ✅ | Codex / Claude 历史 jsonl 可被扫描、预览和标准化为 session 片段，用于接力、复盘和 review |
| 管理设置面 | ✅ | Settings 分成基础偏好、能力与连接、记忆与隐私、系统、管理五组；Workspace、Automation、Data、Model、MCP、Skills、Channels、Capability Center 都有可搜索入口 |
| 统一记忆管理 | ✅ | 记忆导入、候选决策、条目管理、注入 trace、Knowledge Memory Audit 和 seed injection 串成一条可操作链路 |
| Capability Center 本地货架 | ✅ | Skill / MCP template / tool bundle / channel adapter / workflow recipe / connector / agent engine 可发现；MCP 安装先生成 disabled draft，可删除、可回滚、可去 MCP 设置管理 |
| In-App HTML Validation | ✅ | 新增 `validate_html_in_app` 工具和右侧验证面板，HTML artifact 可在 app 内 iframe 里执行 click/hover/type/press/wait + expect 脚本，用户能看见验证过程 |
| Managed Browser Surface | ✅ | Sidebar 露出 Browser Surface 面板，Browser relay service 与 managed browser session 接入右侧工作区，浏览器状态从底层工具变成可查看工作面 |
| Artifact repair Route A | ✅ | artifact repair 改成 full-rewrite-first；repair round 会继承 baseline 和 failures，并通过 monotonic gate 避免越修越差 |
| Assistant handoff proposals | ✅ | 长任务尾部可生成 handoff proposal，TaskPanel 用 `HandoffCard` 展示，帮助用户把未完成上下文带到下一轮或外部 agent |
| Background task ledger | ✅ | Shell/background task 与 PTY session 进入统一 task ledger；完成/失败通知、output refs 和当前 session 回带在 TaskPanel/Run Status Rail 可见 |
| TaskPanel 完成态可读性 | ✅ | 任务完成后仍保留 details，不再因为终态折叠掉验收、输出和失败原因 |
| Hook source metadata | ✅ | Hook trigger source 进入 hook history 和 turn timeline，聊天 turn 展示来源、事件、allow/block、耗时和错误数 |
| 管理员用户/邀请码 | ✅ | 管理员可查看用户 dashboard、管理 invite code；admin-only surfaces 走统一 guard，普通用户入口和 IPC 都会被拦截 |
| 可选 Tauri 更新 | ✅ | release workflow、update manifest、Settings Update 页面和启动提示打通；up-to-date 状态不再弹无意义 toast |
| 分发安全扫描 | ✅ | release 包关闭第一方 sourcemap，Tauri resources 移除 webServer map；`release:security-scan` 扫描 sourcemap、sourceMappingURL、docs/tests/src、`.env`、私钥等高风险内容，并接入 bundle/install/release |
| 游戏生成 A/B 资产 | ✅ | 平台游戏生成的 A/B 测试产物、原始推理、截图和 report 已落盘，作为 artifact acceptance 与 prompt 对照的实证材料 |

当前边界：
- 外部 Agent Engine 这一版只放行 read-only profile，不允许外部 CLI 在 app 内直接获得写权限。
- Capability Center 的远程 marketplace 仍是后续方向；当前已完成的是本地 curated registry 与 disabled draft 安装安全层。
- In-App HTML Validation 适合验证自己生成的 HTML artifact；真实网站、反 bot、原生菜单、drag-and-drop 仍走 Playwright/CDP 或人工接管路径。
- 管理员页面依赖 Supabase RPC 和 profile admin 标记；没有 admin 权限时页面可见性和 IPC 都不能绕过 guard。
- 分发安全的 P0 目标是 release 包不带内部源码、sourcemap、docs、测试和密钥；license、entitlement、远程 marketplace、付费策略和高价值 prompt 仍应放服务端。

---

### 3.2 智能层（差异化）

#### 3.2.1 多模型智能路由

```
用户消息 → 复杂度评估 → 模型选择
                           ├── 简单任务 → GLM-4.7-Flash（免费）
                           ├── 中等任务 → DeepSeek V4 / Kimi K2.6 / GLM-4.6
                           ├── 复杂任务 → GPT-5.5 / Claude Opus / DeepSeek V4 Pro
                           └── 失败降级 → PROVIDER_FALLBACK_CHAIN
```

| 能力 | 说明 |
|------|------|
| 14+ Provider 支持 | 小米 MiMo (Token Plan), OpenAI, DeepSeek, Claude, Groq, Qwen, Moonshot, Minimax, Zhipu, Perplexity, OpenRouter, Gemini, 火山引擎 (豆包), Local (Ollama) |
| 默认对话模型 | 小米 MiMo v2.5 Pro（Token Plan 包月套餐，1M context，新加坡节点）；旧默认 Claude Sonnet 4.6 仍可一键切换 |
| 能力匹配选模型 | `selectModelByCapability()` 按任务类型分配 |
| 自动降级链 | Provider 故障时自动切换备选 |
| 运行时切换 | StatusBar 下拉菜单实时切换模型 |
| 测试连接 | ModelSettings 一键验证 API Key |
| Provider 健康监控 | 四状态机（healthy/degraded/unavailable/recovering），ModelSwitcher 健康色点 |
| 搜索 + 能力标签 | ModelSwitcher 内搜索模型名，显示 vision/tool/reasoning 标签 |
| 本地 Key 优先 | 2026-05-15 起不再依赖服务器侧 cloud proxy；用户在本机配置 Provider API Key，onboarding 会引导首次配置 |
| 跨 provider reasoning 对齐 | `reasoning_effort` 与 thinking-mode sampling 对齐到 OpenAI、Claude、DeepSeek、Moonshot、小米等 provider wrapper |
| Agent Engine 切换 | ModelSwitcher 同时承载 Native Agent Neo / Codex CLI / Claude Code，外部 engine 运行走 read-only、workspace-only 和 task ledger |
| AI SDK 双引擎 | Provider 层迁 Vercel AI SDK（`aiSdkAdapter` 归一流式/非流式 tool-call），`CODE_AGENT_MODEL_ENGINE` 默认 aisdk、可回退 legacy；消灭解析不对称的整类 bug。详见 [ARCHITECTURE v0.16.80 M1](./ARCHITECTURE.md) |
| Goal Mode（`/goal`） | 自治目标循环：完成判定权落代码层三层闸（确定性 verify exec + 软条件 Reviewer 子代理 + 代码层兜底），`--verify`/`--review` 二选一。详见 [goal-mode spec](./designs/goal-mode.md) |

#### 3.2.2 评测框架（Swiss Cheese）

| 维度 | 指标 |
|------|------|
| 任务完成度 | 是否正确完成用户请求 |
| 工具效率 | 工具调用次数 / 冗余比 |
| 代码质量 | 生成代码的正确性和风格 |
| 对话质量 | 响应相关性和简洁性 |
| 性能 | 响应时间 / token 消耗 |
| 安全 | 是否遵循权限约束 |

附加能力：
- Failure Funnel 5 阶段错误分类
- 实验管理 + A/B 对比
- 遥测数据收集 + 会话分析
- 本地 Ollama 模型评测（ADR-013）：评测中心和主聊天 ModelSwitcher 都可挂 Ollama，跨 provider 跑同一 testSet 拿对比 baseline
- `evalEligible` 字段（catalog）：仅评测候选模型在 `CreateExperimentDialog` 出现，避免误把视觉 / 嵌入模型当主聊天打分对象
- SWE-bench docker harness（ADR-015）：`eval/swe-bench/` 独立目录跑业界标准 SWE-bench Verified，colima + docker image，Django <15min 子集 9/10 first-shot，与产品代码完全解耦
- Review Queue 视图增强：`SessionListView` 把待评 session 集中分桶，标注 replay 完整度与异常 case

#### 3.2.3 Light Memory（文件即记忆）

6 层上下文注入（借鉴 ChatGPT 架构）：

| 层级 | 内容 | 注入方式 |
|------|------|---------|
| 1. System Instructions | Agent 身份定义 | 每次对话 |
| 2. Session Metadata | 使用频率、模型分布 | 统计注入 |
| 3. Memory Index | INDEX.md 记忆索引 | 常驻注入 |
| 4. Recent Conversations | ~15 条对话摘要 | 滚动窗口 |
| 5. RAG Context | 向量检索结果 | 按需注入 |
| 6. Current Session | 当前对话上下文 | 滑动窗口 |

存储：`~/.code-agent/memory/`（类型化 .md 文件）
工具：MemoryWrite + MemoryRead（CORE_TOOLS）

#### 3.2.4 多 Agent 编排

| 能力 | 说明 |
|------|------|
| DAG 调度 | Kahn 拓扑排序，支持并行 + 依赖 |
| 6+ 内置 Agent | 通用、探索、规划、代码审查等 |
| 任务自管理 | Agent 可自主认领/完成任务 |
| 计划审批 | 高风险操作需用户确认 |
| 优雅关闭 | 4 阶段：Signal → Grace → Flush → Force |
| 取消级联 | `CancellationReason` 区分 CASCADE / NON_CASCADE；父级取消向下穿透，子级失败/超时只熔断自身 |
| Idle watchdog | 子 agent 2 分钟无 stream/progress 自动 abort，单 agent 可独立 Stop |
| 断点恢复 | 会话中断后可恢复未完成任务 |
| 暂停/恢复 | Graceful pause，等当前迭代结束后暂停 |
| 检查点回溯 | 文件回滚 + 消息截断 + "从此重试" Fork |
| Git 分支追踪 | 会话创建时自动记录 git 分支，/sessions 显示分支和 PR |
| 跨会话续传 | /resume 注入历史会话上下文，支持无参自动查找或指定 ID |

---

### 3.3 技能层（扩展）

#### 3.3.1 研究模式（Deep Research）

- 渐进式搜索循环 + 4 层降级链（Web → PPLX → Tavily → Brave）
- 中文搜索优化（翻译跳过 90-255s → 6-9s）
- 多源语义聚合 + 引用报告生成

#### 3.3.2 文档生成

| 类型 | 能力 |
|------|------|
| PPT | 3 阶段流水线（大纲→并行内容→组装），9 个母版模板 |
| Excel | 数据表格 + 图表自动生成 |
| DOCX | Word 文档生成 |
| Chart | Mermaid / 数据可视化 |

#### 3.3.3 桌面活动追踪

- 后台截图 + AI 语义分析（Zhipu GLM-4V-Plus）
- 活动时间线 + 语义搜索
- 原生 Rust FFI 截图（CGScreenshot）

#### 3.3.4 插件 & Hooks

| 系统 | 说明 |
|------|------|
| Skills | 可移植能力包，动态加载 |
| Hooks | 19 种事件类型，decision/observer 双模式，trigger history；设置页可查看启用状态和打开配置 |
| Plugins | 完整生命周期（discover → load → activate → deactivate）+ /plugins 控制面板（install/uninstall/validate） |
| MCP | Model Context Protocol 集成 |
| Prompt Manager | Prompt Registry + UI override，默认文本可查看，自定义文本持久化到 `~/.code-agent/prompts-overrides/` |

**Hook 事件覆盖**:

| 稳定性 | 事件 |
|--------|------|
| stable (10) | PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, PostExecution, PreCompact, SessionStart, SessionEnd, SubagentStop |
| experimental (7) | SubagentStart, PermissionRequest, TaskCreated, TaskCompleted, PermissionDenied, PostCompact, StopFailure |
| internal legacy (2) | Setup, Notification |
| observer-only | PostToolUse, PostToolUseFailure, PostExecution, SessionStart, SessionEnd, SubagentStop, TaskCreated, TaskCompleted, PermissionDenied, PostCompact, StopFailure |

**Hook 模式**:
- **decision** — 可阻止或修改工具执行（默认）
- **observer** — 只读监控，block/modify 结果被忽略

---

### 3.4 命令面板

`/` 前缀或 `Cmd+Shift+P` 触发，支持搜索和键盘导航：

| 分类 | 命令示例 |
|------|---------|
| 会话 | 新建会话、清空对话、归档、/sessions（分支+PR+目录）、/resume（跨会话续传） |
| 可观测性 | /cost（token 费用）、/context（上下文占用）、/status（系统概览）、/agents（Agent 历史） |
| 安全 | /permissions（权限模式 + 决策历史）、/hooks（事件配置 + 触发记录） |
| 插件 | /plugins（list/install/uninstall/validate/reload-all + MCP 列表） |
| 视图 | 切换侧边栏、DAG 面板、工作区、评测中心 |
| 设置 | 打开设置、键盘快捷键、设置页搜索（18 项索引，中英文模糊匹配） |
| 集成 | MCP 服务器添加 UI（stdio/SSE/HTTP 三类型）、Provider 诊断面板（5 类探针） |

---

## 四、非功能需求

### 4.1 性能

| 指标 | 要求 |
|------|------|
| 首次启动 | < 3 秒 |
| 首字符延迟 | < 500ms（流式） |
| 文件操作 | < 100ms |
| 内存占用 | < 500MB（空闲） |
| 长会话 | 50+ 轮对话保持流畅（三层压缩） |

### 4.2 部署

| 模式 | 说明 |
|------|------|
| Tauri 桌面 | macOS 11.0+，~33MB DMG |
| Web 模式 | Node.js HTTP 服务器 + Electron Mock |
| 云同步 | Supabase + pgvector（可选） |

### 4.3 安全

- 文件操作需用户确认（安全模式下）
- 敏感命令二次确认
- API Key 不打包进分发包
- CLI 模式默认关闭 autoApprove
- Auto-update 通道 sha256 校验（M6.a）：cloud-api 下发 `sha256` 字段，updater 在下载产物落盘前与云端断言哈希逐字节校验，不一致直接拒绝
- `open_update_url` 阻止二进制下载（M6.b）：updater 入口只允许在浏览器打开 release 页，禁止直接拉取 `.dmg / .tar.gz` 等二进制，杜绝绕过 sha256 校验的旁路
- `SessionManager` 剥离 `ModelConfig.apiKey`：HTTP response 经 `SessionManager` 出口前会显式 strip apiKey 字段，防止云同步 / Web 模式回传链路把密钥泄漏到 renderer 或日志
- Bash 命令注入根治（Audit Phase A）：长期遗留的 shell 拼接路径全部走 `execFile` 化改造，与默认模型硬编码同批清理

---

## 五、验收标准

### 5.1 核心功能

- [x] 通过对话完成文件读写、命令执行、代码搜索
- [x] 工具执行可视化（展开/折叠/diff）
- [x] 多模型切换和运行时覆盖
- [x] 权限三级模式正常工作
- [x] macOS Tauri 桌面 + Web 双模式运行

### 5.2 智能层

- [x] 模型路由按复杂度自动选择
- [x] API Key 测试连接功能
- [x] Light Memory 跨会话持久化
- [x] 多 Agent DAG 并行调度
- [x] 评测框架可运行并输出分数

### 5.3 质量指标

- [x] TypeScript 类型检查零错误
- [x] 核心模块单元测试覆盖（tokenEstimator, tokenOptimizer, SessionRepository）
- [x] 评测分数 ≥ 164/200

---

## 六、已知限制 & 未来方向

### 6.1 当前不支持

| 项目 | 原因 |
|------|------|
| IDE 集成（VS Code 插件） | 设计选择：独立应用优先 |
| 内联代码补全 | 非目标场景 |
| Windows / Linux | 仅 macOS，跨平台优先级低 |
| 旧 Memory 系统完全移除 | Light Memory 仍需验证期，旧系统保留为 fallback |

### 6.2 技术债

| 项目 | 状态 |
|------|------|
| bash shell 注入根治（exec→execFile） | ✅ 已落地（Audit Phase A，2026-04-28） |
| 旧 Memory 向量系统（~11K 行） | 等 Light Memory 稳定后清理 |
| snake_case 工具别名 | 向后兼容中，计划移除 |
| God File 守门 | `max-lines: 1000` ESLint 守门，19 个 legacy God File 进白名单逐步消化 |
| 模型 capability / 缩写双源真理 | ✅ 已收敛到 `models.ts` 单一源 |
| Supabase services TS `as any` | 一次性清理 18+ 处，并修出 latent bug（B5 audit） |

---

## 七、附录

### 7.1 术语表

| 术语 | 定义 |
|------|------|
| Agent | AI 代理，自主调用工具完成任务 |
| Agent Loop | Agent 的核心执行循环（推理→工具调用→观察→推理） |
| Tool | Agent 可调用的功能单元 |
| Observation Masking | 压缩旧工具输出以节省上下文窗口 |
| Light Memory | 文件即记忆系统，替代向量数据库 |
| DAG | 有向无环图，用于多 Agent 任务调度 |
| Swiss Cheese | 多维评测框架（借鉴瑞士奶酪安全模型） |
| Provider | 模型服务商（如 DeepSeek, Claude, OpenAI） |
| MCP | Model Context Protocol，模型上下文协议 |
| Skill | 可移植的 Agent 能力包 |
| Hook | 事件驱动的自动化触发器 |
| Workbench | 聊天主链路上统一的能力工作台，收口 workspace/skills/MCP/connectors/routing/browser |
| ConversationEnvelope | 聊天发送外壳，携带 workspace/routing/capability 等消息级上下文 |
| Turn Timeline | 一次对话 turn 内的执行解释时间线（workbench 快照 / blocked 能力 / routing 证据 / artifact 归属） |

### 7.2 参考

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 架构参考
- [JetBrains Junie](https://www.jetbrains.com/junie/) — Observation Masking 灵感
- [ChatGPT Memory](https://openai.com/index/memory-and-new-controls-for-chatgpt/) — 6 层注入架构借鉴
