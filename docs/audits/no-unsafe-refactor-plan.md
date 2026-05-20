# no-unsafe-* warning → error 重构方案

**作者**: 劳拉（IPC + SDK wrapper 重构方案 owner）
**日期**: 2026-05-05
**前置 PR**: #94（`no-explicit-any` warn → error 已 merged）
**目标**: 把 5 条 `@typescript-eslint/no-unsafe-*` 从 `warn` 升 `error`，从此新代码不能悄悄写 `any`-typed 数据流。

---

## 2026-05-20 当前守门入口

`debt:report` 是后续类型债 PR 的固定基线命令：

```bash
npm run debt:report
npm run debt:report -- --skip-eslint --limit 15
npm run debt:report -- --json --skip-eslint
```

快速扫描基线：

| 指标 | 当前值 | 口径 |
|---|---:|---|
| `no-explicit-any` inline disable | 152 | `src/` 非测试文件 |
| `as any` casts | 21 | `src/` 非测试文件 |
| `no-unsafe-*` warnings | 77 | `npm run debt:report -- --limit 30`，ESLint JSON |
| top disable bucket | 116 | `src/web/electronMock.ts` |
| top regular source bucket | 5 | `src/main/platform/ipcTypes.ts` |
| top no-unsafe bucket | 4 | `src/renderer/components/ChatView.tsx` / `src/renderer/components/LivePreview` 并列 |

默认执行 `npm run debt:report` 会额外跑 ESLint JSON 输出并统计 `no-unsafe-*` 热点；需要只看大文件和 `any` 快速基线时用 `--skip-eslint`。

本季度目标不变：先收 IPC schema、Provider SDK response、Web route body 这三个入口，不急着把所有 no-unsafe 一次性升 error。

2026-05-20 追加进展：`web/routes/agent.ts`、`web/routes/sessions.ts`、`web/routes/domain.ts` 与 `web/routes/dev.ts` 已把 logger、SessionManager、Supabase fallback、DB facade、create-session body 和 dev/domain request body 入口收成 typed facade / schema parse。`src/web/routes` 的 `no-explicit-any` inline disable 从 13 降到 0，no-unsafe bucket 从 240 降到 13。

2026-05-20 继续进展：`src/web/webServer.ts` 清掉 8 个 `no-explicit-any` disable 和 3 个 `as any`，用 typed bootstrap config、platform window facade、Swarm repo 类型、session domain payload facade 和 Supabase route binding 保持 web bootstrap 外部行为不变。

2026-05-20 network 读侧进展：`twitterFetch.ts`、`youtubeTranscript.ts`、`academicSearch.ts` 的第三方 JSON 响应统一先进 `unknown`，再用 `.passthrough()` zod schema 映射成内部类型。三文件 scoped no-unsafe 从 80 降到 0，`src/main/tools/modules` no-unsafe bucket 从 406 降到 326。

2026-05-20 network 管理侧进展：`githubPr.ts` 与 `jira.ts` 的 `gh` CLI / Jira REST JSON 输出收成 typed facade，Jira create payload 从 `any` 改成结构化 payload。两文件 scoped no-unsafe 从 123 降到 0，`src/main/tools/modules` no-unsafe bucket 从 326 降到 203。

2026-05-20 network 响应侧进展：`screenshotPage.ts`、`imageAnalyze.ts`、`readPdf.ts` 与 `httpRequest.ts` 的 Microlink / OpenAI-compatible vision / raw HTTP JSON 响应统一先落 `unknown`，再通过 zod schema 或 JSON stringify 边界进入内部类型。四文件 scoped no-unsafe 从 20 降到 0，`src/main/tools/modules` no-unsafe bucket 从 203 降到 183。

2026-05-20 PPT 入口进展：`pptGenerate.ts` 给 CJS `pptxgenjs` loader 加最小 typed constructor facade，生成入口不再把 `pptx` 实例作为 `any` 传给 slide master / layout helper。该文件 scoped no-unsafe 从 20 降到 0，并顺手去掉 1 个 `no-explicit-any` inline disable；`src/main/tools/modules` no-unsafe bucket 从 183 降到 163。

2026-05-20 modules 小热点进展：`docxEditCore.ts`、`bash.ts`、`process.ts`、`notebookEdit.ts` 与 `multiagent/spawnAgent.ts` 的 `JSON.parse`、`String.replace` callback、`Array.isArray` element 和 nullable index 边界改成 `unknown` / typed callback / guard。五文件 scoped no-unsafe 从 22 降到 0；`src/main/tools/modules` bucket 从 163 降到 141，且剩余 141 条全部集中在 `lsp/lsp.ts`。

2026-05-20 agent team typed-boundary 进展：`lsp/lsp.ts` 加 LSP response guard / normalizer，scoped no-unsafe 从 141 降到 0；`visualReview.ts`、`dataSourceAdapter.ts`、`styleExtractor.ts` 清掉 media 低风险 JSON/CJS/SDK 边界，`src/main/tools/media` no-unsafe 从 142 降到 79；`useToolExecutionEffects.ts`、`useSessionLifecycleEffects.ts`、`useTaskProgressEffects.ts` 收紧 renderer `agent:event` payload，`src/renderer/hooks/agent` no-unsafe 从 124 降到 77；`updateService.ts` 给 Vercel/GitHub update response 加 typed parser，`src/main/services/cloud` no-unsafe 从 64 降到 0。

2026-05-20 media typed-boundary 进展：`charts.ts`、`masterDecorations.ts`、`slideMasters.ts`、`preview-all-layouts.ts`、`slideContentAgent.ts` 与 `mermaidToNative.ts` 清掉 pptxgenjs chart/master object、preview VLM JSON、模型 JSON array 和 native shape 的 `any` 传染；`src/main/tools/media` no-unsafe 从 79 降到 0，全仓 no-unsafe 从 1072 降到 993，`no-explicit-any` inline disable 从 227 降到 217。

2026-05-20 renderer hooks typed-boundary 进展：`useConversationStreamEffects.ts` 与 `usePermissionQueueEffects.ts` 把 `agent:event` payload 从 `any` 改成 `unknown` + per-event guard，保留原有 streaming/message/routing/permission 行为；`src/renderer/hooks/agent` no-unsafe 从 77 降到 0，全仓 no-unsafe 从 993 降到 916，`no-explicit-any` inline disable 从 217 降到 215。

2026-05-20 renderer features typed-boundary 进展：新增 `localBridgeToolResponse.ts` 统一 Local Bridge `fetch().json()` 返回边界，`DirectoryPickerModal.tsx` / `WorkingDirectoryPicker.tsx` 复用该 parser；同时给 chart/document/spreadsheet/generative-ui/message content/settings 的 JSON、postMessage、catch error 和 settings payload 增加 `unknown` guard。`src/renderer/components/features` no-unsafe 从 47 降到 0，全仓 no-unsafe 从 916 降到 869，`no-explicit-any` inline disable 从 215 降到 213。

2026-05-20 builtin plugin typed-boundary 进展：新增 `typedResponseGuards.ts` 作为内建插件网络响应 facade，`speechToText.ts`、`imageAnnotate.ts`、`imageGenerate.ts` 与 `videoGenerate.ts` 的 ASR/OCR/LLM/video JSON 返回统一先落 `unknown` 再 normalize。`src/main/plugins/builtin` no-unsafe 从 39 降到 0，全仓 no-unsafe 从 869 降到 830。

2026-05-20 renderer auth store typed-boundary 进展：`authStore.ts` 去掉 7 个 `invokeDomain<any>` 和对应 inline disable，用 `AuthActionResult` / `AuthStatus` 固定 renderer 读写 auth action 的返回边界，密码重置回调也复用 domain facade。`src/renderer/stores/authStore.ts` no-unsafe 从 37 降到 0，全仓 no-unsafe 从 830 降到 793，`no-explicit-any` inline disable 从 213 降到 206。

2026-05-20 Feishu channel typed-boundary 进展：`feishuChannel.ts` 的 webhook body、schema 2.0 event、消息 content JSON 和富文本 post 解析改为 `unknown` + record/string guard，并把卡片元素从 `any[]` 收成 `FeishuCardElement` union。`src/main/channels/feishu` no-unsafe 从 36 降到 0，全仓 no-unsafe 从 793 降到 757，`no-explicit-any` inline disable 从 206 降到 205。

2026-05-20 desktop audio typed-boundary 进展：`desktopAudioCapture.ts` 把 onnxruntime-node 动态 require 收成 `OrtRuntimeModule` typed loader，VAD output/state、Qwen3-ASR JSON、SQLite power-state raw_json 都统一走 `unknown` + guard。`src/main/services/desktop` no-unsafe 从 34 降到 0，全仓 no-unsafe 从 757 降到 723，`no-explicit-any` inline disable 从 205 降到 202。

2026-05-20 cron typed-boundary 进展：`cronService.ts` 的 `cron_jobs` / `cron_executions` SQLite row 从 `any[]` 改成 `unknown[]`，再通过 schedule/action/execution guard 映射到内部契约；历史执行结果 JSON 也统一走 `unknown` parse。该文件 scoped no-unsafe 从 33 降到 0，全仓 no-unsafe 从 723 降到 690，`no-explicit-any` inline disable 从 202 降到 201，`as any` 从 46 降到 45。

2026-05-20 renderer HTTP transport typed-boundary 进展：`httpTransport.ts` 的 SSE envelope、agent stream data、HTTP wrapped response、上传/提取/转写/Domain API JSON 返回统一改为 `unknown` parse + typed normalizer。该文件 scoped no-unsafe 从 29 降到 0，全仓 no-unsafe 从 690 降到 661。

2026-05-20 core persistence typed-boundary 进展：`configService.ts`、`databaseService.ts`、`secureStorage.ts` 与 core repositories 的 SQLite/Keychain JSON 读侧统一改成 `unknown` parse + record/string/tool-result normalizer；`better-sqlite3`/`keytar` 动态 require 也先落 `unknown` 再转 typed facade。`src/main/services/core` scoped no-unsafe 从 28 降到 0，全仓 no-unsafe 从 661 降到 633。

2026-05-20 AgentTask persistence typed-boundary 进展：`agentTask.ts` 的 metadata / transcript 反序列化改为 typed loader，`TaskKernel` 增加受控 runtime-state restore 入口，移除 `AgentTask.loadFromDisk` 对 protected/private 字段的 `(task as any)` 直写。该文件 scoped no-unsafe 从 25 降到 0，全仓 no-unsafe 从 633 降到 608，`no-explicit-any` inline disable 从 201 降到 197，`as any` 从 45 降到 41。

2026-05-20 LSP manager typed-boundary 进展：`lsp/manager.ts` 的 JSON-RPC stdout 解析改为 `unknown` + incoming message union，request result/error/notification 分支显式 narrow，`textDocument/publishDiagnostics` 增加 diagnostics payload normalizer。该文件 scoped no-unsafe 从 25 降到 0，全仓 no-unsafe 从 608 降到 583，`no-explicit-any` inline disable 从 197 降到 191。

2026-05-20 runtime / IPC / exporter typed-boundary 进展：`prLinkService.ts`、`notebookEdit.ts`、`channel.ipc.ts` / `cron.ipc.ts` / `provider.ipc.ts` / `soul.ipc.ts` / `speech.ipc.ts` / `voicePaste.ipc.ts`、runtime context/message 相关文件、`exportMarkdown.ts` 与 `pluginLoader.ts` 清掉 GitHub/Notebook/IPC/runtime/export/plugin JSON 与 dynamic import 边界。全仓 no-unsafe 从 583 降到 466，`no-explicit-any` inline disable 从 191 降到 177，`as any` 从 41 降到 35。

2026-05-20 agent team no-unsafe sweep 进展：`agentAdapter.ts`、CLI `bootstrap.ts` / `adapter.ts` / `output/terminal.ts`、`web/routes`、`telegramChannel.ts`、`cloudStorageService.ts`、`researchExecutor.ts`、`restoreSession.ts`、skills `gitDownloader.ts` / `skillRenderer.ts` 与 `codexSessionParser.ts` 改为 `unknown` + typed guard / schema parse / typed dynamic import 边界。全仓 no-unsafe 从 466 降到 309，`no-explicit-any` inline disable 从 177 降到 166，`as any` 从 35 降到 28。

2026-05-20 any 目标收尾进展：`dagScheduler.ts` 去掉 ToolCall arguments 的 `as any` 读取，改成 record/string guard；`localBridgeStore.ts` 去掉 window 全局 interval cast，改为模块级 polling handle，并给 `/health` JSON 返回加 typed parser。全仓 no-unsafe 从 309 降到 295，`no-explicit-any` inline disable 从 166 降到 162，`as any` 从 28 降到 23，`as any < 25` 季度目标已达成。

2026-05-20 no-unsafe 收尾进展：`index.ts` 收紧 Electron 启动事件与 `process.defaultApp` 类型，`httpHookExecutor.ts` / `scriptExecutor.ts` 给 hook JSON response 和 exec error object 加 typed parser，`src/main/tools/shell` 清掉 process output chunk / persisted task JSON / escape callback 边界，`platform/appPaths.ts` 给 package version JSON 加 parser。全仓 no-unsafe 从 295 降到 249，`no-explicit-any` inline disable 从 162 降到 158，`as any` 从 23 降到 22。

2026-05-20 CLI database typed-boundary 进展：`src/cli/database.ts` 把 `better-sqlite3` CJS loader、compaction / turn snapshot / message attachment / memory metadata / cached tool result / tool execution JSON 读侧统一收成 typed parser，fallback tool result 补齐 `toolCallId` 契约。该文件 scoped no-unsafe 从 16 降到 0，全仓 no-unsafe 从 249 降到 233，`no-explicit-any` inline disable 158，`as any` 22。

2026-05-20 sandbox process-boundary 进展：`sandbox/manager.ts`、`sandbox/bubblewrap.ts` 与 `sandbox/seatbelt.ts` 给子进程 stdout/stderr chunk 加明确类型，并把 `SandboxManager.forProject()` 的动态 `require('path')` 改为静态 typed import。三文件 scoped no-unsafe 从 25 降到 0，全仓 no-unsafe 从 233 降到 208，`no-explicit-any` inline disable 158，`as any` 22。

2026-05-20 low-risk boundary sweep 进展：`antiPattern/detector.ts` 的强制工具调用 JSON 解析、`mcpServer.ts` 的 bridge JSON response、`planPersistence.ts` 的 plan/snapshot JSON 读侧，以及 `pythonBridge.ts` 的 Electron resource path / stdout chunk / Python JSON result 都改成 `unknown` + guard。四文件 scoped no-unsafe 从 32 降到 0，全仓 no-unsafe 从 208 降到 176，`no-explicit-any` inline disable 从 158 降到 157，`as any` 从 22 降到 21；`antiPattern/detector.ts` 保持在 999 行，没有新增大文件债。

2026-05-20 tail typed-boundary sweep 进展：`agentMdLoader.ts` 的 YAML frontmatter、`selectionStore.ts` 的 pinned sessions storage、`dataFingerprint.ts` 的 JSON fact extraction、`imageGenerationService.ts` 的 CogView/OpenRouter JSON response、`tokenOptimizer.ts` 的 tool output summary、`mcpToolRegistry.ts` / `logBridge.ts` 的 MCP content / command body，以及 `taskOrchestrator.ts` / `openchronicleSupervisor.ts` 的 model/settings/CLI output 边界都改成 `unknown` + guard。全仓 no-unsafe 从 176 降到 124，`no-explicit-any` inline disable 从 157 降到 155，`as any` 21。

2026-05-20 sub-100 进展：`telemetryStorage.ts` 的 active skill / MCP / keyword / quality signal / fallback JSON 读侧、`ForceUpdateModal.tsx` 与 `UpdateNotification.tsx` 的 update event union、`nativeDesktop.ts` 的 web fallback IPC envelope、`sessionEventService.ts` 的 SQLite statement / event JSON，以及 `multiagentTools/workflowOrchestrate.ts` 的 structured JSON extraction 收成 typed facade。全仓 no-unsafe 从 124 降到 96，`no-explicit-any` inline disable 从 155 降到 152，`as any` 21；当前 top no-unsafe bucket 已降到 4。

2026-05-20 tail no-unsafe 收尾进展：`evalCritic`、`tools/decorators`、CLI direct-run/serve/json extractor、`quickModel.ts` 与 auth service/token manager 的 JSON / metadata / cached user / stream chunk 边界改为 `unknown` + typed facade。全仓 no-unsafe 从 96 降到 77，`no-explicit-any` inline disable 152，`as any` 21；剩余 top no-unsafe bucket 主要落在 `ChatView.tsx` / `LivePreview` 等 UI 尾部热点。

---

## 0. TL;DR

| 项 | 数 |
|---|---|
| 总 no-unsafe-* warning | **2755** (实测 origin/main `4e6cbbff` 干净状态；之前 2820 是父会话测时本地工作树有 143 脏文件污染) |
| 涉及文件 | 211 |
| 涉及 module | 20+ |
| 70% 集中在 | `model/providers` + `web/routes` + `tools/lsp` + `ipc/*` |
| 升 error 前必须做的 | IPC zod 化 + Provider/SDK 响应 schema 化 + LSP/Express/Supabase 类型补齐 |
| 估算工作量 | **48 人/天**（不含评审），分 6 个 PR |
| 风险 | 中等 — 主要是运行时性能（zod parse 开销）和 SSE 热路径回归 |

最终判断：**升 error 是值得做的，但不要一次性做**。先按文档分 6 个 PR 推 4 个高密度 module，2820 → ~400 后再开 final 升级 PR。

---

## 1. 实测数据（main HEAD `4e6cbbffd82b156e895b6d21ec5cfa64e4c3cafd`）

### 1.1 规则计数

| 规则 | warning 数 |
|---|---|
| `no-unsafe-member-access` | 1256 |
| `no-unsafe-assignment` | 944 |
| `no-unsafe-call` | 299 |
| `no-unsafe-argument` | 210 |
| `no-unsafe-return` | 111 |
| **合计** | **2820** |

> 跟父会话给的数据（1247/941/293/207/110 = 2798）有 **22 条偏移**，原因是 main 又有 2 个 commit (`fc7f157b` P1 audit / `3d24973b` P0 audit) 落下来。比例完全一致，结论不变。

### 1.2 Top 模块（按 warning 数）

| 模块 | warning | 主因 |
|---|---:|---|
| `src/main/model/providers/` | 349 | OpenAI/Claude/Gemini SSE+response 解析（`JSON.parse` → any 链） |
| `src/main/tools/media/` | 330 | PPT chartGen/imageGenerate 等三方库返回 any |
| `src/main/tools/modules/` | 220 | network 工具（jira/twitter/githubPr）调用 SDK 接口 |
| `src/web/routes/sessions.ts` | 164 | Express `req.body`、Supabase 链式查询、`tryGetSessionManager(): Promise<any>` |
| `src/web/routes/agent.ts` | 152 | 同上 |
| `src/main/tools/lsp/lsp.ts` | 141 | LSP server 响应 typed 为 any |
| `src/web/webServer.ts` | 110 | Express middleware + 平台桥 |
| `src/renderer/hooks/agent/` | 101 | IPC 响应（renderer 端） |
| `src/main/agent/runtime/` | 55 | runtime context payload |
| `src/main/ipc/*.ts` | ~80 | IPC handlers payload + dynamic JSON.parse |

> 注：renderer 侧 101 条会随 main 侧 IPC zod 化自动收敛（IPC 类型契约对称生效）。

### 1.3 50 个 warning 抽样（每条规则 10 条）

完整列表见 `/tmp/eslint-samples.json`（2820 条全部已扫）。代码读取确认根因后，归并到 §2 的 7 类。

---

## 2. 根因分类（决定哪类先修）

| 类 | 占比估计 | 典型样本 | 修复策略 |
|---|---:|---|---|
| **A. JSON.parse → any 传染** | ~50% | `providers/anthropic.ts:115 const parsed = JSON.parse(data); parsed.message?.usage` | zod schema + `safeParse(unknown).field` |
| **B. 函数签名直接写 any** | ~15% | `parseOpenAIResponse(data: any)` / `formatResult(result: any)` / `buildLSPRequest(...): { requestParams: any }` | 改签名为 `unknown` 或具体类型 |
| **C. IPC payload 全链 any** | ~12% | `HandlerFn = (event: any, ...args: any[]) => any` (`platform/ipcTypes.ts:6`) | 引入 `defineHandler<C extends Channel>` 包装器 |
| **D. Express req.body / Supabase 链** | ~10% | `req.body?.title`, `await sb.supabase.from('sessions').select('*')` | zod parse req.body + Supabase 生成类型 |
| **E. dynamic require + prototype 黑魔法** | ~5% | `cli/adapter.ts:362 const fs = require('fs')` / `cli/bootstrap.ts:10-15` Module.prototype patch | 改 ESM `import` 或加显式类型 |
| **F. 三方 SDK 缺类型** | ~5% | `tools/modules/network/jira.ts` axios 响应、`tools/media/ppt/charts.ts` chartjs-node-canvas | wrapper 类型门面 |
| **G. 测试 fixture / 实验代码** | ~3% | `__tests__/preview-all-layouts.ts`, `testing/agentAdapter.ts` | per-file `eslint-disable` 或低优先级 |

**关键洞察**：A + B + C 加起来 ~77%，全部走"零信任边界 + zod"一条主路径就能扫掉。D + E + F 是局部药，一文件一文件改。G 不动。

---

## 3. IPC zod 化方案

### 3.1 当前架构（已读源码确认）

- `src/shared/ipc/handlers.ts` — IPC 类型契约（700 行，`InvokeHandlers` interface 描述每个 channel 的入参/返回类型）。**类型契约本身写得很好**。
- `src/shared/ipc/domains.ts` — 21 个 domain channel（`domain:agent`、`domain:session`...），统一 `IPCRequest<T>` / `IPCResponse<T>` 信封。
- `src/main/platform/ipcTypes.ts:6` — **病灶**：`HandlerFn = (event: any, ...args: any[]) => any`。
- `src/main/platform/ipcRegistry.ts:13` — `handlers = Map<string, HandlerFn>`，业务侧调用 `ipcMain.handle(channel, async (_event, payload) => {...})`，payload 编译时类型 = any。
- 45 个 `*.ipc.ts` 文件、~300 个 `ipcMain.handle` 调用，**没有一个**通过类型契约校验 payload。

### 3.2 设计

#### Step 1: 在 `shared/ipc/` 加 schemas 层（新文件）

```typescript
// src/shared/ipc/schemas.ts
import { z } from 'zod';

// 1. 通用信封（运行时跟编译时一致）
export const IPCRequestSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    action: z.string(),
    payload: payload.optional(),
    requestId: z.string().optional(),
  });

export const IPCResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data }),
    z.object({
      success: z.literal(false),
      error: z.object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      }),
    }),
  ]);

// 2. 按 channel 分文件：每个 *.schema.ts 导出 channel-specific schema
// 例：src/shared/ipc/schemas/evaluation.schema.ts
export const SaveAnnotationsPayloadSchema = z.object({
  sessionId: z.string(),
  caseId: z.string(),
  annotation: z.object({
    rating: z.enum(['pass', 'fail', 'partial']),
    note: z.string().optional(),
    rubric: z.record(z.string(), z.number()).optional(),
  }),
});
export type SaveAnnotationsPayload = z.infer<typeof SaveAnnotationsPayloadSchema>;

// 3. Channel → schema 映射（run-time + compile-time 双轨）
export const CHANNEL_SCHEMAS = {
  [EVALUATION_CHANNELS.SAVE_ANNOTATIONS]: {
    payload: SaveAnnotationsPayloadSchema,
    response: z.object({ success: z.boolean() }),
  },
  // ... 其余 channel
} as const;
```

#### Step 2: typed handler 包装器（替换 ipcRegistry）

```typescript
// src/main/platform/ipcRegistry.ts (修改)
import type { z } from 'zod';
import type { IPCChannel } from '../../shared/ipc/handlers';
import { CHANNEL_SCHEMAS } from '../../shared/ipc/schemas';

type SchemaOf<C extends keyof typeof CHANNEL_SCHEMAS> =
  typeof CHANNEL_SCHEMAS[C]['payload'];
type PayloadOf<C extends keyof typeof CHANNEL_SCHEMAS> =
  z.infer<SchemaOf<C>>;
type ResponseOf<C extends keyof typeof CHANNEL_SCHEMAS> =
  z.infer<typeof CHANNEL_SCHEMAS[C]['response']>;

export function defineHandler<C extends keyof typeof CHANNEL_SCHEMAS>(
  channel: C,
  handler: (event: IpcInvokeEvent, payload: PayloadOf<C>) => Promise<ResponseOf<C>>,
): void {
  const schema = CHANNEL_SCHEMAS[channel];
  ipcMain.handle(channel, async (event, rawPayload) => {
    const parsed = schema.payload.safeParse(rawPayload);
    if (!parsed.success) {
      logger.warn(`[IPC] payload validation failed for ${channel}`, parsed.error.issues);
      return createErrorResponse('INVALID_PAYLOAD', parsed.error.message, parsed.error.issues);
    }
    try {
      return await handler(event, parsed.data);
    } catch (err) {
      logger.error(`[IPC] handler ${channel} threw`, err);
      return createErrorResponse('INTERNAL_ERROR', formatError(err));
    }
  });
}
```

#### Step 3: 业务侧迁移（before / after）

```typescript
// BEFORE — src/main/ipc/evaluation.ipc.ts:336
ipcMain.handle(EVALUATION_CHANNELS.SAVE_ANNOTATIONS, async (_event, annotation) => {
  // annotation: any  ❌ 触发 no-unsafe-argument
  const proxy = AnnotationProxy.getInstance();
  return proxy.saveAnnotation(annotation);
});

// AFTER
defineHandler(EVALUATION_CHANNELS.SAVE_ANNOTATIONS, async (_event, payload) => {
  // payload: SaveAnnotationsPayload  ✅ zod 推导
  const proxy = AnnotationProxy.getInstance();
  return { success: await proxy.saveAnnotation(payload) };
});
```

#### Step 4: renderer 侧对称（`shared/ipc/api.ts` 已存在，加 zod parse）

```typescript
// src/renderer/ipc/typedInvoke.ts (新文件)
export async function typedInvoke<C extends keyof typeof CHANNEL_SCHEMAS>(
  channel: C,
  payload: z.infer<typeof CHANNEL_SCHEMAS[C]['payload']>,
): Promise<z.infer<typeof CHANNEL_SCHEMAS[C]['response']>> {
  const raw = await window.electron.invoke(channel, payload);
  // dev 模式下 schema 校验，prod 跳过省 CPU
  if (import.meta.env.DEV) {
    return CHANNEL_SCHEMAS[channel].response.parse(raw);
  }
  return raw as z.infer<typeof CHANNEL_SCHEMAS[C]['response']>;
}
```

### 3.3 IPC 迁移路径

| 步骤 | 内容 | 何时 mergeable |
|---|---|---|
| 1 | 新增 `shared/ipc/schemas/` 目录 + 通用 helpers，**不动业务**，确保旧 `ipcMain.handle` 仍工作 | 立即 |
| 2 | 每个 domain（21 个）单独 PR：写完 schemas → 业务文件 `defineHandler` 迁移 → renderer 用 `typedInvoke` | 滚动 21 周（理论），实操按热度优先级合并到 6 个 PR |
| 3 | 全部迁移完毕后，**删除** `HandlerFn = (event: any, ...args: any[]) => any` 的 `eslint-disable`，把 `HandlerFn` 重新定义为 `<P, R>(event, payload: P) => Promise<R>` | 最后 |

> ⚠️ 不要把 IPC zod parse 放 hot path 上无脑跑。实测 zod 3.23 对 small schema 大约 **0.05–0.2 ms/parse**。`agent_run` SSE 流 chunk 不该走 zod；只在 invoke 边界（请求入口）parse 一次。

---

## 4. SDK Wrapper 模式

### 4.1 现状（已读 `model/providers/` 全部 26 个文件）

- 已有抽象基类 `BaseOpenAIProvider`（`baseOpenAIProvider.ts`）— 子类只需实现 `getBaseUrl` / `getApiKey` / `getExtraHeaders`，已经做得不错。
- **病灶**：响应解析层 `parseOpenAIResponse(data: any) / parseClaudeResponse(data: any) / parseGeminiResponse(data: any)`（`shared.ts:1078/1171/1197`），三个函数承担 ~150+ no-unsafe-* warning，是 SDK 侧最大的 hot spot。
- SSE 流式解析：`anthropic.ts` claudeSSEStream + `sseStream.ts` openAISSEStream，`JSON.parse(data)` 后无差别访问 `parsed.message`/`parsed.delta`/`parsed.choices[0]`。

### 4.2 设计原则

1. **响应 schema 写在 provider 旁边**（不放 shared/contract — 避免 shared 层耦合 provider 私有协议）。
2. **SSE 事件解析使用 `discriminatedUnion`**（OpenAI 事件 vs Claude 事件 vs Gemini 事件结构完全不同）。
3. **失败降级保留**：`safeParse` + 失败时只丢一条 warn log，继续返回 minimal `ModelResponse`，不崩溃整个 stream。**这点至关重要**——provider 是 hot path，不能因为 OpenAI 加了一个不认识的字段就让所有请求挂掉。
4. **wrapper 不替换基类**，是基类的"响应解析模块"。`BaseOpenAIProvider.parseResponse()` 改为调用 wrapper 而不是裸 JSON 处理。

### 4.3 模板示例

#### 4.3.1 OpenAI Wrapper

```typescript
// src/main/model/providers/wrappers/openaiWrapper.ts (新文件)
import { z } from 'zod';
import type { ModelResponse, ToolCall } from '../../types';
import { logger, safeJsonParse, repairJson } from '../shared';

// ── Schema ──────────────────────────────────────
const OpenAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const OpenAIChoiceSchema = z.object({
  index: z.number(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.string().nullable().optional(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(OpenAIToolCallSchema).optional(),
  }),
  finish_reason: z.string().nullable().optional(),
});

const OpenAIChatCompletionSchema = z.object({
  id: z.string().optional(),
  choices: z.array(OpenAIChoiceSchema).min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).optional(),
});

const OpenAIStreamDeltaSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().optional(),
      reasoning_content: z.string().optional(),
      tool_calls: z.array(z.object({
        index: z.number(),
        id: z.string().optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional(),
        }).optional(),
      })).optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })),
});

// ── Wrapper ─────────────────────────────────────
export function parseOpenAIResponse(raw: unknown): ModelResponse {
  const parsed = OpenAIChatCompletionSchema.safeParse(raw);
  if (!parsed.success) {
    const preview = JSON.stringify(raw).substring(0, 200);
    logger.warn('[parseOpenAIResponse] schema mismatch', { preview, issues: parsed.error.issues });
    throw new Error(`Invalid OpenAI response shape: ${preview}`);
  }

  const choice = parsed.data.choices[0];
  const message = choice.message;

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: ToolCall[] = [];
    for (const tc of message.tool_calls) {
      const args = safeJsonParse(tc.function.arguments) ?? repairJson(tc.function.arguments);
      if (args !== null) {
        toolCalls.push({ id: tc.id, name: normalizeToolName(tc.function.name), arguments: args });
      }
    }
    if (toolCalls.length > 0) return { type: 'tool_use', toolCalls };
  }

  return { type: 'text', content: message.content ?? '' };
}

export function parseOpenAIStreamDelta(raw: unknown): {
  textDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: { index: number; id?: string; nameDelta?: string; argsDelta?: string };
  finishReason?: string;
} | null {
  const parsed = OpenAIStreamDeltaSchema.safeParse(raw);
  if (!parsed.success) {
    // SSE 流，未识别字段不致命，只记 trace
    logger.debug('[parseOpenAIStreamDelta] unknown shape, skipping', { issues: parsed.error.issues });
    return null;
  }
  const choice = parsed.data.choices[0];
  if (!choice) return null;
  const delta = choice.delta;
  const toolCall = delta.tool_calls?.[0];
  return {
    textDelta: delta.content,
    reasoningDelta: delta.reasoning_content,
    toolCallDelta: toolCall ? {
      index: toolCall.index,
      id: toolCall.id,
      nameDelta: toolCall.function?.name,
      argsDelta: toolCall.function?.arguments,
    } : undefined,
    finishReason: choice.finish_reason ?? undefined,
  };
}
```

#### 4.3.2 Anthropic Wrapper

```typescript
// src/main/model/providers/wrappers/anthropicWrapper.ts (新文件)
import { z } from 'zod';
import type { ModelResponse } from '../../types';
import { logger } from '../shared';

const ClaudeContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
]);

const ClaudeMessageSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(ClaudeContentBlockSchema),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }).optional(),
});

// SSE 事件 — 用 discriminated union 区分
const ClaudeSSEEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: ClaudeMessageSchema.partial({ content: true }),
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: ClaudeContentBlockSchema,
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
    ]),
  }),
  z.object({ type: z.literal('content_block_stop'), index: z.number() }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullable().optional() }),
    usage: z.object({ output_tokens: z.number() }).optional(),
  }),
  z.object({ type: z.literal('message_stop') }),
]);

export type ClaudeSSEEvent = z.infer<typeof ClaudeSSEEventSchema>;

export function parseClaudeResponse(raw: unknown): ModelResponse {
  const parsed = ClaudeMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid Claude response: ${parsed.error.message}`);
  }
  const toolUse = parsed.data.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use');
  if (toolUse.length > 0) {
    return {
      type: 'tool_use',
      toolCalls: toolUse.map(t => ({ id: t.id, name: t.name, arguments: t.input })),
    };
  }
  const text = parsed.data.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  return { type: 'text', content: text };
}

export function parseClaudeSSEEvent(eventType: string, rawData: unknown): ClaudeSSEEvent | null {
  // 兼容 Anthropic SSE 协议：event field + data field
  const withType = typeof rawData === 'object' && rawData !== null
    ? { type: eventType, ...rawData }
    : { type: eventType };
  const parsed = ClaudeSSEEventSchema.safeParse(withType);
  if (!parsed.success) {
    logger.debug('[parseClaudeSSEEvent] unknown event', { eventType });
    return null;
  }
  return parsed.data;
}
```

#### 4.3.3 DeepSeek Wrapper（OpenAI 兼容 + reasoning_content 扩展）

```typescript
// src/main/model/providers/wrappers/deepseekWrapper.ts (新文件)
import { z } from 'zod';
import { OpenAIChatCompletionSchema } from './openaiWrapper';
import type { ModelResponse } from '../../types';

// DeepSeek 在 OpenAI schema 上 reasoning_content 字段是 thinking-mode 必需，不是可选
const DeepSeekChatCompletionSchema = OpenAIChatCompletionSchema.extend({
  choices: z.array(z.object({
    index: z.number(),
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().nullable().optional(),
      reasoning_content: z.string().optional(),  // DeepSeek 特色
      tool_calls: z.array(z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
});

export function parseDeepSeekResponse(raw: unknown): ModelResponse & { reasoning?: string } {
  const parsed = DeepSeekChatCompletionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid DeepSeek response: ${parsed.error.message}`);
  }
  const message = parsed.data.choices[0].message;
  const reasoning = message.reasoning_content;

  if (message.tool_calls?.length) {
    return {
      type: 'tool_use',
      toolCalls: message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
      reasoning,
    } as ModelResponse & { reasoning?: string };
  }
  return { type: 'text', content: message.content ?? '', reasoning };
}
```

### 4.4 LSP Wrapper（同样模式，covers 141 warnings）

LSP 协议有 microsoft/vscode-languageserver-types 这个官方类型包（已在 npm）。两条路径：

- A. 直接 `npm i vscode-languageserver-types`，把 `manager.sendRequest(): Promise<any>` 改成泛型 `<R>`
- B. 自己写 zod schema（路径灵活度更高，但要自维护协议变化）

**推荐 A**——LSP 协议稳定且有官方类型，没必要自维护 schema。

```typescript
// src/main/lsp/typedManager.ts (改造现有 manager)
import type {
  Location, Hover, SymbolInformation, DocumentSymbol,
  CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall,
} from 'vscode-languageserver-types';

interface LSPMethodMap {
  'textDocument/definition': { result: Location | Location[] | null };
  'textDocument/references': { result: Location[] | null };
  'textDocument/hover': { result: Hover | null };
  'textDocument/documentSymbol': { result: DocumentSymbol[] | SymbolInformation[] | null };
  // ... etc
}

export async function sendTypedRequest<M extends keyof LSPMethodMap>(
  manager: LSPManager,
  filePath: string,
  method: M,
  params: unknown,
): Promise<LSPMethodMap[M]['result']> {
  return manager.sendRequest(filePath, method, params) as Promise<LSPMethodMap[M]['result']>;
}
```

### 4.5 Express + Supabase（57 + ~30 warnings）

#### Express `req.body` 用 zod parse

```typescript
// src/web/helpers/typedBody.ts (新文件)
import type { Request } from 'express';
import { z } from 'zod';

export function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw new HttpError(400, 'INVALID_BODY', result.error.message);
  }
  return result.data;
}

// 业务用法
const RunBodySchema = z.object({
  prompt: z.string(),
  project: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  generation: z.string().optional(),
  sessionId: z.string().optional(),
  attachments: z.array(z.unknown()).optional(),
});

router.post('/run', async (req, res) => {
  const body = parseBody(req, RunBodySchema);  // ✅ typed
  // body.prompt: string  body.attachments: unknown[] | undefined
});
```

#### Supabase 链式查询用生成类型

`supabase gen types typescript --project-id <id> > src/shared/supabase-types.ts`，Supabase client 改用 `SupabaseClient<Database>`。这是一次性配置不是持续工作。

---

## 5. 工作量估算 + 派活顺序

### 5.1 按 module 拆分

| # | module | warning | 工作量 | 复杂度 | 依赖前置 |
|--:|---|---:|---:|---|---|
| 1 | `shared/ipc/schemas/` 通用基建 + `defineHandler` + `parseBody` 包装器 | — | **2 天** | 低 | 无 |
| 2 | `model/providers/wrappers/` (OpenAI/Claude/Gemini/DeepSeek SSE+response) | ~349 | **6 天** | **高**（SSE hot path 容易回归，必须配 contract test） | 无 |
| 3 | `tools/lsp/lsp.ts` + manager + format 函数 | 141 | **2 天** | 中（依赖 vscode-languageserver-types） | 无 |
| 4 | `web/routes/{sessions,agent,domain,extract,dev,settings}.ts` + `webServer.ts` | ~520 | **5 天** | 中（每条路由一个 zod schema，机械活） | #1 |
| 5 | `ipc/*.ts` 45 个文件迁移 `defineHandler` | ~80 | **8 天** | 中（机械活但量大） | #1 |
| 6 | `tools/media/` (PPT/imageGenerate/charts) — 三方 SDK wrap | ~330 | **5 天** | 中（不少 SDK 没类型） | 无 |
| 7 | `tools/modules/network/` (jira/twitter/githubPr) | ~220 | **4 天** | 中 | 无 |
| 8 | `renderer/hooks/agent/` + `renderer/stores/authStore.ts` | ~140 | **3 天** | 低（IPC 类型 propagate 后大半自动收敛） | #1, #5 |
| 9 | `agent/runtime/` + `cli/adapter.ts` + `cli/bootstrap.ts` 散点 | ~150 | **5 天** | 中（runtime 有 prototype 黑魔法） | 无 |
| 10 | `__tests__/` + `testing/agentAdapter.ts` | ~80 | **0.5 天** | 低（per-file disable） | — |
| 11 | 升 error + cleanup 残余 | ~80 | **2 天** | 低 | 全部 |
| | **合计** | **2820** | **42–48 天** | | |

> 估算口径：单人专心干。实际派给艾克斯/远程 agent 时再 ÷ 2，但要给充足 review 时间。

### 5.2 派活顺序（6 个 PR）

| PR | 包含 module | 累计干掉 warning | 派给谁 |
|---|---|---:|---|
| **PR-1** 基建 | #1 | 0 | 劳拉（小心写 wrapper 类型签名） |
| **PR-2** Provider | #2 | ~349 | 劳拉 + 艾克斯 audit（必跑 SSE contract test） |
| **PR-3** LSP | #3 | ~490 | 艾克斯（机械化，可远程） |
| **PR-4** Web routes | #4 | ~1010 | 艾克斯（按路由迁移，可远程） |
| **PR-5** IPC + renderer | #5 + #8 | ~1230 | 远程 agent（机械） |
| **PR-6** Media + Network | #6 + #7 | ~1780 | 艾克斯（不少 SDK 类型补丁） |
| **PR-7** Final | #9 + #10 + #11 | **2820 → 0**（升 error） | 劳拉 |

**关键纪律**（对应远程 agent 派活的 `feedback_codex_fix_dogfood_scope_drift.md`）：
- 每个 PR 自带 `npm run lint -- --max-warnings <baseline>` gate，不让 warning 反弹
- 每个 PR commit 粒度：一个 module 一个 commit；schema 和 handler 迁移分两个 commit
- PR-2 必须 dogfood 跑通 OpenAI/Claude/DeepSeek 各 1 次完整对话再 merge

### 5.3 何时升 error

下述条件全满足才动 `eslint.config.js`：

1. PR-1 ~ PR-6 全 merged，`npm run lint` 报 ≤ 100 个 no-unsafe-* warning
2. 剩下 ≤ 100 个全部已加 `eslint-disable` + TODO（参考 PR #94 的做法）
3. 跑过 30 轮 eval baseline（不能因为 zod parse 让 token usage 异动 > 5%）
4. SSE p99 latency 不退化 > 10%（实测 prompt + first-byte）

---

## 6. Acceptance Criteria

每条规则升 error 的具体可验证条件：

### 6.1 通用

- [ ] `eslint.config.js` 把 5 条 `no-unsafe-*` 从 `'warn'` 改为 `'error'`
- [ ] `npm run lint` 0 errors（或全部 inline disable + TODO）
- [ ] `npm run typecheck` 0 errors
- [ ] `npm test` 通过（contract test ≥ 30 个新增）
- [ ] 30 轮 eval baseline pass rate 不下降（保持 ≥ 164/200）

### 6.2 各规则单独

| 规则 | 关键检查 |
|---|---|
| `no-unsafe-argument` | grep -E "ipcMain.handle.*=> *async \\(_event, [a-z]+\\)" 无未类型化的 payload 参数 |
| `no-unsafe-assignment` | grep "JSON.parse\\(" 全部要么 zod safeParse，要么 `as <type>`+TODO，要么 `unknown`+narrow |
| `no-unsafe-call` | 不许有 `(maybeAny)()` 模式；require() 全替换为 ESM import |
| `no-unsafe-member-access` | provider parse* 函数全部走 wrapper；req.body 全走 parseBody |
| `no-unsafe-return` | 所有 `): any` 函数签名要么写具体类型要么写 `unknown` |

### 6.3 不能遗漏的 contract tests

- `parseOpenAIResponse / parseClaudeResponse / parseDeepSeekResponse` 各 5 个 fixture（success / tool_use / multi_tool / refusal / max_tokens）
- `parseClaudeSSEEvent / parseOpenAIStreamDelta` 各 4 个 fixture（含 unknown 字段降级 case）
- `defineHandler` 1 个 happy path + 1 个 invalid payload reject
- `parseBody` 1 个 schema 错误返回 400

---

## 7. 风险清单

| 风险 | 严重度 | 缓解 |
|---|---|---|
| **SSE hot-path zod parse 影响首字节延迟** | 高 | 只在 chunk 解析后 parse 完整 event 而非每个 byte；流式 chunk 走 streaming JSON 解析（jsonparse），最终 message 走 zod。p99 latency 退化 < 10ms 可接受 |
| **Provider 加新字段时 schema 不兼容崩 stream** | 高 | 所有 SSE 解析器用 `safeParse + 降级`，schema 失败只丢 warn log，不抛错。schema 写得宽（`.passthrough()` 容忍未知字段） |
| **PR-5 IPC 改动 45 个文件 + 21 domain，远程 agent 容易跑偏** | 高 | 派活前先把基建 PR-1 merged；远程 agent 一次只改一个 domain；走 codex-fix 的 5 条护栏（dry-run gate / per-domain commit / scope 锁死 / 反 docs 污染 / 禁改 roadmap） |
| **Supabase 生成类型版本漂移** | 中 | 在 CI 加 `supabase gen types --check`；schema 变了 PR-4 自动出 diff |
| **vscode-languageserver-types 与 LSP server 实际响应不一致** | 中 | 头一周用 `safeParse` 兜底，跑两周收集 schema mismatch warn log，再决定哪些字段加 wrapper |
| **renderer 侧 dev mode zod 校验拖慢 UI** | 低 | `import.meta.env.DEV ? parse : as`；prod 不跑 |
| **eval baseline pass rate 下降** | 中 | PR-2 后专门跑一轮全量 eval，对比 P0 audit 后的 baseline；下降 > 3 分立刻 revert |
| **回滚成本** | 低 | 每个 PR 独立可回滚；wrapper 函数可以保留 `// @ts-expect-error` 临时兜底 |
| **学习曲线** | 低 | zod 已在 deps，团队接触过（marketplace/types.ts 用过）；写一份 `docs/guides/ipc-zod-conventions.md` 即可 |
| **文档腐烂** | 中 | 升 error 后在 CLAUDE.md 加一条强制 rule："新 IPC channel 必须有 schema；新 provider 响应解析必须有 wrapper" |

---

## 8. 不做什么（明确 out of scope）

- ❌ **不动** `agent_run` SSE 帧的逐 chunk 类型化（会拖慢 50ms+）。chunk 内部可以保留 `unknown` + manual narrow。
- ❌ **不上** `tRPC` / `zod-rpc` 这类全自动 RPC 框架。现有 `IPC_DOMAINS` + `IPCRequest` 信封不动，只是补上类型校验。
- ❌ **不动** `__tests__/` 目录的 fixture 文件（per-file disable 即可）。
- ❌ **不修** `cli/bootstrap.ts` 的 Node.js Module.prototype 黑魔法（那是 require-time hook 的合法用法，加 `eslint-disable + 详细注释`）。
- ❌ **不要求**所有 `as Foo` 都改成 zod parse。只在 IPC 边界、provider 边界、req.body 边界 parse。

---

## 9. 后续路径（不在本方案）

- 把 `defineHandler` 模式扩展到 web HTTP routes 全部端点（routes/* 21 个文件）
- 把 zod schema 用作 OpenAPI 生成（zod-to-openapi）做 web API 文档
- 重新评估是否要上 tRPC（取决于本方案推完后的负担感）

---

## 10. 完工标志

本方案文档 = 完工。等爸 review 拍板后再开 PR-1 起手。

—— 劳拉 2026-05-05
