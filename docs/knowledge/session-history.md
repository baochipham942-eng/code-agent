# 会话历史记录

## 2026-03-19 (session 19): SpreadsheetBlock 交互式电子表格

- 新增 SpreadsheetBlock 组件 — Excel 数据在对话中可交互渲染
- **列选中交互**: 点击列头选中（Cmd+点击多选），选中列高亮 + 数值列统计（合计/均值/范围）
- **操作栏**: 可视化、透视表、筛选分析、排序 — 点击后通过 iact:send 把选区数据发给 Agent
- **Agent 闭环**: Agent 收到选区数据 → 生成 chart/generative_ui/spreadsheet 块 → 内联渲染
- **Excel 上传增强**: 新增 `extract-excel-json` IPC（SheetJS → JSON），上传 Excel 自动渲染 SpreadsheetBlock（替代纯文本标签）
- **双通道数据**: CSV 文本（给 Agent 理解）+ JSON（给 SpreadsheetBlock 渲染），sheetsJson 存入 MessageAttachment
- **Agent prompt**: generativeUI.ts 扩展教模型输出 ```spreadsheet 代码块
- **全链路**: IPC handler + Web route + httpTransport + ipcService + AttachmentPreview + MessageContent 路由
- 新增 1 文件 + 修改 10 文件, typecheck 零错误
- 关键新文件: SpreadsheetBlock.tsx
- 关键修改: settings.ipc.ts, extract.ts, api.ts, ipcService.ts, httpTransport.ts, message.ts, useFileUpload.ts, AttachmentPreview.tsx, MessageContent.tsx, generativeUI.ts

## 2026-03-19 (session 18): 富文档结构化编辑 — Excel/PPT/Word 原子操作 + 统一 DocEdit

- 对标阿里悟空 RealDoc 设计理念，从"全量生成"升级为"原子级 patch"
- **P1 Excel 原子编辑**: excelEdit.ts — 14 种操作（set_cell/range/formula, insert/delete rows/columns, style, sheet 管理），接入 ExcelAutomateTool 的 `edit` action
- **P3 SnapshotManager**: snapshotManager.ts — 统一文档快照层（.doc-snapshots/），编辑前自动快照，失败自动回滚，最多保留 20 个/文件
- **P2 PPT 编辑加固**: editTool.ts +2 新操作（reorder_slides, update_notes），从内联 backup 迁移到 SnapshotManager
- **P5 统一 DocEdit 入口**: docEditTool.ts — 自动识别文件扩展名路由到 Excel/PPT/Word 引擎
- **P4 Word 增量编辑**: docxEdit.ts — 7 种操作（replace_text, replace/insert/delete/append paragraph, heading, text style），JSZip 操作 word/document.xml
- Token 节省: ~80%（原子操作 vs 全量重写）
- 新增 4 文件 + 修改 6 文件, +1128 行, typecheck 零错误
- 关键新文件: excelEdit.ts, snapshotManager.ts, docxEdit.ts, docEditTool.ts
- 关键修改: excelAutomate.ts, editTool.ts, toolRegistry.ts, deferredTools.ts

## 2026-03-18~19 (session 17): FloatBoat 启发特性 Phase 1-4

- 基于 FloatBoat AI 分析，实施 4 个 Phase 的功能改造
- **Phase 1**: IACT 扩展指令（!run/!open/!preview/!copy）+ Agent contextModifier 引导
- **Phase 2**: react-resizable-panels 三栏可拖拽布局 + FileExplorerPanel 文件浏览器（多标签、树形浏览、拖拽到 Chat）+ explorerStore
- **Phase 3**: Combo Skills 录制 — comboRecorder.ts 订阅 EventBus `agent:tool_call_end`，自动检测可复用工作流，ComboSkillCard 前端建议卡片，6 个 IPC 通道
- **Phase 4**: Tauri System Tray（MenuBuilder 菜单：新建对话/粘贴上下文/退出）+ 全局快捷键 Cmd+Shift+A（tauri-plugin-global-shortcut）+ MemoFloater 浮窗（通过 iact:send 复用 ChatInput 管道）
- react-resizable-panels API 踩坑：导出名为 Group/Panel/Separator（非 PanelGroup/PanelResizeHandle），用 orientation（非 direction），Panel 必须是 Group 直接子元素
- Tauri 2.x tray API 踩坑：MenuBuilder.text()/separator()/quit() 链式调用，TrayIconBuilder.on_menu_event() 3 参数闭包
- 新增依赖: react-resizable-panels, @tauri-apps/api@^2, tauri-plugin-global-shortcut
- 关键新文件: FileExplorerPanel.tsx, explorerStore.ts, comboRecorder.ts, ComboSkillCard.tsx, MemoFloater.tsx
- 关键修改: App.tsx (布局重构+MemoFloater), main.rs (tray+shortcut), Cargo.toml, channels.ts, skill.ipc.ts, agentOrchestrator.ts, initBackgroundServices.ts, ChatInput/index.tsx
- 净变化: 6 新文件 + 8 修改文件, TypeScript typecheck 零错误, cargo check 零错误

## 2026-03-17 (session 16): Generative UI — 图表 + HTML 小程序内联渲染

- 复刻 Claude Code 2026-03-12 Generative UI 能力（对标 Anthropic + op7418/歸藏 实现）
- Phase 1: ChartBlock — Recharts 6 种图表（bar/line/area/pie/radar/scatter），暗色主题，JSON 复制
- Phase 2: GenerativeUIBlock — 沙箱 iframe（sandbox="allow-scripts"），自动注入暗色 CSS + 高度自适应（MutationObserver + postMessage），Source/Preview 切换
- Phase 3: System Prompt 注入（generativeUI.ts）+ Artifact 类型定义 + MessageContent 路由（chart/generative_ui 代码块）
- Bug 修复: Tooltip cursor 在暗色主题下显示浅灰色 → 改为 rgba(255,255,255,0.06)
- 新增依赖: recharts
- 关键文件: ChartBlock.tsx, GenerativeUIBlock.tsx, generativeUI.ts, MessageContent.tsx, message.ts, builder.ts
- 净变化: 3 新文件 + 3 修改文件

## 2026-03-15 (session 15): 桌面活动视觉分析 + Light Memory IPC

- 桌面活动视觉分析: 截图 PNG→JPG（~80% 空间节省）+ 后台智谱 GLM-4V-Plus 生成 analyzeText
- 对标 StepFun（阶跃AI）analyze_text 字段：每次截图后 AI 理解生成自然语言描述
- 新增 desktopVisionAnalyzer.ts（后台轮询未分析截图 → 调视觉 API → 写回 SQLite）
- Rust 侧: DesktopActivityEvent 新增 analyze_text、SQLite 自动迁移、desktop_update_analyze_text 命令
- UI: 详情面板优先展示 AI 分析文本、时间线事件显示分析摘要
- Light Memory IPC: lightMemoryIpc.ts + MemoryTab 重写 + 消息气泡记忆按钮
- 净变化: 9 文件, +833 行

## 2026-03-09 (session 13): Local Bridge 服务 + 产品矩阵 + 平台架构扩展

- Phase 1: packages/bridge/ 独立包 — 12 工具 + 三级权限 + 沙箱 + Auth Token + 6 平台脚本
- Phase 2: Web 前端适配层 — SSE tool_call_local 事件 + LocalBridgeClient + httpTransport 拦截
- Phase 3: 设置页改造 — MCP Tab 本地桥接手风琴 + 产品矩阵 Tab（Web/App/CLI 三端）+ localBridgeStore
- Phase 4: 对话拦截 — LocalBridgePrompt + BridgeUpdatePrompt + DirectoryPickerModal + ChatView 集成
- 三端产品定位: Web（尝鲜）→ App/Tauri（完整体验）→ CLI（极客/Agent 调用）
- 30/30 验收全部 PASS，typecheck 零错误
- 净变化: 52 文件, +3196 行
- 关键文件: packages/bridge/*, localBridge.ts, localBridgeStore.ts, localTools.ts, webServer.ts, httpTransport.ts, ChatView.tsx, MCPSettings.tsx, ProductMatrixSettings.tsx

## 2026-03-09 (session 12): 评测系统多模型交叉审查修复（commit 1a4866d）

- 三模型审查（Codex + Kimi + Gemini）发现 15 个问题，全部修复
- P0: SwissCheese 权重归一化 + 评分配置存而不生效 + 维度名前后端对齐 + 分数尺度全链路统一
- P1: eval-ci --real 安全护栏（--max-cases + 成本预估）+ SVG NaN 守卫 + 权重校验
- P2: logger async stream + Funnel 正则分类 + require→import + 事件名兼容 + IPC 类型安全 + persistenceWarning
- 净变化: 21 文件, +2726/-303 行
- 关键文件: swissCheeseEvaluator.ts, evaluation.ipc.ts, eval-ci.ts, logger.ts, ExperimentDetailPage.tsx, ScoringConfigPage.tsx, CrossExperimentPage.tsx

## 2026-03-08 (session 10): 移除TodoWrite + 7项UI/UX修复 (v0.16.44)

- 移除 TodoWrite 工具（减少模型认知负担 ~300 tokens/轮），改为 agentLoop 自动解析任务
- 新建 todoParser.ts（337行）：parseTodos/mergeTodos/advanceTodoStatus，支持 markdown checkbox 和编号列表格式
- 修复 400 token超限不触发自动压缩：sseStream 改抛 ContextLengthExceededError 而非 generic Error
- UI: 聊天区移除 TodoProgressPanel 横幅（仅保留右侧 TaskInfo）
- UI: 工具调用默认折叠，仅 error 时展开
- UI: 空编辑检测返回"无变化"，跳过 Diff 渲染
- UI: 思考中展示 token 用量（接入 statusStore）
- 意图分类超时 8s→3s 减少首轮延迟
- 净变化: 新建 1 文件 + 改动 28 文件，v0.16.44
- 关键文件: todoParser.ts, agentLoop.ts, sseStream.ts, ChatView.tsx, ToolCallDisplay/index.tsx, editSummarizer.ts

## 2026-03-08 (session 8): Memory 四项增强（BM25+Vector 混合检索）

- Phase 1: entity_relations 时间衰减 — `getRelationsFor()` 新增指数衰减 `0.5^(age/halfLife)`，常量 RELATION_DECAY_DAYS=30
- Phase 2: Embedding 缓存 — Map 升级为 `{vector, ts}` 结构，10 分钟 TTL 避免重复 API 调用
- Phase 3: HybridSearch 接入主读路径 — `buildEnhancedSystemPrompt` 改 async，RAG 从伪向量切到 RRF 融合（BM25 0.4 + Vector 0.6），失败降级旧路径
- Phase 4: 写入前去重 — 新建 memoryDeduplicator.ts（精确匹配→跳过，Jaccard>0.85→合并，其余→写入）
- 验证: 24 PASS / 0 FAIL / 2 SKIP
- 净变化: 新建 1 文件，修改 4 文件 (databaseService.ts, embeddingService.ts, contextBuilder.ts, agentLoop.ts)，constants.ts +3 常量

## 2026-03-08 (session 7): 死代码审查 + 轻量记忆激活

- 审查 graph/ (3.2K行) 和 core/ (1.3K行)：均为零外部调用的死代码
- 删除 core/（IoC 容器，被 ServiceRegistry 替代）：-1,331 行
- graph/（Kuzu 图数据库）保持 pending：531MB 体积 + native module 打包风险
- 轻量方案：激活 3 个沉睡 memory 模块（1,545 行），零新依赖
- Phase 1: databaseService 新增 entity_relations 表 + 4 CRUD 方法
- Phase 2: agentLoop.runSessionEndLearning() 接入 continuousLearningService → patternExtractor 提取模式 → SQLite 写入实体关系
- Phase 3: contextBuilder.buildEnhancedSystemPrompt() 接入 proactiveContext.detectEntities() → SQLite 关系查询 → 注入 system prompt
- 净变化: -1,150 行（删 1,331 + 加 181），激活 1,545 行沉睡代码
- 关键文件: databaseService.ts, agentLoop.ts, contextBuilder.ts

## 2026-03-08 (session 6): 上下文分层压缩增强 — Observation Masking + Handoff Prompt

- P0: tokenOptimizer.ts 新增 observationMask() 函数（L1 分层压缩），用 placeholder 替换旧 tool result，保留 tool call 骨架，避免再搜索循环（借鉴 JetBrains Junie）
- P1: 3 处摘要 prompt 统一改为 Codex "handoff" 框架（5 段结构 + 6 条规则），压缩产物加 [Context Handoff] 接力前缀（借鉴 Codex CLI）
- autoCompressor.ts 集成三层递进策略：L1 Masking (≥60%) → L2 Truncate (≥85%) → L3 AI Summary (≥80%)
- constants.ts 新增 OBSERVATION_MASKING 常量
- 关键文件: tokenOptimizer.ts, autoCompressor.ts, constants.ts

## 2026-03-08 (session 5): Tool Schema 对齐 — 阶段 1 补完 + 阶段 2 收尾

- 阶段 1: 8 个核心工具 name 字段从 snake_case 改为 PascalCase（read_file→Read, write_file→Write, edit_file→Edit, bash→Bash, glob→Glob, grep→Grep, web_search→WebSearch, ask_user_question→AskUserQuestion）
- Edit 参数对齐: old_string→old_text, new_string→new_text（execute 函数含向后兼容）
- 8 个旧名 alias 添加到 TOOL_ALIASES（向后兼容已存储对话）
- 阶段 2: 移除 20 个旧工具独立注册（process/mcp/task/plan/browser/computer 等），仅保留 alias 指向 Phase 2 统一工具
- gen8.ts + systemReminders.ts 工具名引用更新
- 前端 14 文件 + 后端 14 文件同步（新旧双名支持）
- CORE_TOOLS 更新为 PascalCase（13 个核心工具）
- 最终: 注册 70, 别名 48, 核心 13, 延迟 49
- typecheck 零错误
- 关键文件: 8 个工具定义文件, toolRegistry.ts, deferredTools.ts, gen8.ts, systemReminders.ts

## 2026-03-08 (session 4): Module Surgery Sprint 3 + Deferred 工具合并精简

- 3.1 Trajectory 接入 (6518be5): EvaluationResult 新增 trajectoryAnalysis?；EvaluationService 评测后 dynamic import trajectory 分析
- 3.2 ServiceRegistry (39784f8): 轻量服务注册表（register/disposeAll/resetAll），5 个核心服务添加 Disposable 支持
- 3.3 SSE 流式补全 (ba00ddc): channelAgentBridge 从"等完成后一次性返回"改为真正 SSE 流式推送
- 3.4 测试修复: 16 个测试文件同步 PascalCase 工具重命名，108 个失败→0
- Deferred 工具合并: 9 组合并（31→9 统一工具），Deferred 条目 73→51, 注册 90→99, 别名 24 条
- 关键文件: EvaluationService.ts, replayService.ts, serviceRegistry.ts, channelAgentBridge.ts, 9 个统一工具文件

## 2026-03-08 (session 3): Tool Schema 对齐 Claude Code — 阶段 1 核心工具重命名

- 11 个核心工具从 snake_case 重命名为 PascalCase
- multi_edit_file 合入 Edit（edits[] 批量模式）
- TOOL_ALIASES 映射所有旧名到新名
- 批量 sed 替换 297 个源文件 + 手动修正 5 处 sed 误伤
- typecheck 零错误
- 关键文件: toolRegistry.ts, deferredTools.ts, edit.ts, multiEdit.ts, spawnAgent.ts

## 2026-03-08 (session 2): Web 模式 E2E 测试 + 缓存设计优化

- HTTP API 修路: serve.ts 30+ mock 端点替换为真实数据
- Vite Proxy: /api → localhost:3001
- API Key 弹窗缓存 + Auth 登录态缓存 + 面板持久化
- 关键文件: serve.ts, vite.config.ts, authStore.ts, App.tsx, sessionStore.ts, Sidebar.tsx

## 2026-03-08: Module Surgery Sprint 2 + Deep Research Pipeline v2

- Coordinator 合并: parallelAgentCoordinator.ts 删除（659行），统一到 autoAgentCoordinator.ts
- 评估架构统一: 三层 fallback 改为"规则优先 + LLM 增强"叠加模式
- Deep Research: LLM 意图分类、多角度搜索、证据链绑定、搜索从 90-255s 降到 6-9s
- 关键文件: autoAgentCoordinator.ts, agentLoop.ts, intentClassifier.ts, webSearch.ts

## 2026-03-07: Session Replay + 全面体检 + 3 Sprint 优化

- Session Replay 结构化回放（三栏布局 + 工具分类 + 自修复链检测）
- 全面体检: 6 个 Agent 并行审计 8 个维度，综合评分 6.0/10
- Sprint 1-3: 循环依赖修复、AgentLoop 拆分、NudgeManager 提取、70文件 catch any→unknown
- 量化: 98文件, +3543/-1311行, 测试 85 passed / 2016 tests / 0 failed

## 更早的会话记录

- 2026-03-02: UI 四项改进（PermissionCard、ToolGroup、文件路径可点击、会话管理）
- 2026-02-28: ClaudeForge 借鉴 + 配置体系重构 + Codex CLI 深度集成
- 2026-02-26: CodePilot/NanoBanana 对标改造（PPT 增强 + 评测追踪 + Claude Code 互操作）
- 2026-02-19: 图片/视频生成重构 + Web Search 智能过滤与提取
