# Code Agent 产品能力清单

> 基于 v0.16.37+ 代码库的完整能力梳理
> 生成时间: 2026-02-19

---

## 1. Agent Loop 核心循环

### 1.1 ReAct 推理-行动循环
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:107` (AgentLoop class)
- **描述**: 实现标准 ReAct 模式 — 调用模型推理 → 解析响应(文本/工具调用) → 执行工具(带权限检查) → 结果反馈模型 → 循环直到完成或达到最大迭代数

### 1.2 AgentOrchestrator 主控制器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentOrchestrator.ts:77` (AgentOrchestrator class)
- **描述**: Agent 完整生命周期管理 — 对话消息历史、权限请求/响应处理、模型配置获取、AgentLoop 创建和启动、工作目录管理

### 1.3 Async Generator Iterator
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoopIterator.ts:168` (createAgentIterator)
- **描述**: 将 AgentOrchestrator 的事件驱动模式包装为 async generator，便于 CLI/测试使用。含 EventQueue 线程安全队列、EventBridge 模式

### 1.4 截断自动恢复 (Dynamic maxTokens)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:229-234` (`_truncationRetried`, `_contextOverflowRetried`, `_consecutiveTruncations`)
- **描述**: 文本响应截断 → 自动翻倍 maxTokens 重试；工具调用截断 → 提升 maxTokens + 注入续写提示；连续截断熔断器(最多3次)

### 1.5 Context Overflow 自动恢复
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:228` (`_contextOverflowRetried`)
- **描述**: 遇到 ContextLengthExceededError 时自动压缩并以 0.7x maxTokens 重试

### 1.6 网络错误兜底重试
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:232` (`_networkRetried`)
- **描述**: 网络错误在 loop 层兜底重试 1 次(2s 延迟)

### 1.7 h2A 实时转向机制
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts` (steer() 方法)
- **描述**: 运行中注入用户消息不销毁 loop，保留所有中间状态。API 流中断通过 AbortController signal 传递，消息排队防覆盖

### 1.8 分步执行模式 (Step-by-Step)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:414-471` (shouldAutoEnableStepByStep, runStepByStep)
- **描述**: 为 DeepSeek/智谱等模型自动启用，解析多步任务后逐步执行

### 1.9 Plan Mode 支持
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:345-356` (setPlanMode/isPlanMode)
- **描述**: 计划模式激活/停用，可限制工具为只读

### 1.10 Structured Output
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:362-408` + `src/main/agent/structuredOutput.ts`
- **描述**: JSON Schema 输出验证，解析失败自动注入纠正提示重试(最多2次)

### 1.11 Nudge 机制 (非侵入式完成引导)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:128-168`
- **描述**: 5 种 Nudge 策略 — P1 只读停止检测, P2 Checkpoint 验证, P3 文件完成追踪, P5 输出文件存在验证, TODO 完成提醒

### 1.12 Anti-Pattern 检测器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/antiPattern/detector.ts`
- **描述**: 检测循环模式(重复读取/编辑失败), force-execute 参数验证, 策略切换建议(edit→write)

### 1.13 Circuit Breaker
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/toolExecution/circuitBreaker.ts`
- **描述**: 工具执行熔断器，防止同一工具反复失败

### 1.14 Goal Tracker
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/goalTracker.ts`
- **描述**: 目标追踪和完成验证，F4 Goal-based 完成检查

### 1.15 Adaptive Thinking 交错思考
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:224-225` (effortLevel, thinkingStepCount)
- **描述**: 4 级 effort(low/medium/high/max)，自动映射任务复杂度 → effort 级别。DeepSeek reasoning_content → thinking block

### 1.16 Budget 追踪
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/agentLoop.ts:207` (budgetWarningEmitted)
- **描述**: 预算控制和警告发射

### 1.17 Verifier 验证器系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/verifier/verifierRegistry.ts` + 8 个验证器
- **描述**: 8 种验证器 — code/data/document/generic/image/ppt/search/video，任务完成后自动验证输出质量

---

## 2. 工具系统 (8 代)

### 2.1 工具注册表
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/toolRegistry.ts:228` (ToolRegistry class)
- **描述**: 管理 70+ 工具的注册/注销/按代际过滤/云端元数据合并/别名支持(legacy snake_case → PascalCase)

### 2.2 工具执行器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/toolExecutor.ts`
- **描述**: 统一工具执行入口，权限检查 + 钩子触发 + 结果格式化

### 2.3 Gen1 — 基础文件操作 (7 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/file/` + `src/main/tools/shell/`
- **工具列表**:
  - `bash` — Shell 命令执行 (`shell/bash.ts`) — 含 stderr 合并输出, JSON-wrapper, heredoc 截断
  - `read_file` — 文件读取 (`file/read.ts`) — CSV/JSON schema 提取, 源数据锚定
  - `write_file` — 文件写入 (`file/write.ts`)
  - `edit_file` — 文件编辑 (`file/edit.ts`) — 成功后返回 4 行上下文代码
  - `kill_shell` — 终止 Shell (`shell/killShell.ts`)
  - `task_output` — 后台任务输出 (`shell/taskOutput.ts`)
  - `notebook_edit` — Jupyter 笔记本编辑 (`file/notebookEdit.ts`)

### 2.4 Gen1 补充 — PTY 进程管理 (6 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/shell/process.ts`
- **工具列表**: `process_list`, `process_poll`, `process_log`, `process_write`, `process_submit`, `process_kill`

### 2.5 Gen2 — 代码搜索 (3 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/file/` + `src/main/tools/shell/`
- **工具列表**:
  - `glob` — 文件模式匹配 (`file/glob.ts`)
  - `grep` — 内容搜索 (`shell/grep.ts`)
  - `list_directory` — 目录列表 (`file/listDirectory.ts`)

### 2.6 Gen3 — 任务规划 (12 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/planning/`
- **工具列表**:
  - `Task` — 子代理任务 (`planning/task.ts`)
  - `TodoWrite` — TODO 管理 (`planning/todoWrite.ts`)
  - `AskUserQuestion` — 用户提问 (`planning/askUserQuestion.ts`)
  - `ConfirmAction` — 确认操作 (`planning/confirmAction.ts`)
  - `read_clipboard` — 剪贴板读取 (`file/readClipboard.ts`)
  - `PlanRead/PlanUpdate` — 计划读写 (`planning/planRead.ts`, `planUpdate.ts`)
  - `FindingsWrite` — 发现记录 (`planning/findingsWrite.ts`)
  - `EnterPlanMode/ExitPlanMode` — 计划模式控制 (`planning/enterPlanMode.ts`, `exitPlanMode.ts`)
  - `TaskCreate/TaskGet/TaskList/TaskUpdate` — Claude Code 2.x 兼容任务 API (`planning/taskCreate.ts` 等)

### 2.7 Gen4 — 网络能力 (10+ 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/network/` + `src/main/tools/skill/` + `src/main/tools/mcp/`
- **工具列表**:
  - `Skill` — 技能元工具 (`skill/skillMetaTool.ts`)
  - `web_fetch` — 网页抓取 (`network/webFetch.ts`) — cheerio 解析 + modelCallback AI 提取 + smartTruncate 降级链
  - `web_search` — 网络搜索 (`network/webSearch.ts`) — 域名过滤(allowed/blocked) + auto_extract 搜索+提取一体化
  - `read_pdf` — PDF 读取 (`network/readPdf.ts`)
  - `http_request` — HTTP API 调用 (`network/httpRequest.ts`)
  - `lsp/diagnostics` — LSP 集成 (`lsp/lsp.ts`, `lsp/diagnostics.ts`)
  - MCP 工具集(6个): `mcp_tool`, `mcp_list_tools`, `mcp_list_resources`, `mcp_read_resource`, `mcp_get_status`, `mcp_add_server`

### 2.8 Gen5 — 办公文档 & 多媒体 (20+ 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/network/` + `src/main/tools/memory/`
- **工具列表**:
  - `ppt_generate` — PPT 生成 (`network/ppt/`) — 9 模块, 9 主题, 原生 addChart, 声明式 Slide Master
  - `image_generate` — 图片生成 (`network/imageGenerate.ts`)
  - `video_generate` — 视频生成 (`network/videoGenerate.ts`)
  - `image_analyze` — 图片分析 (`network/imageAnalyze.ts`)
  - `image_process` — 图片处理 (`network/imageProcess.ts`)
  - `image_annotate` — 图片标注 (`network/imageAnnotate.ts`)
  - `docx_generate` — Word 文档生成 (`network/docxGenerate.ts`)
  - `excel_generate` — Excel 生成 (`network/excelGenerate.ts`)
  - `chart_generate` — 图表生成 (`network/chartGenerate.ts`)
  - `qrcode_generate` — 二维码生成 (`network/qrcodeGenerate.ts`)
  - `read_docx` — Word 文档读取 (`network/readDocx.ts`)
  - `read_xlsx` — Excel 读取 (`network/readXlsx.ts`) — 含数据指纹记录
  - `pdf_generate` — PDF 生成 (`network/pdfGenerate.ts`)
  - `pdf_compress` — PDF 压缩 (`network/pdfCompress.ts`)
  - `screenshot_page` — 页面截图 (`network/screenshotPage.ts`)
  - `academic_search` — 学术搜索 (`network/academicSearch.ts`)
  - `speech_to_text` — 语音转文字 (`network/speechToText.ts`)
  - `text_to_speech` — 文字转语音 (`network/textToSpeech.ts`)
  - `jira` — Jira 集成 (`network/jira.ts`)
  - `youtube_transcript` — YouTube 字幕 (`network/youtubeTranscript.ts`)
  - `twitter_fetch` — Twitter 抓取 (`network/twitterFetch.ts`)
  - `mermaid_export` — Mermaid 导出 (`network/mermaidExport.ts`)
  - `xlwings_execute` — Excel 自动化 (`network/xlwingsExecute.ts`)
  - 记忆工具(5个): `memory_store`, `memory_search`, `code_index`, `auto_learn`, `fork_session`

### 2.9 Gen6 — 视觉交互 (4 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/vision/`
- **工具列表**:
  - `screenshot` — 截图 (`vision/screenshot.ts`)
  - `computer_use` — 计算机控制 (`vision/computerUse.ts`)
  - `browser_navigate` — 浏览器导航 (`vision/browserNavigate.ts`)
  - `browser_action` — 浏览器操作 (`vision/browserAction.ts`)

### 2.10 Gen7 — 多代理 (7 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/multiagent/`
- **工具列表**:
  - `AgentSpawn/spawn_agent` — Agent 生成 (`multiagent/spawnAgent.ts`)
  - `AgentMessage/agent_message` — Agent 消息 (`multiagent/agentMessage.ts`)
  - `WorkflowOrchestrate/workflow_orchestrate` — 工作流编排 (`multiagent/workflowOrchestrate.ts`)
  - `Teammate/teammate` — 团队通信 (`multiagent/teammate.ts`)
  - `plan_review` — 跨 Agent 审批 (`multiagent/planReview.ts`)
  - `sdk_task` — SDK 兼容任务 (`multiagent/task.ts`)

### 2.11 Gen8 — 自我进化 (4 工具)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/evolution/`
- **工具列表**:
  - `strategy_optimize` — 策略优化 (`evolution/strategyOptimize.ts`)
  - `tool_create` — 工具创建 (`evolution/toolCreate.ts`)
  - `self_evaluate` — 自我评估 (`evolution/selfEvaluate.ts`)
  - `learn_pattern` — 模式学习 (`evolution/learnPattern.ts`)

### 2.12 ToolSearch 延迟加载
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/search/toolSearch.ts` + `toolSearchService.ts` + `deferredTools.ts`
- **描述**: 工具按需加载，减少启动时 token 消耗

### 2.13 工具 DAG 调度器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/toolExecution/dagScheduler.ts`
- **描述**: 基于文件依赖的 DAG 调度 — WAR/WAW 依赖检测, Kahn 算法拓扑排序, 分层并行执行。无依赖时零开销快速路径

### 2.14 并行策略
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/toolExecution/parallelStrategy.ts`
- **描述**: 工具调用分类(并行安全/写入/验证), 最大化并行度

### 2.15 Decorated Tools (装饰器模式)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/decorated/` + `src/main/tools/decorators/`
- **描述**: TypeScript 装饰器定义工具，含 builder/description/param/tool 装饰器。BashTool, GlobTool, ReadFileTool 使用此模式

### 2.16 动态 Bash 描述
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/shell/dynamicDescription.ts`
- **描述**: 通过 GLM-4.7-Flash 为 bash 命令生成 5-10 词描述，与命令执行并行不增加延迟, LRU 缓存

---

## 3. 多 Agent 架构

### 3.1 三层混合架构
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/hybrid/`

#### Layer 1: 核心角色 (4 个，覆盖 80%)
- **关键文件**: `src/main/agent/hybrid/coreAgents.ts:26`
- **角色**: coder(编码+调试), reviewer(审查+测试), explore(搜索，只读), plan(规划+架构)
- **模型层级**: fast(GLM-4.7-Flash) / balanced(GLM-5, 0ki包年套餐) / powerful(Kimi K2.5)

#### Layer 2: 动态扩展 (按需生成，覆盖 15%)
- **关键文件**: `src/main/agent/hybrid/dynamicFactory.ts`
- **描述**: 任务 → 模型分析 → 生成专用 Agent（如 db-designer, sql-optimizer）

#### Layer 3: Agent Swarm (复杂任务，覆盖 5%)
- **关键文件**: `src/main/agent/hybrid/agentSwarm.ts:1`
- **描述**: 最多 50 个并行 Agent + 稀疏汇报协议 + 协调器聚合 + DAG 依赖管理 + 冲突检测

### 3.2 智能路由器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/hybrid/taskRouter.ts:1`
- **描述**: 分析任务复杂度(simple/moderate/complex) → 路由到 core/dynamic/swarm 三种决策类型

### 3.3 团队通信 (TeammateService)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/teammate/teammateService.ts`
- **描述**: Agent 间 P2P 通信 — coordinate/handoff/query/broadcast/respond, 订阅 Agent 消息流

### 3.4 团队持久化
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/teammate/teamPersistence.ts` + `teamManager.ts`
- **描述**: 团队/任务状态写入 `.code-agent/teams/<id>/` — config.json, tasks.json, findings.json, checkpoint.json。原子写入，支持 session 中断恢复

### 3.5 任务自管理 (TaskList)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/taskList/` (TaskListManager + IPC handlers)
- **描述**: 4 核心角色可自行查看/认领/完成/创建任务。coder/reviewer/plan 读写权限, explore 只读

### 3.6 优雅关闭协议
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/shutdownProtocol.ts:50`
- **描述**: 4 阶段关闭 — Signal(abort) → Grace(5s 等待工具完成) → Flush(持久化 findings) → Force(返回 partial results)

### 3.7 跨 Agent 审批 (PlanApproval)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/planApproval.ts:54`
- **描述**: 高风险操作(文件删除/破坏性命令/写入工作目录外)需 Coordinator 审批。风险评估 + 串行审批队列，低风险自动批准

### 3.8 Worker 进程隔离
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/worker/agentWorkerManager.ts` + `permissionProxy.ts` + `teammateProxy.ts` + `workerMonitor.ts`
- **描述**: 子 Agent 进程级隔离 — Worker 管理器, 权限代理, 团队通信代理, Worker 监控

### 3.9 Subagent 管线
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/subagentExecutor.ts` + `subagentPipeline.ts` + `subagentContextBuilder.ts` + `subagentCompaction.ts`
- **描述**: 子代理执行管线 — 上下文注入, 管线编排, 上下文压缩

### 3.10 Parallel Agent Coordinator
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/parallelAgentCoordinator.ts`
- **描述**: 并行 Agent 协调器，管理多个 Agent 并行执行

### 3.11 Dynamic Agent Factory
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/dynamicAgentFactory.ts` + `autoAgentCoordinator.ts` + `agentRequirementsAnalyzer.ts`
- **描述**: 根据任务需求动态生成 Agent, 自动协调, 需求分析

---

## 4. 上下文管理

### 4.1 AutoCompressor 自动压缩
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/autoCompressor.ts:86`
- **描述**: 接近 token 上限时自动压缩。双阈值(warning 0.6 / critical 0.85), 绝对 token 阈值(100K), 3 种策略(truncate/code_extract/ai_summary), CompactionBlock 可审计摘要

### 4.2 CompactionBlock 系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/autoCompressor.ts` (compactToBlock/shouldWrapUp/getCompactionCount)
- **描述**: Claude 风格可审计摘要块 — 保留在消息历史中, pauseAfterCompaction 支持 PreCompact Hook 注入保留内容, shouldWrapUp() 基于 compaction 次数判断总预算

### 4.3 TokenOptimizer 优化器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/tokenOptimizer.ts:1`
- **描述**: 工具结果压缩(阈值 300 → 目标 200 tokens), Hook 消息去重缓冲, 消息历史压缩器, xlsx 输出智能压缩

### 4.4 源数据锚定 (DataFingerprint)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/dataFingerprint.ts:1`
- **描述**: 防多轮幻觉 — read_xlsx 提取 schema+样本+数值范围, bash 提取统计摘要, read_file 提取 CSV/JSON schema。双注入点(autoCompressor PreCompact + agentLoop compaction recovery)。LRU 上限 20 条

### 4.5 文档上下文抽象层 (DocumentContext)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/documentContext/`
- **描述**: 统一结构化文档理解 — 5 种解析器(Code/Markdown/Excel/Docx/Pdf), 每个 section 带 importance 权重(0-1), 压缩时优先保留高权重内容

### 4.6 Token 估算器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/tokenEstimator.ts`
- **描述**: 精确 token 估算

### 4.7 AI 摘要模型
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/compactModel.ts`
- **描述**: 增强摘要 + 自定义 instructions 参数，Claude 风格(状态/下一步/关键决策)

### 4.8 Context Health Service
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/contextHealthService.ts`
- **描述**: 上下文健康度监控

### 4.9 Code Preserver
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/codePreserver.ts`
- **描述**: 压缩时保留关键代码片段

### 4.10 Reminder Budget
- **状态**: ✅ 已实现
- **关键文件**: `src/main/context/reminderBudget.ts`
- **描述**: 提醒注入的 token 预算控制

### 4.11 File Read Tracker
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/fileReadTracker.ts`
- **描述**: 追踪最近读取的文件列表, compaction 后注入恢复上下文

---

## 5. 模型管理

### 5.1 ModelRouter 路由器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/modelRouter.ts:49`
- **描述**: 统一模型调用入口，根据 provider 路由到对应实现。集成 InferenceCache + AdaptiveRouter

### 5.2 Provider 实现 (12 种)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/providers/`
- **Provider 列表**:
  - `moonshot` — Kimi K2.5 SSE 流式 (`moonshot.ts` + `moonshotProvider.ts`) — 限流器(默认并发2)
  - `zhipu` — 智谱 GLM 系列 (`zhipu.ts`) — 限流器(默认并发4, 0ki包年套餐)
  - `deepseek` — DeepSeek V3 (`deepseek.ts`) — reasoning_content → thinking 映射
  - `anthropic` — Claude (`anthropic.ts`)
  - `openai` — OpenAI (`baseOpenAIProvider.ts`)
  - `openai-compatible` — OpenAI 兼容 (`openai-compatible.ts`)
  - `gemini` — Google Gemini (`gemini.ts`)
  - `openrouter` — OpenRouter (`openrouter.ts`)
  - `cloud-proxy` — 云端代理 (`cloud-proxy.ts`)
  - 共享: `retryStrategy.ts`(瞬态错误检测), `sseStream.ts`(SSE 流处理), `shared.ts`

### 5.3 自适应路由 (AdaptiveRouter)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/adaptiveRouter.ts:18`
- **描述**: 简单任务(score<30)自动路由到免费模型(zhipu/glm-4.7-flash), 失败自动 fallback, 持久性错误后禁用

### 5.4 推理缓存 (InferenceCache)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/inferenceCache.ts:18`
- **描述**: 非流式请求 LRU 缓存, key = md5(last 3 messages + provider + model), 只缓存 text 响应, 默认 50 条 5 分钟 TTL

### 5.5 模型热切换 (ModelSessionState)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/session/modelSessionState.ts`
- **描述**: 用户对话中途 UI 切换模型, 下一轮生效不中断当前轮

### 5.6 Provider Registry
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/providerRegistry.ts`
- **描述**: 所有 Provider 的注册信息, 模型能力声明, 上下文窗口

### 5.7 Model Validator
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/modelValidator.ts`
- **描述**: 模型配置验证

### 5.8 Quick Model
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/quickModel.ts`
- **描述**: 快速模型调用(用于动态描述、摘要等辅助任务)

### 5.9 SSE 流式处理
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/providers/sseStream.ts`
- **描述**: 原生 https 模块处理 SSE — 按 `\n` 分割 buffer, 忽略注释行, 处理 `[DONE]` 结束标记

### 5.10 重试策略
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/providers/retryStrategy.ts`
- **描述**: 瞬态错误检测(TRANSIENT_CODES), 指数退避自动重试, errCode 支持

### 5.11 实时成本流
- **状态**: ✅ 已实现
- **关键文件**: `src/main/model/providers/moonshot.ts` + `zhipu.ts` (token 估算)
- **描述**: SSE 流式响应期间每 500ms 估算 token, StatusBar 实时更新

---

## 6. 安全模块

### 6.1 InputSanitizer 注入检测
- **状态**: ✅ 已实现
- **关键文件**: `src/main/security/inputSanitizer.ts:71`
- **描述**: 外部数据进入 agent 上下文前检测 prompt injection。20+ 正则模式, 4 种检测类别(instruction_override/jailbreak/data_exfiltration/prompt_injection), 3 种模式(strict/moderate/permissive), 风险评分 0-1

### 6.2 Injection Patterns
- **状态**: ✅ 已实现
- **关键文件**: `src/main/security/patterns/injectionPatterns.ts`
- **描述**: 20+ 检测正则模式库

### 6.3 Sensitive Detector
- **状态**: ✅ 已实现
- **关键文件**: `src/main/security/sensitiveDetector.ts`
- **描述**: API Keys, AWS 凭证, GitHub Tokens, 私钥, 数据库 URL 自动检测

### 6.4 Audit Logger 审计日志
- **状态**: ✅ 已实现
- **关键文件**: `src/main/security/auditLogger.ts`
- **描述**: 操作审计日志, 输出到 `~/.code-agent/audit/YYYY-MM-DD.jsonl`

### 6.5 Command Monitor 命令监控
- **状态**: ✅ 已实现
- **关键文件**: `src/main/security/commandMonitor.ts`
- **描述**: 危险命令监控

### 6.6 Log Masker 日志脱敏
- **状态**: ✅ 已实现
- **关键文件**: `src/main/security/logMasker.ts`
- **描述**: 日志中的敏感信息自动脱敏

### 6.7 确认门控 (ConfirmationGate)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/confirmationGate.ts`
- **描述**: 写操作前展示 before/after 预览 + 确认对话框。4 种策略: always_ask / always_approve / ask_if_dangerous / session_approve

### 6.8 Sandbox 沙盒
- **状态**: ✅ 已实现
- **关键文件**: `src/main/sandbox/` (bubblewrap.ts, seatbelt.ts, manager.ts)
- **描述**: macOS Seatbelt + Linux Bubblewrap 沙盒执行

---

## 7. Prompt 系统

### 7.1 代际 Prompt (gen1-gen8)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/base/gen1.ts` ~ `gen8.ts`
- **描述**: 8 代渐进式 prompt, gen8 含工具选择决策树 + 3 种执行模式(直接/分步/规划)。Token 减少 81%(gen8: 7992→1485)

### 7.2 Identity Prompt
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/identity.ts`
- **描述**: 替代原 constitution/ 6 文件, 包含 TOOL_DISCIPLINE 规则

### 7.3 Orchestrator Prompt
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/base/orchestrator.ts`
- **描述**: 协调者身份和工作流定义

### 7.4 工具描述 Prompt
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/tools/bash.ts`, `edit.ts`, `task.ts`
- **描述**: Claude Code 风格工具描述 — 明确边界 + 交叉引用 + 后果说明 + 正确/错误示例

### 7.5 Constitution 伦理系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/constitution/` (ethics.ts, safety.ts, values.ts, judgment.ts, hardConstraints.ts, soul.ts)
- **描述**: 6 维度伦理约束

### 7.6 Rules 规则系统 (17 规则)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/rules/`
- **描述**: 附件处理, 代码引用, 代码片段, 错误处理, Git 安全, GitHub 路由, HTML 生成, 注入防御, 输出格式, 并行工具, 计划模式, 专业客观性, 任务分类, 任务管理, 工具决策树, 工具使用策略

### 7.7 Injection Defense 注入防御
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/rules/injection/` (core.ts, meta.ts, verification.ts)
- **描述**: prompt 级注入防御规则

### 7.8 动态提示系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/dynamicReminders.ts` + `contextAwareReminders.ts` + `reminderRegistry.ts`
- **描述**: 上下文感知的动态提示, 条件触发提醒, 提醒注册表

### 7.9 Few-Shot Examples
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/fewShotExamples.ts`
- **描述**: 任务类型示例管理

### 7.10 System Reminders
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/systemReminders.ts`
- **描述**: 系统级提醒注入

### 7.11 Agent Modes
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/agentModes.ts`
- **描述**: 动态 Agent 模式(normal 等)

### 7.12 Prompt Builder
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/builder.ts`
- **描述**: getPromptForTask + buildDynamicPrompt + buildDynamicPromptV2

### 7.13 Reminder Deduplicator
- **状态**: ✅ 已实现
- **关键文件**: `src/main/generation/prompts/reminderDeduplicator.ts`
- **描述**: 防止重复提醒注入

---

## 8. 技能层

### 8.1 PPT 生成系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/network/ppt/` (30+ 文件)
- **描述**: 模块化 PPT 生成 — 9 主题(含 apple-dark), 原生 addChart(可编辑), Slide Master 声明式布局, 137 个测试用例。含 parser/designExecutor/layoutTemplates/themes/charts/typography/spacing/preview/narrativeValidator/researchAgent/slideContentAgent/parallelPptEngine

### 8.2 Excel 分析/编辑
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/network/readXlsx.ts` + `xlwingsExecute.ts` + `excelGenerate.ts`
- **描述**: read_xlsx(含数据指纹), xlwings 自动化, excel_generate 生成

### 8.3 数据清洗 Skill
- **状态**: ✅ 已实现
- **关键文件**: `src/main/services/skills/builtinSkills.ts`
- **描述**: 内置 data-cleaning skill, 6 步系统性清洗检查清单(结构→重复→缺失→格式→异常→验证)

### 8.4 Skill 系统架构
- **状态**: ✅ 已实现
- **关键文件**: `src/main/services/skills/` (11 文件)
- **描述**: 技能发现/加载/解析/桥接/仓库管理/关键词映射。含 git 下载器, skill 监控, session 级服务

### 8.5 Skill Marketplace
- **状态**: ✅ 已实现
- **关键文件**: `src/main/skills/marketplace/`
- **描述**: 技能市场 — 安装/发现/管理

### 8.6 Deep Research Mode
- **状态**: ✅ 已实现
- **关键文件**: `src/main/research/` (14 文件)
- **描述**: 深度研究模式 — ResearchPlanner(计划生成) → ResearchExecutor(执行) → ReportGenerator(报告)。含意图分类, 自适应配置, 数据源路由, 渐进式循环, 搜索降级, 结果聚合, 语义编排

### 8.7 PDF 压缩
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/network/pdfCompress.ts`
- **描述**: PDF 压缩工具, 支持质量/分辨率/灰度参数

### 8.8 Document Generation (Word/PDF)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/tools/network/docxGenerate.ts` + `pdfGenerate.ts`
- **描述**: Word 和 PDF 文档生成

---

## 9. CLI 模式

### 9.1 CLI 入口
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/index.ts` + `bootstrap.ts`
- **描述**: 命令行入口, 服务初始化, Electron mock

### 9.2 Chat 命令 (交互模式)
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/commands/chat.ts:15`
- **描述**: 交互式对话 — 会话恢复(-s/--session, -r/--resume), PR 关联(--from-pr), 动态工具调用上限(calculateToolCallMax)

### 9.3 Run 命令 (单次执行)
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/commands/run.ts`
- **描述**: 单次任务执行模式

### 9.4 Export 命令
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/commands/export.ts`
- **描述**: 会话导出

### 9.5 Serve 命令
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/commands/serve.ts`
- **描述**: HTTP API 服务模式

### 9.6 CLI Adapter
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/adapter.ts`
- **描述**: CLI Agent 适配层, 桥接 CLI ↔ AgentOrchestrator

### 9.7 CLI Database
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/database.ts`
- **描述**: CLI 模式数据库(better-sqlite3)

### 9.8 Terminal Output
- **状态**: ✅ 已实现
- **关键文件**: `src/cli/output/`
- **描述**: CLI 终端格式化输出

---

## 10. 前端能力

### 10.1 DAG 可视化
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/features/workflow/` (DAGViewer.tsx, TaskNode.tsx, DependencyEdge.tsx, WorkflowPanel.tsx)
- **描述**: React Flow DAG 实时展示执行状态, 任务节点+依赖边+详情面板+自动布局

### 10.2 Swarm 监控
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/features/swarm/SwarmMonitor.tsx`
- **描述**: 实时 Agent 状态/统计/Token 用量监控

### 10.3 Agent Team 面板
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/features/agentTeam/AgentTeamPanel.tsx`
- **描述**: Agent 团队协作视图, 直接与任意 agent 对话, 任务分配概览

### 10.4 Diff 面板
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/DiffPanel/` + `DiffView.tsx`
- **描述**: 会话级变更追踪, unified diff, 按 session/message/file 查询

### 10.5 引用列表 (Citations)
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/citations/`
- **描述**: 可点击引用标签(file/url/cell/query/memory), 颜色编码

### 10.6 评测中心 (EvalCenter)
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/features/evalCenter/` (12 组件)
- **描述**: EvalDashboard, GraderCard, GraderGrid, MetricStrip, ScoreSummary, SessionListView, TurnTimeline, ErrorTags 等

### 10.7 实验室 (Lab)
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/features/lab/`
- **描述**: LLaMA Factory 微调教学, NanoGPT 2.0 训练, SFT & RLHF 对齐

### 10.8 StatusBar 组件集
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/StatusBar/`
- **描述**: TokenUsage 脉冲动画, CostDisplay 实时更新, ModelSwitcher 模型选择

### 10.9 Context Health Panel
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/ContextHealthPanel.tsx`
- **描述**: 上下文健康度可视化

### 10.10 命令面板 (CommandPalette)
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/CommandPalette.tsx`
- **描述**: Cmd+K 命令面板

### 10.11 Planning Panel
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/PlanningPanel.tsx`
- **描述**: 计划可视化

### 10.12 TodoPanel/TodoBar
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/TodoPanel.tsx` + `TodoBar.tsx`
- **描述**: TODO 面板和进度条

### 10.13 TaskListPanel
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/TaskListPanel.tsx`
- **描述**: 可视化任务追踪

### 10.14 SkillsPanel
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/SkillsPanel.tsx`
- **描述**: 技能管理面板

### 10.15 Zustand 状态管理 (15 stores)
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/stores/`
- **Store 列表**: appStore, authStore, captureStore, dagStore, evalCenterStore, modeStore, permissionStore, sessionStore, skillStore, statusStore, swarmStore, taskStore, telemetryStore, uiStore

### 10.16 Settings/Auth/Permission 模态框
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/SettingsModal.tsx`, `AuthModal.tsx`, `PermissionDialog/`, `PermissionModal.tsx`

### 10.17 会话管理 UI
- **状态**: ✅ 已实现
- **关键文件**: `src/renderer/components/Sidebar.tsx`, `ChatView.tsx`

### 10.18 其他 UI 组件
- **状态**: ✅ 已实现
- AlertBanner, ErrorBoundary, ErrorDisplay, NetworkStatus(ErrorsPanel), ExportModal(features/export), ForceUpdateModal, UpdateNotification, UserQuestionModal, ConfirmActionModal, ConfirmModal, PreviewPanel, WorkspacePanel, FindingsPanel, ObservabilityPanel, CloudTaskList/CloudTaskPanel

---

## 11. 基础设施

### 11.1 DI 容器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/core/container.ts:1`
- **描述**: 轻量级依赖注入 — Singleton/Factory/Transient 生命周期, 异步初始化(Initializable), 优雅关闭(Disposable), ServiceToken 类型安全

### 11.2 DAG 调度器 (Task Level)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/scheduler/DAGScheduler.ts:1` + `TaskDAG.ts` + `dagEventBridge.ts`
- **描述**: 基于有向无环图的并行任务调度 — Kahn 算法, 支持 agent/shell/workflow/checkpoint/conditional 任务类型, fail-fast/continue/retry-then-continue 失败策略

### 11.3 Checkpoint 系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/services/checkpoint/FileCheckpointService.ts:18`
- **描述**: 文件版本快照 — createCheckpoint/rewind, 1MB 大文件跳过, 50 个/session 上限, 7 天保留

### 11.4 错误恢复引擎
- **状态**: ✅ 已实现
- **关键文件**: `src/main/errors/recoveryEngine.ts`
- **描述**: 6 种错误模式自动恢复 — RATE_LIMIT(指数退避), PERMISSION(引导设置), CONTEXT_LENGTH(自动压缩), TIMEOUT(切换 provider), CONNECTION(自动重试), MODEL_UNAVAILABLE(切换 provider)

### 11.5 错误分类器
- **状态**: ✅ 已实现
- **关键文件**: `src/main/errors/errorClassifier.ts`
- **描述**: 错误自动分类

### 11.6 恢复策略 (3 种)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/agent/recovery/`
- **描述**: decompositionStrategy(任务分解), degradationStrategy(功能降级), learningStrategy(学习型恢复)

### 11.7 Hooks 系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/hooks/hookManager.ts` + 10 文件
- **描述**: 11 种事件(PreToolUse/PostToolUse/SessionStart/SessionEnd/Stop/SubagentStart/PermissionRequest/Compact 等), 脚本执行 + prompt hook + 内置 hook, 多源合并策略

### 11.8 Planning 系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/planning/` (14 文件)
- **描述**: planningService, autoPlanner, planManager, planPersistence, executionMonitor(进度监控), feasibilityChecker(可行性评估), taskComplexityAnalyzer(复杂度分析), errorTracker, findingsManager, hooksEngine

### 11.9 会话评测系统 v3 (Swiss Cheese)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/evaluation/swissCheeseEvaluator.ts:1` + 7 文件
- **描述**: 瑞士奶酪多层评测 — 7 个计分维度(outcome_verification, code_quality, security, tool_efficiency 等) + 3 个信息维度, 结构化 Transcript 输入, 代码 Grader(self_repair, verification_quality, forbidden_patterns), LLM 评审员, Kimi K2.5 并发执行

### 11.10 多渠道接入
- **状态**: ✅ 已实现
- **关键文件**: `src/main/channels/` (channelManager.ts, api/, feishu/)
- **描述**: 通道管理器 — 插件注册/账号管理/消息路由。支持 API 通道 + 飞书 Webhook

### 11.11 MCP 协议支持
- **状态**: ✅ 已实现
- **关键文件**: `src/main/mcp/` (mcpClient.ts, mcpServer.ts, inProcessServer.ts, logBridge.ts, logCollector.ts)
- **描述**: MCP 客户端+服务端双向支持, 进程内服务器, 日志桥接

### 11.12 Memory 记忆系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/memory/` (24 文件)
- **描述**: 向量存储(localVectorStore/unifiedVectorStore), 嵌入服务, 混合搜索(hybridSearch), 记忆衰减(memoryDecay), 持续学习(continuousLearning), 模式提取(patternExtractor), 技能合成(skillSynthesizer), 文件追踪, 会话摘要, 上下文注入, 主动上下文(proactiveContext), 增量同步, 错误学习

### 11.13 Evolution 自我进化
- **状态**: ✅ 已实现
- **关键文件**: `src/main/evolution/` (traceRecorder.ts, outcomeDetector.ts, safeInjector.ts, llmInsightExtractor.ts, skillEvolutionService.ts)
- **描述**: 执行轨迹记录 → 结果检测 → LLM 洞察提取 → 安全注入 → 技能进化。含 metaLearningLoop, capabilityGapDetector

### 11.14 Telemetry 遥测
- **状态**: ✅ 已实现
- **关键文件**: `src/main/telemetry/` (telemetryCollector.ts, telemetryStorage.ts, systemPromptCache.ts, intentClassifier.ts)
- **描述**: 遥测收集+存储, system prompt 缓存, 意图分类

### 11.15 Plugin 插件系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/plugins/` (pluginLoader.ts, pluginRegistry.ts, pluginStorage.ts)
- **描述**: 插件加载/注册/存储

### 11.16 Graph Store
- **状态**: ✅ 已实现
- **关键文件**: `src/main/graph/` (store/, types/)
- **描述**: 图数据存储

### 11.17 Routing 路由服务
- **状态**: ✅ 已实现
- **关键文件**: `src/main/routing/routingService.ts`
- **描述**: Agent 路由服务

### 11.18 统一配置管理
- **状态**: ✅ 已实现
- **关键文件**: `src/main/config/`
- **描述**: `.code-agent/` 统一配置目录(settings.json/hooks/skills/agents/mcp.json), 向后兼容 `.claude/`

### 11.19 Session 管理
- **状态**: ✅ 已实现
- **关键文件**: `src/main/session/` (10 文件)
- **描述**: 会话状态管理, 后台任务管理, 成本报告, Markdown 导出, 会话 fork, 本地缓存, 恢复, 搜索, transcript 导出

### 11.20 基础设施服务
- **状态**: ✅ 已实现
- **关键文件**: `src/main/services/infra/` (14 文件)
- **描述**: 磁盘空间监控, 结构化文件日志(自动轮转), 优雅关闭, 超时控制器, 浏览器服务, Langfuse 集成, 通知服务, Shell 环境, Supabase 集成, 工具缓存

### 11.21 引用溯源 (Citation)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/services/citation/citationExtractor.ts` + `citationService.ts`
- **描述**: 工具执行后自动提取引用源(文件行号/URL/单元格/查询/记忆), 5 种引用类型

### 11.22 变更追踪 (DiffTracker)
- **状态**: ✅ 已实现
- **关键文件**: `src/main/services/diff/diffTracker.ts`
- **描述**: 文件修改产生结构化 unified diff, 会话级持久化

### 11.23 Cowork 协作框架
- **状态**: ✅ 已实现
- **关键文件**: `src/main/cowork/`
- **描述**: 协作框架

### 11.24 Cron 定时任务
- **状态**: ✅ 已实现
- **关键文件**: `src/main/cron/`
- **描述**: 定时任务系统

### 11.25 LSP 集成
- **状态**: ✅ 已实现
- **关键文件**: `src/main/lsp/`
- **描述**: Language Server Protocol 集成

### 11.26 Permissions 权限系统
- **状态**: ✅ 已实现
- **关键文件**: `src/main/permissions/`
- **描述**: 权限管理

### 11.27 数据安全
- **状态**: ✅ 已实现
- **关键文件**: `src/main/services/infra/` (atomicWrite)
- **描述**: 文件写入原子性保证, 带超时 IPC, 数据库事务并发控制(乐观锁)

---

## 12. 共享层

### 12.1 常量中心
- **状态**: ✅ 已实现
- **关键文件**: `src/shared/constants.ts`
- **描述**: 所有配置常量集中管理 — DEFAULT_GENERATION, DEFAULT_PROVIDER, DEFAULT_MODEL, MODEL_API_ENDPOINTS, TIMEOUTS, MODEL_PRICING, CONTEXT_WINDOWS, MODEL_MAX_TOKENS 等

### 12.2 类型定义
- **状态**: ✅ 已实现
- **关键文件**: `src/shared/types/`
- **描述**: taskDAG.ts, builtInAgents.ts, workflow.ts, citation.ts, confirmation.ts, diff.ts, swarm.ts, agent.ts, evaluation.ts, contextHealth.ts, message.ts(CompactionBlock), channel.ts 等

### 12.3 IPC 通信
- **状态**: ✅ 已实现
- **关键文件**: `src/shared/ipc.ts` + `src/main/ipc/`
- **描述**: Electron IPC channels 定义, 含 DAG/Swarm/Session/Error/Diff 等 domain

---

## 统计摘要

| 维度 | 能力项数 | 关键文件数 |
|------|---------|-----------|
| Agent Loop 核心循环 | 17 | ~15 |
| 工具系统 (8 代) | 16 (70+ 工具) | ~80 |
| 多 Agent 架构 | 11 | ~20 |
| 上下文管理 | 11 | ~15 |
| 模型管理 | 11 | ~20 |
| 安全模块 | 8 | ~10 |
| Prompt 系统 | 13 | ~30 |
| 技能层 | 8 | ~50 |
| CLI 模式 | 8 | ~10 |
| 前端能力 | 18 | ~30 |
| 基础设施 | 27 | ~60 |
| 共享层 | 3 | ~10 |
| **总计** | **~151** | **~350** |
