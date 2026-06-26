# Provider 层迁移到 Vercel AI SDK — 设计文档

> 状态：✅ **全量落地**。引擎接入 + 双引擎可回退于 2026-05-23 合并 main（PR #164 子代理 / #165 主 loop / #168 regression 收尾）；**全部 provider 迁到 AI SDK 于 2026-05-27 收口**（WS1 Phase 1-2，见 §7）。`CODE_AGENT_MODEL_ENGINE=legacy` 仍可一键回退旧 modelRouter。
> 本文 §1-§6 是迁移前的设计稿（保留问题陈述与方案脉络）；**as-built 以 §7 + [ARCHITECTURE M1](../ARCHITECTURE.md) 为准**。
> 对标 alma(yetone) / OpenCode / CodePilot。

## 1. 为什么（问题陈述）

Agent Neo 目前**自己拥有整个 provider 矩阵**：`ModelRouter` + `providers/wrappers/openaiWrapper.ts` 手写解析每个 provider 的响应，流式（`sseStream`）和非流式（`parseOpenAIResponse`）是**两套独立解析**。后果：

- **Bug B（已定位未修）**：DeepSeek 非流式把 tool call 吐成 `<｜｜DSML｜｜>` 文本，`parseOpenAIResponse` 的文本兜底只认 `Calling foo(...)` → 工具调用丢失 → 子代理（走非流式）干不成活。主 loop 走流式所以没事——**两套解析不对称**就是病根。
- **Bug C（本次打补丁修了）**：registry 用 PascalCase、agent 定义用 snake_case，两份清单漂移 → 子代理工具被 strip。`resolveToolAlias` 是补丁，不是根治。
- **结构性**：每接一个新模型 = 一批新解析分支 + 一批"只有跑那个模型才触发"的隐藏 bug。这就是"打补丁飞轮"。

行业里同尺度、同栈的产品都不这么干：

| 产品 | provider 归一 | 能力元数据 | 备注 |
|---|---|---|---|
| OpenCode | Vercel AI SDK | Models.dev（外部注册表） | TS |
| **CodePilot（归藏, 同尺度对标）** | Vercel AI SDK | 自建 provider-catalog + resolver + transport + doctor | TS Electron, 603 文件 |
| **alma（yetone）** | Vercel AI SDK（`@ai-sdk/openai-compatible`、`@ai-sdk/deepseek`、`@ai-sdk-tool/parser`、OpenRouter…） | AI Provider 管理本身就是产品 | TS Electron |
| Aider（Python） | LiteLLM | LiteLLM model db | 对照组 |
| **Agent Neo（现状）** | **自己手写** | 散落硬编码 | 唯一自持 provider 矩阵 |

## 2. spike 证据（已跑通）

隔离 PoC：`~/Downloads/ai/neo-aisdk-spike/`（`ai@6` + `@ai-sdk/deepseek` + `@ai-sdk/openai-compatible`，依赖版本对齐 alma）。

同一个 DeepSeek（Bug B 元凶）+ mimo（默认模型），在**非流式 `generateText` 和流式 `streamText`** 下各跑一个带工具的多步循环：

| Provider | 非流式 | 流式 |
|---|---|---|
| DeepSeek `deepseek-chat` | ✅ tool-call 归一 / 无 DSML / 答案 29 正确 | ✅ |
| mimo-v2.5-pro（OpenAI 兼容） | ✅ | ✅ |

**结论**：AI SDK 把 provider 原生格式归一成统一的 `tool-call` / `tool-result` 事件，流式非流式同源 —— Bug B 这一类在应用层消失；工具经 `tool()` 单次定义 —— Bug C 类不可能发生。

## 3. 目标架构

```
┌─────────────────────────────────────────────┐
│  agent loop / tools / hooks / context（不变）│  ← Neo 的差异化在这层，保留
├─────────────────────────────────────────────┤
│  AiSdkModelAdapter（新增, 薄）               │  ← 实现现有 ModelRouter.inference 签名
│    streamText / generateText  →  AgentEvent  │
├─────────────────────────────────────────────┤
│  Vercel AI SDK（provider 归一）              │  ← 外包，社区维护
│  @ai-sdk/{anthropic,openai,deepseek,         │
│   openai-compatible,google} + @ai-sdk-tool/  │
│   parser（给无原生 FC 的模型兜底）           │
├─────────────────────────────────────────────┤
│  ModelCatalog（新增, 迷你 Models.dev）       │  ← {toolUse, vision, contextWindow} 查表
│  ProviderResolver（收口, 单一来源）          │  ← 所有入口同一套 provider+model 解析
└─────────────────────────────────────────────┘
```

**关键招**：新增一个 `AiSdkModelAdapter`，**实现现有 `ModelRouter.inference(messages, tools, modelConfig, onEvent, signal)` 签名**，内部用 `streamText` 把 AI SDK 的 `fullStream` 映射成 Neo 的 `AgentEvent`，返回现有 `ModelResponse` 形状。**agent loop 一行不用改**，只是把 provider 的脏活换掉。

### 适配器接缝（草图）

```ts
// src/host/model/adapters/aiSdkAdapter.ts（新增，flag-gated）
import { streamText, stepCountIs, tool as aiTool } from 'ai';
import { resolveAiSdkModel } from './aiSdkProviderResolver'; // 按 modelConfig 选 @ai-sdk/* provider

export async function inferenceViaAiSdk(
  messages, toolDefs, modelConfig, onEvent, signal,
): Promise<ModelResponse> {
  const model = resolveAiSdkModel(modelConfig);                 // catalog 查 toolUse 决定传不传 tools
  const tools = Object.fromEntries(toolDefs.map(d => [d.name, aiTool({
    description: d.description, inputSchema: d.inputSchema,     // 工具名单一来源
  })])); // execute 留空：Neo 自己的 toolExecutor 执行，这里只要 schema
  const res = streamText({ model, messages, tools, abortSignal: signal });
  let content = '', toolCalls = [];
  for await (const part of res.fullStream) {
    switch (part.type) {
      case 'text-delta':   content += part.text; onEvent({ type: 'message_delta', data: { text: part.text, path: 'content' } }); break;
      case 'reasoning-delta': onEvent({ type: 'stream_reasoning', data: { content: part.text } }); break;
      case 'tool-call':    toolCalls.push({ id: part.toolCallId, name: part.toolName, arguments: part.input });
                           onEvent({ type: 'tool_call_start', data: { id: part.toolCallId, name: part.toolName } }); break;
      case 'error':        onEvent({ type: 'error', data: { message: String(part.error) } }); break;
    }
  }
  const usage = await res.usage;
  return { type: toolCalls.length ? 'tool_use' : 'text', content, toolCalls,
           usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
}
```

> 注意：Neo 现在是「模型只产出 tool_call，工具由 `toolExecutor` 执行」。所以适配器里 AI SDK 的 `tool()` **不传 execute**，只用它的 schema 归一；执行仍走 Neo 自己的 toolExecutor + 权限/审计/hook。这样多 agent、权限门、worktree 全不动。

## 4. 迁移分阶段（增量、flag-gated、可回退）

| 阶段 | 内容 | 风险 | 回退 |
|---|---|---|---|
| **P0 适配器 + 单 provider** | 加 `aiSdkAdapter` + `MODEL_PROVIDER_ENGINE=aisdk` flag；先只把 **DeepSeek**（Bug B 元凶）走 AI SDK，其余走旧路径 | 低 | 关 flag |
| **P1 能力表 + resolver 收口** | 建 `ModelCatalog`（toolUse/vision/contextWindow）+ `ProviderResolver` 单一入口；传 tools 前查 toolUse | 低 | 表是新增，不动旧逻辑 |
| **P2 provider 逐个迁移** | mimo/anthropic/zhipu/kimi 一个一个切到 AI SDK，每个切完跑多 agent E2E 回归 | 中 | 每 provider 独立 flag |
| **P3 删手写层** | 全部 provider 走 AI SDK 后，删 `openaiWrapper` 的解析 + `sseStream` DSML 处理 + 各 per-model 补丁 + Bug C 的 alias 兜底 | 中（净删代码） | git revert |

**子代理优先**：P0 里把子代理路径优先切到 AI SDK——它是 Bug B 的重灾区，且非流式/流式归一后能直接消灭"子代理拿不到工具"。

## 5. 风险 / 非目标

- **不在分发前做**。下周分发用已修好的版本（Bug A/C 已修，Bug B 是 DeepSeek 特定、默认 mimo 路径已能跑）。本迁移是分发后的结构性还债。
- **流式事件映射**要逐一核对：Neo 的 `AgentEvent`（message_delta/tool_call_start/turn_end/usage…）和 AI SDK `fullStream` part 的字段一一对齐，尤其 reasoning/thinking、truncation、token usage。
- **保留项**：Codex CLI / Claude Code 外部引擎（已走 adapter）、MCP 工具（AI SDK 也支持，但 Neo 现有 MCP client 可继续用）、权限门 / worktree / 多 agent 编排 / 评测中心 —— 全在 agent loop 层，不动。
- **无原生 function calling 的模型**：用 `@ai-sdk-tool/parser`（alma 同款）做 prompt-based tool 解析兜底，替代 Neo 手写的 `Calling foo()` 正则。
- **成本/遥测**：token usage 来源从自算改为 AI SDK 的 `usage`，需校准遥测链路（架构记忆里的 SSE token 追踪链要对齐）。

## 6. 一句话建议

> 保留 Neo 的差异化（agent loop / 多 agent / 评测 / 记忆），把"接 N 个模型"这件低差异化高维护的事外包给 AI SDK。spike 已证明可行且能从根上消灭 Bug B/C 类。分发后按 P0→P3 增量切，每步 flag 可回退。

---

## 7. as-built — 全 provider 迁移收口（2026-05-27，WS1 Phase 1-2）

5/23 完成的是「引擎接入 + 双引擎可回退」（DeepSeek/Anthropic 走专用包，其余 provider 仍经 adapter 里的 openai-compatible 通用分支或旧路径）。5/27 把剩余 provider 全部归到 AI SDK 的官方/兼容 provider 包，`AISDK_UNSUPPORTED_PROVIDERS` 清空——至此**所有 provider 都走 AI SDK 适配器**，不再有"非 OpenAI 兼容就自动降级旧路径"的逻辑。

### Phase 1（commit `8479276d`）— gemini + openrouter 迁官方包

| Provider | 之前 | 现在 | 包 |
|---|---|---|---|
| gemini | 手搓 `convertToGeminiMessages` / `handleGeminiStream`（原生 API 非 OpenAI 兼容，曾留旧路径） | `createGoogleGenerativeAI` | `@ai-sdk/google@^3.0.79` |
| openrouter | 手搓 `normalizeJsonSchema` + 自行注入 headers | `createOpenRouter`（官方包内置 HTTP-Referer / X-Title） | `@openrouter/ai-sdk-provider@^2.9.0` |

### Phase 2（commit `85bc4ac2`）— zhipu / moonshot / xiaomi 迁 openai-compatible

- 三者从各自的 `BaseOpenAIProvider` 派生类，改走 `@ai-sdk/openai-compatible`。
- 国内模型特异参数（thinking 字段、采样 temp/top_p、`max_completion_tokens` 等）由 `buildVendorCompatSettings(config)` 统一注入（`aiSdkAdapter.ts:206-246`），不再散落在各 provider class。
- zhipu 三态端点（free→bigmodel.cn / coding→0ki-coding / 标准→0ki）由 `resolveProviderBaseUrl()` 判定；zhipu 本地免费档的**并发 limiter 移到 `inferenceViaAiSdk()` 外层**套（`aiSdkAdapter.ts:497-514`），不在 provider class 内。
- `reasoning_content` 由 `@ai-sdk/openai-compatible` 原生映射成 `reasoning-delta`，无需额外处理。

### as-built 路由全景

provider 解析收敛到两处单一事实来源：

```
resolveModel()  (aiSdkAdapter.ts:249-286)         ← 按 provider 选包
├─ deepseek            → @ai-sdk/deepseek
├─ anthropic / claude  → @ai-sdk/anthropic
├─ gemini              → @ai-sdk/google              (Phase 1 新)
├─ openrouter          → @openrouter/ai-sdk-provider (Phase 1 新)
└─ 其余(zhipu/moonshot/xiaomi/longcat/qwen/minimax/custom)
                       → @ai-sdk/openai-compatible + buildVendorCompatSettings()

providerResolution.ts  ← baseURL（resolveProviderBaseUrl）+ apiKey（resolveProviderApiKey）
```

调用 gate（`contextAssembly/inference.ts` 主 loop + `subagentExecutor.ts` 子代理）：
`CODE_AGENT_MODEL_ENGINE !== 'legacy' && aiSdkSupportsProvider(provider)` —— 后者现**恒为 true**（unsupported 集合已空）。

### 旧路径现状（P3 净删待办）

- 旧手写解析层（`BaseOpenAIProvider` / `openaiWrapper.ts` / `sseStream.ts` / `parseOpenAIResponse`）+ 各旧 provider class（`ZhipuProvider`/`GeminiProvider`/…）**仍在仓库**，仅 `CODE_AGENT_MODEL_ENGINE=legacy` 时由 `modelRouter` 调用。
- 设计稿 §4 的 **P3「删手写层」尚未执行**——双引擎稳定运行一段后再净删，届时 `AISDK_UNSUPPORTED_PROVIDERS` 集合本身也可删除。
- 设计稿 §3/§5 提到的 `@ai-sdk-tool/parser`（prompt-based tool 兜底）**最终未引入**：全部在用 provider 都原生支持 function calling，无需兜底。
