# N-CTXTRUTH：圆环总量改 provider 真源（Cursor 上下文压缩借鉴 B）

日期：2026-08-21 · 分支：kimi/N-CTXTRUTH · 状态：已施工

## 病

圆环（ContextUsagePill）和明细弹层（ContextHealthDetailPopover）的总量全程来自
`contextHealthService.update()` 的本地 gpt-tokenizer 估算，而 provider 每轮真实回报的
input tokens 已在 `inference.ts` 记账点（`ctx.recordTokenUsage`，source='provider'/'estimated'）
落进 budgetService，却不回喂圆环。中文重会话下估算偏差大，用户看到的 % 不可信。
Cursor 的对应数字来自本轮真实 usedTokens。

## 改法

每轮推理后把 provider 实报总量（inputTokens + cacheRead + cacheCreation）作圆环总量真源；
本地估算只负责桶内比例——breakdown 各桶等比缩放到真总量（桶间比例不变）。
弹层大数字行旁显示估/实偏差；provider 未回报（inputTokens=0，如 SSE 断流）退回估算，
并在大数字旁标「估算」。

### 各 provider usage 字段核实结论（usageNormalization.ts 统一口径）

归一化后 **`inputTokens` 一律不含缓存**（非缓存输入），所以上下文占用真总量必须
加上 cacheRead / cacheCreation。逐 wrapper 核实：

| wrapper / adapter | 归一函数 | 原始字段语义 | 归一后 inputTokens 是否含 cacheRead |
|---|---|---|---|
| anthropicWrapper | normalizeClaudeUsage | `input_tokens` 本身不含缓存；`cache_read_input_tokens` / `cache_creation_input_tokens` 独立字段 | 否（原生即不含） |
| openaiWrapper（OpenAI / Zhipu / DeepSeek / Moonshot-Kimi） | normalizeOpenAIUsage | `prompt_tokens` 含缓存；命中量在 `prompt_tokens_details.cached_tokens`（OpenAI/Zhipu）、`prompt_cache_hit_tokens`（DeepSeek）、`cached_tokens`（Moonshot） | 否（已扣除 cached） |
| responsesWrapper | normalizeResponsesUsage | `input_tokens` 含缓存（真机实测 input_tokens=87479 其中 cached=64256），命中量在 `input_tokens_details.cached_tokens` | 否（已扣除 cached） |
| aiSdkAdapter（AI SDK v6 路径） | normalizeAiSdkUsage | `inputTokens` 为总输入（含缓存读/写），明细在 `inputTokenDetails.noCacheTokens/cacheReadTokens/cacheWriteTokens` | 否（优先取 noCacheTokens，缺则总输入减缓存） |
| geminiWrapper | normalizeGeminiUsage | `promptTokenCount` 含缓存，命中量在 `cachedContentTokenCount` | 否（已扣除 cached） |

结论：真总量 = `inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)`，
加法统一收在 `contextHealthService.update()` 内（`ProviderContextUsage`），调用方不各自拼。

## 实现位置

- 契约：`src/shared/contract/contextHealth.ts` — `ContextHealthState` 加
  `tokenSource?: 'provider' | 'estimated'`（缺省视同 estimated，兼容老状态）+
  `estimatedTokens?`（仅 provider 轮有值，缩放前的本地估算总量，供弹层算偏差）。
- 服务：`src/host/context/contextHealthService.ts`
  - `update()` 第 8 参 `providerUsage?: ProviderContextUsage`；总量 >0 才用真源，
    否则全走估算且 `tokenSource='estimated'`。
  - 等比缩放：`scaleTokenBreakdown` / `scaleSourceBreakdown`（纯函数，取整到 token）。
  - **bySource 累加器独立存放**（`sourceAccumulators` map，永远是未缩放估算口径）：
    provider 轮次 state 里的 bySource 是缩放快照，若当累加基底会逐轮复合漂移；
    record/clear/reset 写累加器，防抖广播时经 `toDisplayState` 按 `currentTokens/estimatedTokens`
    重缩放。recordSourceContribution 的估算语义（上游全部喂估算值）不受影响。
- 接线（不挂全局变量，走 ADR-038 contextHealth 切片）：
  - `src/host/agent/runtime/contextHealthState.ts` — 切片加 `lastTurnProviderUsage`
    （getter + `setLastTurnProviderUsage`）。
  - `src/host/agent/runtime/contextAssembly/inference.ts` — 三处记账点显式写切片：
    provider 分支写实报、estimated 分支写 undefined、中断（abort 沉没成本）路径写 undefined。
  - `src/host/agent/runtime/contextAssembly/compression.ts` — `updateContextHealth()`
    读切片传给 service。同一 turn 多次迭代时取最后一次推理的实报（消息最全的一次）。
- 冷路径保持估算（不传 providerUsage，service 自动标 estimated）：
  `agentOrchestrator.updateContextHealthSnapshot`、`contextHealth.ipc.ts`
  `resolveContextHealthForSession` / `compactSession`。
- UI：`src/renderer/components/features/chat/ContextHealthDetailPopover.tsx`
  大数字行旁：provider 轮显示「估算偏差 ±x.x%」（|dev|≥0.05% 才显示，title 解释口径）；
  非 provider（含缺省）显示「估算」标注。hover 气泡不动。
  i18n：`src/renderer/i18n/taskStatusPanels.ts` contextHealth 段 zh/en 加
  `estimatedBadge` / `estimateDeviation` / `estimateDeviationTitle`。

## 测试

- `tests/unit/context/contextHealthService.tokenSource.test.ts`（6 条）：
  provider 回报 / 不回报 / 回报 0 三条 hermetic；等比缩放（桶比例不变 + 九桶合计贴合真总量）；
  连续 provider 轮不累加缩放（累加器不漂移回归）；provider 轮后断流落回 estimated。
  反向变异已实测：`useProviderTruth` 强制 false 时用例 1/4/5 立红（已还原）。
- `tests/renderer/components/contextHealthDetailPopover.tokenSource.test.tsx`（4 条）：
  provider 轮偏差渲染 / 偏差收敛到 0 不渲染 / estimated 标注且不吃 estimatedTokens /
  老状态缺省视同 estimated。

## 验收点

- [x] provider 回报轮：圆环 % 与弹层总量 = 实报（含 cache），桶比例不变
- [x] 未回报/回报 0：退回估算并标「估算」
- [x] 弹层显示估/实偏差（仅 provider 轮有意义时）
- [x] 老状态兼容（缺省 tokenSource 视同 estimated）
- [x] 门禁：typecheck / tsc tests / eslint（0 error）/ knip 双档 / design-system / 两个测试目录全量

## 真机验收（2026-08-21，基拉）

构建指纹 kimi/N-CTXTRUTH@8a99bcc（Agent Neo Dev 2）。一条最小真实消息（deepseek-v4-flash，单轮，费用 $0.01）：
- 账本 traces 该轮 `inference.inputTokens=12326`，弹层总量 12.3k——数字一致（验收①）。
- 弹层显示「估算偏差 +3.4%」（本地估算相对实报偏高 3.4%，估算口径偏保守方向可见）；无「估算」标注（provider 轮）。
- 平铺桶清单同步缩放：系统提示 5.8k(46.8%) / 工具定义 6.3k(51.2%) / 对话 248(2.0%)。
- 证据：`code-agent-private-archive/docs/evidence/2026-08-21-N-CTXTRUTH/`（verify-truth.mjs + truth-popover.png）。
