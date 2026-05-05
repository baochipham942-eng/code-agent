# `as unknown` 审计报告

**Scope**: read-only 调研，0 代码改动
**Base**: `origin/main` @ `4e6cbbff`
**扫描命令**: `grep -rEn "as unknown\b" --include="*.ts" --include="*.tsx" src/`
**总数**: 109 处（用户预估 106，实测 109）
**审计时间**: 2026-05-05

---

## 总览

| 类 | 性质 | 案例数 | 处置建议 |
|---|---|---|---|
| 1. window / global / stream typing 桥接 | 合理 | 11 | 保留 |
| 2. JSON.parse / 外部数据 / Tool params Zod 收窄 | 合理 | 76 | 保留（27 处可优化） |
| 3. 测试 mock typing | 合理 | 1 | 保留 |
| 4. 多余 cast — 类型已存在 | **可疑** | 8 | 直接删 cast |
| 5. 应补类型定义 / type augmentation | **可疑** | 13 | 补类型后删 cast |
| 合计 | | **109** | |

> 注：类 2 中 27 处是 `params: Record<string, unknown>` → `TypedParams` 的工具入参 cast，源自 Zod 校验后的架构模式，本审计判定为合理（见下文「架构模式说明」）。

---

## 类 1：window / global / stream typing 桥接（11 处，合理）

跨 runtime 边界的强制 cast，TS 类型系统覆盖不到。

| # | 文件:行 | 内容 |
|---|---|---|
| 2 | `src/renderer/utils/resolveFileUrl.ts:5` | `window.__CODE_AGENT_TOKEN__` |
| 10 | `src/web/electronMock.ts:465` | Electron `File.path` 扩展 |
| 11 | `src/renderer/api/httpTransport.ts:31` | `window.__CODE_AGENT_TOKEN__` |
| 13 | `src/renderer/services/nativeDesktop.ts:286` | 同上 |
| 16 | `src/main/tools/livePreview/tweakWriter.ts:127` | Babel AST node → JSXOpeningLike |
| 17 | `src/main/tools/livePreview/tweakWriter.ts:132` | AST 动态属性访问 |
| 70 | `src/main/platform/miscCompat.ts:215` | Electron `File.path` 扩展 |
| 81 | `src/main/agent/runtime/contextAssembly/messageBuild.ts:71` | WeakMap key 类型擦除 |
| 82 | `src/main/agent/runtime/contextAssembly/messageBuild.ts:74` | WeakMap key 类型擦除 |
| 98 | `src/main/channels/channelAgentBridge.ts:322` | Express `Response.write` 流 |
| 99 | `src/main/channels/channelAgentBridge.ts:324` | NodeJS WritableStream `drain` 事件 |

**判定**: 全部保留。

---

## 类 2：JSON.parse / 外部数据 / Tool params 收窄（76 处，合理）

### 2A. JSON.parse / 外部数据 narrow（22 处）

| # | 文件:行 | 上下文 |
|---|---|---|
| 8 | `src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers/defaultSummarizer.ts:25` | tool output `.files` |
| 12 | `src/renderer/api/httpTransport.ts:67` | `JSON.parse(errorBody)` |
| 14 | `src/web/routes/dev.ts:326` | response.result 长度 |
| 36 | `src/main/tools/modules/network/readXlsx.ts:111` | exceljs `row.values` |
| 45 | `src/main/context/documentContext/parsers/excelParser.ts:69` | exceljs `row.values` |
| 47 | `src/main/tools/document/xlwingsExecute.ts:291` | Python script result |
| 48 | `src/main/tools/document/xlwingsExecute.ts:310` | Python script result |
| 54-55 | `src/main/tools/media/ppt/slideSchemas.ts:249,256` | `Array.isArray` 后 narrow |
| 56 | `src/main/tools/media/ppt/slideSchemas.ts:367` | slide → Record narrow |
| 60 | `src/main/tools/media/ppt/index.ts:593` | rawSlides 输入校验前 |
| 62 | `src/main/context/survivorManifest.ts:352` | child_process result |
| 80 | `src/main/services/infra/browser/managedBrowserHelpers.ts:306` | `JSON.parse(content)` |
| 83-84 | `src/main/channels/feishu/feishuChannel.ts:439,546` | 飞书 webhook payload |
| 85 | `src/main/channels/feishu/feishuChannel.ts:661` | post.content 数组 |
| 86 | `src/main/model/providers/anthropic.ts:424` | `Array.isArray(tools)` 后 length |
| 87 | `src/main/model/providers/claudeProvider.ts:431` | 同上 |
| 92-93 | `src/main/cloud/cloudTaskService.ts:593,607` | DB row → EncryptedPayload |
| 95 | `src/main/testing/testCaseLoader.ts:43` | YAML/JSON 测试用例文件 |
| 103-104 | `src/main/evaluation/telemetryQueryService.ts:142,168` | `JSON.parse(value)` |

### 2B. Tool params Zod 校验后 cast（27 处，架构模式）

签名 `params: Record<string, unknown>`（Zod 已在上层校验）→ `TypedParams`。

涉及文件: `gitWorktree`, `gitDiff`, `gitCommit`, `screenshotPage`, `excelGenerate`, `docxGenerate`, `computerUse`, `pdfCompress`, `pdfGenerate`, `imageGenerate`, `imageAnalyze`, `imageAnnotate`, `imageProcess`, `videoGenerate`, `localSpeechToText`, `speechToText`, `textToSpeech`, `xlwingsExecute`, `pptEditTool`, `ppt/index`, `chartGenerate`, `mermaidExport`, `qrcodeGenerate`, `githubPr`, `readPoc`, `computerSurface`。

行号详见原始扫描结果（cases 15, 23, 25-27, 30-31, 34, 37-39, 41-44, 46, 49, 51, 53, 58-59, 63, 66, 73, 75-76, 109）。

**判定**: 保留，但**长期可改进**——用 `z.infer<typeof schema>` 替代 cast，让类型与 schema 单一来源。当前不阻塞。

### 2C. JsonSchema → Record cast（4 处）

| # | 文件:行 | 内容 |
|---|---|---|
| 78 | `src/main/model/providers/openrouter.ts:39` | `tool.inputSchema as unknown as Record<string, unknown>` |
| 88 | `src/main/model/providers/cloud-proxy.ts:50` | 同上 |
| 102 | `src/main/model/providers/openrouterProvider.ts:47` | 同上 |
| 105 | `src/main/evaluation/telemetryQueryService.ts:183` | `definition.inputSchema` 同模式 |

**判定**: 合理但模式重复。`JsonSchemaNode` 本质就是 `Record<string, unknown>` 兼容形状，可考虑给 `JsonSchemaNode` 加 index signature 或暴露一个 `toRecord(schema)` helper 消除四处重复。

### 2D. legacy adapter 桥接（3 处）

`src/main/tools/dispatch/shadowAdapter.ts:75, 128, 228` — 旧/新 ToolContext 协议互转。**判定**: 保留（有 "legacy" / "shadow" 命名标识）。

### 2E. db 实例 → Sink 接口 cast（5 处）

| # | 文件:行 | 内容 |
|---|---|---|
| 40 | `src/main/tools/modules/lightMemory/episodicRecall.ts:66` | `db as SearchableDatabase` |
| 69 | `src/main/context/compactionSnapshotWriter.ts:41` | `db as CompactionSink` |
| 79 | `src/main/context/compactionAuditRecorder.ts:155` | `db as CompactionAuditSink` |
| 91 | `src/main/hooks/builtins/contextHooks.ts:56` | `db as FlushableDatabase` |
| 94 | `src/main/agent/runtime/turnSnapshotWriter.ts:39` | `db as SnapshotSink` |

**判定**: 这是 capability-typing 模式（`db.isReady` 后断言其拥有某 capability 接口）。**列入「合理但可优化」**：建议给 `Database` 类型加结构化的 capability 标记（discriminated union 或 brand types），或提供 typed accessor (`db.asSearchable()` 等)。当前合理。

---

## 类 3：测试 mock typing（1 处，合理）

| # | 文件:行 | 内容 |
|---|---|---|
| 1 | `src/design/__tests__/critique.test.ts:130` | `caller as unknown as ReturnType<typeof vi.fn>` |

**判定**: vitest mock 标准用法，保留。

---

## 类 4：多余 cast — 类型已存在（8 处，**可疑：直接删 cast**）

这些 cast 是冗余的——目标类型字段在源类型上**已经存在**，cast 只是绕路。

### 4.1 ToolContext.sessionId 已存在却仍 cast（5 处）

`src/main/tools/types.ts:50` 已定义 `sessionId?: string`，下列调用方仍然写 `(context as unknown as { sessionId?: string }).sessionId`：

| # | 文件:行 |
|---|---|
| 24 | `src/main/tools/planning/taskList.ts:26` |
| 28 | `src/main/tools/planning/taskGet.ts:40` |
| 29 | `src/main/tools/planning/planUpdate.ts:143` |
| 32 | `src/main/tools/planning/taskCreate.ts:73` |
| 33 | `src/main/tools/planning/taskUpdate.ts:87` |

**修复路径**: 全部改为 `context.sessionId || 'default'`。零风险机械替换。

### 4.2 `null as unknown | null` 句法 bug（1 处）

| # | 文件:行 | 内容 |
|---|---|---|
| 3 | `src/renderer/stores/evalCenterStore.ts:101` | `latestEvaluation: null as unknown | null` |

**问题**: `unknown \| null` 等价于 `unknown`，整个 cast 没有意义。同文件其他字段都用 `null as XxxType \| null` 模式（见 line 98-100）。
**修复路径**: 替换为 `null as EvaluationResult | null`（或对应的具体 store 类型）。

### 4.3 内部对象暴露式 cast（2 处）

| # | 文件:行 | 内容 |
|---|---|---|
| 18 | `src/cli/commands/chat.ts:228` | `null as unknown as readline.Interface` |
| 72 | `src/main/agent/agentLoopIterator.ts:108` | `resolver(null as unknown as T)` |

**18 修复路径**: `handleCommand` 第三参数应改为 `readline.Interface | null`（或在 chat.ts 外层创建一个空 stub）。
**72 修复路径**: queue 的泛型应当是 `T | null`，或定义 `close()` 时不调 resolver 而 reject。

---

## 类 5：应补类型定义 / type augmentation（13 处，**可疑：补类型后删 cast**）

### 5.1 ToolContext 字段缺失（1 处）

| # | 文件:行 | 缺失字段 |
|---|---|---|
| 35 | `src/main/tools/gen5/forkSession.ts:90` | `projectPath` 不在 ToolContext 上 |

**修复路径**: ToolContext（`src/main/tools/types.ts`）增加 `projectPath?: string`，或改为只从 `params.project_path` 读取。

### 5.2 ctx.emit 协议 vs legacy 桥接（3 处）

| # | 文件:行 |
|---|---|
| 50 | `src/main/tools/modules/planning/taskCreate.ts:68` |
| 64 | `src/main/tools/modules/planning/planRecoverRecentWork.ts:86` |
| 65 | `src/main/tools/modules/planning/taskUpdate.ts:194` |

**根因**: `protocol/tools.ts` 的 `ToolContext.emit(event: AgentEvent)` 与 legacy 的 `emit?: (event: string, data: unknown) => void` 签名不一致，三处用 `as unknown as ((event: string, payload: unknown) => void) \| undefined` 桥接。
**修复路径**: 在 `protocol/tools.ts` 上加一个 `legacyEmit?: (event: string, data: unknown) => void`，或者直接发 AgentEvent。这三处行为完全一致，应抽 `emitLegacyTaskUpdate(ctx, payload)` helper 消除重复 cast。

### 5.3 React event handler 类型错配（1 处）

| # | 文件:行 |
|---|---|
| 7 | `src/renderer/components/Sidebar.tsx:682` |

**问题**: `e as unknown as React.MouseEvent`——onClick 已经接收 `React.MouseEvent`，但 cast 暗示 `handleArchiveSession` 第三参数类型不对。
**修复路径**: 修正 `handleArchiveSession` 签名为接收 `React.MouseEvent<HTMLButtonElement>`。

### 5.4 IPC 返回类型缺失（1 处）

| # | 文件:行 |
|---|---|
| 9 | `src/renderer/components/features/evalCenter/pages/FailureAnalysisPage.tsx:77` |

**修复路径**: IPC bridge 函数 `ipc.evalCenter.getAxialCoding()` 返回类型应当声明为 `Promise<AxialCodingEntryIpc[]>`。

### 5.5 Workbench presentation 类型守卫（3 处）

| # | 文件:行 |
|---|---|
| 4 | `src/renderer/utils/workbenchPresentation.ts:423` |
| 5 | `src/renderer/utils/workbenchPresentation.ts:440` |
| 6 | `src/renderer/utils/workbenchPresentation.ts:455` |

**问题**: `asRecord(value)` 只检查是不是 object，然后直接 cast 到 `ManagedBrowserAccountStateSummary` 等具体形状。运行时无字段校验。
**修复路径**: 写 type predicate `function isManagedBrowserAccountStateSummary(v: unknown): v is ManagedBrowserAccountStateSummary`，校验关键字段后再断言。

### 5.6 Message / Error 扩展属性写入（3 处）

| # | 文件:行 | 写入字段 |
|---|---|---|
| 71 | `src/main/agent/forkContext.ts:134` | `Message.cache_control` |
| 74 | `src/main/model/providers/geminiProvider.ts:104` | `Error.fallbackEligible` |
| 77 | `src/main/model/providers/gemini.ts:110` | 同上 |

**修复路径**: 给 `Message` / `Error` 的扩展形状定义 type augmentation（声明合并）或子类。74/77 完全重复，应抽 `createFallbackEligibleError(msg)` helper。

### 5.7 内部 API 暴露访问（2 处）

| # | 文件:行 | 内容 |
|---|---|---|
| 19 | `src/cli/commands/chat.ts:578` | `executor.toolRegistry.getAllTools()` |
| 96-97 | `src/main/channels/channelAgentBridge.ts:232,313` | `orchestrator.onEvent`, internal fields |

**修复路径**: 给 `executor` / `orchestrator` 加正式的公共 API（`listTools()`, `subscribe(handler)` 等），消除 cast 式访问。

### 5.8 其他（4 处）

| # | 文件:行 | 问题 |
|---|---|---|
| 52 | `src/main/tools/media/textToSpeech.ts:203` | `AVAILABLE_VOICES as unknown as string[]` — `readonly` 数组绕过；改为 `[...AVAILABLE_VOICES]` 或在常量定义时 `as unknown` 可去掉 |
| 57 | `src/main/tools/media/ppt/slideSchemas.ts:408` | `content as unknown as LayoutContent` 缺校验，应跑 zod parse |
| 61 | `src/main/context/compressionPipeline.ts:76` | `Message` 没有 `turnIndex`，应在 Message 类型上声明（与 71 同源） |
| 67-68 | `src/main/context/autoCompressor.ts:297,718` | `messages as unknown as Message[]` — 上游类型应直接是 Message[]，cast 暗示传入的不是 |
| 89-90 | `src/main/agent/subagentPipeline.ts:160,179` | 「back compat with tests」flat 字段——应在测试 fixture 收紧而不是 prod 代码里 cast |
| 100-101 | `src/main/model/providers/shared.ts:325,627` | `injectMetaIntoInputSchema` 应声明返回 `JsonSchemaNode`；`m.content` 类型需收紧 |
| 106 | `src/main/evaluation/llmChatFactory.ts:105` | `MODEL_API_ENDPOINTS as unknown as Record<string, string>` — `as const` 已经够用，cast 多余 |
| 107 | `src/main/services/infra/browserService.ts:750` | `tab.page` Playwright 内部属性访问，建议用 module augmentation |
| 108 | `src/main/services/skills/comboRecorder.ts:132` | `toolResult.toolName` 应在 `ToolResult` 类型上声明 |

> 5.8 部分案例数偏多但每一处的复杂度都不高，统一记入「应补类型」。实际工作量见下方优先级。

---

## 优先级建议

### P0 — 机械替换，零风险（推荐立即做）

1. **类 4.1**（5 处 sessionId cast）— 全删，全文件替换 `(context as unknown as { sessionId?: string }).sessionId` → `context.sessionId`
2. **类 4.2**（1 处 evalCenterStore）— 改 `null as unknown | null` 为正确类型
3. **case 106**（MODEL_API_ENDPOINTS）— 直接删 cast

### P1 — 单点修复，影响面小

1. **类 5.2**（3 处 ctx.emit 桥接）— 抽 `emitLegacyTaskUpdate` helper
2. **类 5.6**（3 处 Message/Error 扩展）— 加 type augmentation
3. **case 7**（Sidebar handler 签名）
4. **case 9**（IPC 返回类型）
5. **case 35**（ToolContext.projectPath）

### P2 — 架构改动，需要设计

1. **类 2C**（4 处 inputSchema cast）— JsonSchemaNode 加 index signature
2. **类 2E**（5 处 db capability cast）— 引入 capability brand types 或 typed accessor
3. **类 5.5**（3 处 asRecord 浅校验）— 写 zod schema 或 type predicate
4. **类 5.7**（2 处 internal access）— 暴露公共 API

### P3 — 长期改进

1. **类 2B**（27 处 tool params cast）— 用 `z.infer<typeof schema>` 替换 cast，统一 schema/类型单一来源

---

## 关键发现

1. **109 处中只有 ~21 处真正可疑**（类 4 + 类 5 = 8 + 13），其余 88 处是合理的跨边界 cast 或架构模式。
2. **最严重的是类 4.1**——5 处 ToolContext.sessionId cast 是**完全多余**的：类型上已经有 `sessionId?: string`，cast 是历史遗留，零成本可清理。
3. **case 3** `null as unknown | null` 是明显的句法错误/手滑。
4. **类 2B**（27 处 tool params cast）是架构模式不是可疑，但长期改用 `z.infer` 能消除一类 cast。
5. **类 2E + 5.7**（capability cast / internal access）是设计层面的 type-system 短板，需要重新设计才能消掉。

---

## 后续动作

- **本审计不开 PR**（用户明确 0 代码改动）。
- 建议下一步：单独开 PR 处理 P0（5 处 sessionId + 1 处 evalCenterStore + 1 处 MODEL_API_ENDPOINTS = 7 处删除/修正），全部为机械替换且 typecheck 自验。
