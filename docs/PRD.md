# Code Agent - 产品需求文档 (PRD)

> 版本: 2.1
> 日期: 2026-04-11
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

#### 3.1.4 权限安全

| 功能 | 说明 |
|------|------|
| 三级权限模式 | 安全模式（全确认）/ 自动编辑 / YOLO 模式 |
| 敏感命令拦截 | rm -rf, git push --force 等二次确认 |
| 工作目录隔离 | Agent 只能操作指定工作目录 |
| API Key 安全 | 本地存储，不打包进 DMG |
| 全局权限模式 | Default / Full Access 一键切换，确认浮窗 |
| Generative UI 安全 | postMessage 来源校验 + CSP + prompt injection XML 隔离 |

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
| Hooks | 11 种事件类型的自动化触发 |
| Plugins | 完整生命周期（discover → load → activate → deactivate） |
| MCP | Model Context Protocol 集成 |

---

### 3.4 命令面板

`/` 前缀或 `Cmd+Shift+P` 触发，支持搜索和键盘导航：

| 分类 | 命令示例 |
|------|---------|
| 会话 | 新建会话、清空对话、归档 |
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

### 7.2 参考

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 架构参考
- [JetBrains Junie](https://www.jetbrains.com/junie/) — Observation Masking 灵感
- [ChatGPT Memory](https://openai.com/index/memory-and-new-controls-for-chatgpt/) — 6 层注入架构借鉴
