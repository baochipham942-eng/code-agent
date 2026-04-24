# Code Agent - 产品需求文档 (PRD)

> 版本: 2.4
> 日期: 2026-04-23
> 作者: Lin Chen

---

## 一、产品定义

### 1.1 一句话描述

**Code Agent** = 评测驱动的多模型 AI 编程助手

### 1.2 核心差异化

| 维度 | Code Agent | 竞品（Claude Code / Cursor / Windsurf） |
|------|-----------|----------------------------------------|
| 模型绑定 | 13+ Provider 智能路由，按任务复杂度选模型 | 锁定 1-2 家 Provider |
| 成本控制 | 自适应路由降本 60%（简单任务→免费模型） | 固定模型，无成本优化 |
| 质量闭环 | 内置 Swiss Cheese 评测框架，132→164/200 可量化 | 无内置评测 |
| 记忆系统 | Light Memory 文件即记忆，跨会话持续学习 | 无跨会话学习 |
| 协作模式 | DAG 多 Agent 并行编排 | 单 Agent |
| 部署形态 | Tauri 桌面 + Web 双模式 | 仅桌面或仅 IDE 插件 |

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
| AI 模型 | Kimi K2.5（主）/ DeepSeek / Claude / OpenAI / 智谱 等 13+ Provider |

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
| 消息编辑/重试 | ✅ | 用户消息内联编辑，助手消息重新生成 |
| Artifact 追踪 | ✅ | 自动提取 chart/spreadsheet/mermaid artifacts 并展示 |
| 推理强度控制 | ✅ | 4 级 Effort Selector（Low/Med/High/Max） |
| Code/Plan/Ask 模式 | ✅ | 三种交互模式一键切换 |

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

#### 3.1.3 上下文管理

三层递进压缩：

| 层级 | 触发条件 | 策略 | 效果 |
|------|---------|------|------|
| L1 Observation Masking | ≥60% 上下文占用 | 替换旧工具结果为占位符 | 保留逻辑骨架 |
| L2 Truncate | ≥85% | 截断中间段，保留代码块 | 保留首尾 |
| L3 AI Summary | ≥80% | 生成语义摘要 | 最大压缩 |

#### 3.1.4 Chat-Native Workbench（主链路交互结构）

把 `workspace / skills / MCP / connectors / routing / browser` 从分散的侧面板收到聊天主链路里。用户不需要先去几个不同的入口设置好，再回来发消息。

| 能力 | 说明 |
|------|------|
| `ConversationEnvelope` 消息外壳 | 发送 payload 携带 workspace / routing / capability / browser 上下文；旧 payload 由 `normalizeEnvelope()` 兼容，不回归 |
| `InlineWorkbenchBar` | 输入框上方的能力栏：workspace chip、routing chip（Auto/Direct/Parallel）、skills/connectors/MCP 选择 |
| 内联启动卡片 | swarm launch approval 以 `LaunchRequestCard` 方式出现在聊天 turn 内，同一组件与 TaskPanel 复用 |
| Direct Routing（@agent） | `@agent` mention → 主进程持久化 → fanout；持久化失败 renderer 回滚 optimistic 消息 |
| Turn 级执行解释 | 每个 turn 内投影 4 类节点：`workbench_snapshot` / `blocked_capabilities` / `routing_evidence` / `artifact_ownership` |
| Session-Native Workspace | Sidebar `Resume / Reopen Workspace / Export`；历史 session 的 workbench 选择可回灌当前 composer |
| Unified Trace Identity | Replay / Review Queue / Eval Center / session list 共享同一 `session:<sessionId>` trace identity |
| 显式 Browser / Desktop 入口 | `browserSessionMode` 区分 `managed / desktop`；blocked 时展示 reason 与 hint |

**核心定位**：Workbench 不改 orchestration 引擎，只改它的产品暴露方式。原有 `TaskPanel / SwarmMonitor` 保留为高级控制面，但不再是默认心智入口。

详细架构见 [docs/architecture/workbench.md](./architecture/workbench.md)，决策背景见 [ADR-011](./decisions/011-chat-native-workbench.md)。

当前产品边界（明确未产品化）：
- Connector 只展示 blocked reason + hint，**没有一键 connect / retry 闭环**
- 命名 `preset / recipe` 资产库未做（历史 session 复用已落最小闭环）
- Failure-to-Capability 多分流（skill / dataset / prompt-policy / capability-health）未做

#### 3.1.5 右侧工作面板（v0.16.60-65）

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

**死代码清理**：CloudTaskToggle / TaskListToggle / DAGToggle / ObservabilityToggle 及其 orphan state 全部移除，TitleBar 只保留 File Explorer / Skills / Task 三个入口。

#### 3.1.6 文件资源管理器（v0.16.60-65）

| 能力 | 状态 | 说明 |
|------|------|------|
| 同步 session 工作目录 | ✅ | 切换 session 时 Explorer 自动跟随 `workingDirectory`，不需要手动 reload |
| 内联新建 | ✅ | 文件树内直接新建 File / Folder，不弹独立对话框 |
| `openOrFocusTab` action | ✅ | 点击文件名调用统一 store action 打开或聚焦已有 Preview tab |
| TitleBar 入口 | ✅ | 顶栏 File Explorer toggle 按钮 |
| 原生文件选择器 | ✅ | `workspace:selectDirectory` 经 `@tauri-apps/plugin-dialog` 调起系统原生选择器，Web 模式 domain API fallback |
| 原生 reveal / open | ✅ | Write tool row 文件名可点击 + Preview `Reveal` 按钮，经 `@tauri-apps/plugin-opener` 调起 Finder |

#### 3.1.7 Sidebar（v0.16.64）

| 能力 | 状态 | 说明 |
|------|------|------|
| Codex-style workspace grouping | ✅ | Session 按 workingDirectory 分组，每组一个可折叠 header |
| 折叠状态持久化 | ✅ | 折叠偏好写入 `appStore`，跨会话保持 |

#### 3.1.8 权限安全

| 功能 | 说明 |
|------|------|
| 三级权限模式 | 安全模式（全确认）/ 自动编辑 / YOLO 模式 |
| 敏感命令拦截 | rm -rf, git push --force 等二次确认 |
| 工作目录隔离 | Agent 只能操作指定工作目录 |
| API Key 安全 | 本地存储，不打包进 DMG |
| 全局权限模式 | Default / Full Access 一键切换，确认浮窗 |
| 决策审计 | DecisionHistory 缓冲区（50 条），8 种决策类型，/permissions 可观测 |
| Generative UI 安全 | postMessage 来源校验 + CSP + prompt injection XML 隔离 |

#### 3.1.9 Live Preview + visual_edit（视觉定位编辑，v0.16.65 / 2026-04-24）

把"看见什么改什么"做成闭环 —— 用户在 iframe 里点元素，Agent 直接拿到源码位置去改，省掉"描述元素位置 / 给截图给坐标"的交互成本。

| 能力 | 状态 | 说明 |
|------|------|------|
| AbilityMenu Live Preview 入口 | ✅ | ChatInput 能力菜单里输入 dev server URL（默认 `http://localhost:5175/`）一键打开预览，右侧 PreviewPanel 新增 `liveDev` kind tab 加载 iframe |
| iframe 点击 → 源码定位 | ✅ | iframe 内点任意元素，bridge 通过 `data-code-agent-source="file:line:col"`（vite 插件编译期注入）回传 `SelectedElementInfo` |
| 蓝框视觉反馈 | ✅ | 选中元素在 iframe 内加 2px 蓝色 outline，面板底部同时显示 `<tag> file:line:col` |
| selectedElement 自动进入 envelope | ✅ | `composerStore.buildContext()` 读活动 liveDev tab 的 selection，塞入 `ConversationEnvelopeContext.livePreviewSelection` 随消息走，下游 visual_edit / system prompt 消费 |
| HMR 回流恢复 selection | ✅ | iframe reload（手动 Refresh / vite full reload）后 bridge 重新挂载，parent 自动发 `vg:restore-selection` 让 bridge 按 file:line 反查 DOM 重新高亮 —— 改代码 → 看效果 → 再微调循环不被打断 |
| Stale 自动清理 | ✅ | bridge 按 source location 找不到元素时发 `vg:selection-stale`，前端清 appStore selection，UI 回未选中态 |
| visual_edit 工具（Mode A） | ✅ | GLM-4.7 读 selection 上下文 → 输出严格 JSON `{old_text, new_text, summary}` → `old_text` 唯一命中 → atomicWrite 原子替换（0ki 订阅下无 vision 走纯文本推理） |
| 协议 SemVer 管理 | ✅ | `vite-plugin-code-agent-bridge` 协议独立仓库（v0.2.0），与 `src/shared/livePreview/protocol.ts` 同步 |
| 安全边界 | ✅ | iframe postMessage 强制 source+origin 校验；`validateDevServerUrl` IPC URL 白名单 + path-escape 防护；`resolveSourceLocation` IPC 规范化 file 路径，拒绝 workingDirectory 外 |

**典型工作流**：
1. 用户开 dev server（任意 vite 项目，`npm install vite-plugin-code-agent-bridge`）
2. 在 AbilityMenu 开 Live Preview → 右侧出 iframe
3. 点击 iframe 中想改的按钮 / 卡片 / 文本 → 蓝框 + 底部 source location
4. 在 Chat 发消息"把这个按钮改成圆角"→ envelope 自动带 selectedElement → visual_edit 工具用 source location 做 grounding 去 Edit
5. 保存触发 vite HMR → iframe 重载 → 蓝框自动回到原元素 → 用户直接再发下一轮指令

**当前边界**：
- 只覆盖 full reload 场景（手动 Refresh / vite 判断 full reload）；partial HMR 下 DOM 原地替换的 case 暂不自动恢复（需 DOM MutationObserver）
- visual_edit 只支持"精确唯一命中"模式，大段重构 / 跨文件改造仍走 Agent 主链路
- bridge 插件需 JSX 项目（vite + react / vue / svelte 的 JSX-like 模板），非 JSX 框架不支持

---

### 3.2 智能层（差异化）

#### 3.2.1 多模型智能路由

```
用户消息 → 复杂度评估 → 模型选择
                           ├── 简单任务 → GLM-4.7-Flash（免费）
                           ├── 中等任务 → DeepSeek / Kimi K2.5
                           ├── 复杂任务 → Claude Opus / GPT-4o
                           └── 失败降级 → PROVIDER_FALLBACK_CHAIN
```

| 能力 | 说明 |
|------|------|
| 13+ Provider 支持 | DeepSeek, Claude, OpenAI, Groq, Qwen, Moonshot, Minimax, Zhipu, Perplexity, OpenRouter, Gemini, 火山引擎 (豆包), Local (Ollama) |
| 能力匹配选模型 | `selectModelByCapability()` 按任务类型分配 |
| 自动降级链 | Provider 故障时自动切换备选 |
| 运行时切换 | StatusBar 下拉菜单实时切换模型 |
| 测试连接 | ModelSettings 一键验证 API Key |
| Provider 健康监控 | 四状态机（healthy/degraded/unavailable/recovering），ModelSwitcher 健康色点 |
| 搜索 + 能力标签 | ModelSwitcher 内搜索模型名，显示 vision/tool/reasoning 标签 |

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
| Hooks | 16 种事件类型，decision/observer 双模式，trigger history |
| Plugins | 完整生命周期（discover → load → activate → deactivate）+ /plugins 控制面板（install/uninstall/validate） |
| MCP | Model Context Protocol 集成 |

**Hook 事件覆盖**:

| 稳定性 | 事件 |
|--------|------|
| stable (9) | PreToolUse, PostToolUse, Stop, SessionStart, PostExecution 等 |
| experimental (2) | SubagentStart, SubagentStop |
| planned (2) | TaskCreated, TaskCompleted |
| observer-only (3) | PermissionDenied, PostCompact, StopFailure |

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
| bash shell 注入根治（exec→execFile） | 高风险，暂缓 |
| 旧 Memory 向量系统（~11K 行） | 等 Light Memory 稳定后清理 |
| snake_case 工具别名 | 向后兼容中，计划移除 |

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
