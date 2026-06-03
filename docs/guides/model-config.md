# 模型配置指南

> 更新时间: 2026-06-03 (ADR-019 自动模式路由体系：单一决策入口 / 计费四分类 / 路由可视化)

## 已配置的模型供应商

| 供应商 | API Key | 成本类型 | 主要用途 |
|--------|---------|----------|----------|
| **DeepSeek** | ✅ 已配置 | 按量 | 备用代码模型 |
| **智谱 GLM** | ✅ 已配置 | 包年/免费 | 旗舰(GLM-5) + 视觉 + 免费快速模型 |
| **Groq** | ✅ 已配置 | 免费额度 | 极速推理 |
| **百炼/千问** | ✅ 已配置 | 按量 | 全模态 (视频/音频/图像) |
| **Kimi K2.5** | ✅ 已配置 | 包月 | **主力模型** (haioi.net) |
| **Perplexity** | ✅ 已配置 | 按量 | 联网搜索 |
| **OpenRouter** | ✅ 已配置 | 按量/免费 | 中转各家模型 |

---

## 成本类型说明

| 类型 | 标识 | 说明 |
|------|------|------|
| `free` | 🆓 | 完全免费 |
| `quota` | 🎫 | 免费额度限制 |
| `monthly` | 📅 | 包月套餐 |
| `yearly` | 📅 | 包年套餐 |
| `payg` | 💰 | 按量付费 (Pay As You Go) |

> 上表是模型目录里的**静态成本标签**（"市场价"，全局常量）。
> 自动模式路由读的是另一套**运行时计费语义**——某个 provider 对**当前用户**而言怎么计费（用户配置）。两者分离，见下文「计费语义四分类」。

---

## OpenRouter 模型明细

| 模型 | 成本 | 说明 |
|------|------|------|
| `google/gemma-3n-e2b-it:free` | 🆓 免费 | Gemma 3 |
| `meta-llama/llama-3.3-70b-instruct:free` | 🆓 免费 | Llama 3.3 70B |
| `deepseek/deepseek-r1-0528:free` | 🆓 免费 | DeepSeek R1 推理 |
| `google/gemini-3-flash-preview` | 💰 按量 | Gemini 3 Flash |
| `google/gemini-3-pro-preview` | 💰 按量 | Gemini 3 Pro |
| `anthropic/claude-opus-4.5` | 💰 按量 | Claude Opus 4.5 |
| `anthropic/claude-sonnet-4.5` | 💰 按量 | Claude Sonnet 4.5 |
| `anthropic/claude-haiku-4.5` | 💰 按量 | Claude Haiku 4.5 |
| `openai/gpt-5.2` | 💰 按量 | GPT-5.2 |
| `openai/gpt-5.2-codex` | 💰 按量 | GPT-5.2 Codex |
| `meta-llama/llama-4-maverick` | 💰 按量 | Llama 4 Maverick |
| `deepseek/deepseek-v3.2` | 💰 按量 | DeepSeek V3.2 |

---

## 百炼/千问 模型明细

| 模型 | 成本 | 说明 |
|------|------|------|
| `qwen3-max` | 💰 按量 | 旗舰语言模型 |
| `qwen-max` / `qwen-plus` / `qwen-turbo` | 💰 按量 | 语言模型系列 |
| `qwq-plus` | 💰 按量 | 深度推理 |
| `qvq-max` | 💰 按量 | 视觉推理 |
| `qwen3-coder-plus` / `qwen3-coder-flash` | 💰 按量 | 代码模型 |
| `qwen-vl-max` / `qwen3-vl-plus` / `qwen3-vl-flash` | 💰 按量 | 视觉模型 |
| `qwen-omni-turbo` / `qwen3-omni-flash` | 💰 按量 | 全模态 (图+音+视频) |
| `qwen-image-max` / `qwen-image-edit-max` | 💰 按量 | 图像生成/编辑 |
| `qwen3-tts-flash` / `qwen3-asr-flash-realtime` | 💰 按量 | 语音合成/识别 |
| `qwen2.5-7b-instruct-1m` | 💰 按量 | 超长上下文 (1M) |

> 百炼新用户有免费额度

---

## 智谱 GLM 模型明细

| 模型 | 成本 | 说明 |
|------|------|------|
| `glm-5` | ⏳ 待开通 | **新一代旗舰** (200K上下文, 744B/40B active, Coding套餐未支持) |
| `glm-4.7` | 📅 包年 | 旗舰语言 (Coding套餐) |
| `glm-4.6v` | 📅 包年 | 旗舰视觉 (Coding套餐) |
| `glm-4.7-flash` | 🆓 免费 | 快速语言 |
| `glm-4.6v-flash` | 🆓 免费 | 快速视觉 |
| `codegeex-4` | 🆓 免费 | 代码专用 |
| `cogview-3-flash` | 🆓 免费 | 文生图 |
| `cogvideox-flash` | 🆓 免费 | 文生视频 |

---

## Groq 模型明细

| 模型 | 成本 | 说明 |
|------|------|------|
| `llama-4-maverick-17b-128e-instruct` | 🎫 额度 | Llama 4 最新 |
| `llama-4-scout-17b-16e-instruct` | 🎫 额度 | Llama 4 多模态 |
| `llama-3.3-70b-versatile` | 🎫 额度 | Llama 3.3 稳定版 |
| `moonshotai/kimi-k2-instruct` | 🎫 额度 | Kimi K2 极速版 |
| `groq/compound` | 🎫 额度 | 智能路由 |

---

## DeepSeek 模型明细

| 模型 | 成本 | 说明 |
|------|------|------|
| `deepseek-chat` | 💰 按量 | 通用对话 |
| `deepseek-coder` | 💰 按量 | 代码专用 |
| `deepseek-reasoner` | 💰 按量 | 深度推理 (R1) |

---

## Perplexity 模型明细

| 模型 | 成本 | 说明 |
|------|------|------|
| `sonar-pro` | 💰 按量 | 联网搜索 (高质量) |
| `sonar` | 💰 按量 | 联网搜索 (快速) |

---

## Kimi/Moonshot 模型明细

| 模型 | 成本 | 说明 |
|------|------|------|
| `kimi-k2.5` | 📅 包月 | 旗舰模型 (haioi.net 代理) |
| `moonshot-v1-8k` | 💰 按量 | 8K 上下文 |
| `moonshot-v1-32k` | 💰 按量 | 32K 上下文 |
| `moonshot-v1-128k` | 💰 按量 | 128K 上下文 |

---

## 当前路由配置

```json
{
  "routing": {
    "code": {"provider": "moonshot", "model": "kimi-k2.5"},
    "vision": {"provider": "zhipu", "model": "glm-4.6v"},
    "fast": {"provider": "zhipu", "model": "glm-4.7-flash"},
    "gui": {"provider": "zhipu", "model": "glm-4.6v-flash"},
    "video": {"provider": "qwen", "model": "qwen3-vl-plus"},
    "evaluation": {"provider": "moonshot", "model": "kimi-k2.5"}
  }
}
```

### 显式模型、自动路由与 Agent Engine 模型目录 (v0.16.79+)

模型选择现在分两条链路：

| 链路 | 范围 | 配置来源 | 运行规则 |
|------|------|----------|----------|
| Native Agent Neo 模型 | 普通 Provider 模型，如 Moonshot、OpenAI、Claude、GLM、Qwen、Local | `config.json.models.providers` + SecureStorage API Key | 用户点选具体模型时固定该 provider/model；只有选择“自动”才启用 adaptive fallback |
| Agent Engine 模型 | 外部 CLI engine：Codex CLI / Claude Code | control-plane 签名 `agent_engine_model_catalog` + 本机 `models.agentEngines.<kind>.defaultModel` | 传给外部 CLI 的 `--model` 参数；不混入普通 Provider 路由 |

显式模型的边界：用户手动选了某个 Native 模型后，`adaptive=false`，Provider 失败或 capability 不匹配不会自动换到其他 provider。这样 UI 上选了哪个模型，实际请求就留在哪条模型链路。选择“自动”时，`adaptive=true`，才允许复杂度路由、artifact-write 偏好和能力 fallback 介入。

Agent Engine 模型目录由 `/api/v1/control-plane?artifact=agent_engine_models` 下发，客户端验签失败或远程不可用时使用内置目录。设置页只保存本机默认选择，不保存完整远程目录。

### Custom Provider / 中转站支持 (2026-06-03)

用户可在设置中添加动态 custom provider（`custom-xxx`，不在 `MODEL_API_ENDPOINTS` 静态注册表里），通常指向中转站。三处兜底/过滤保证其在主链路可用：

- **baseURL 从用户设置兜底**：aiSdk 路径下，当 `config.baseUrl` 没随调用链传下来时（子代理 / 重建 config），`providerResolution` 按 `config.baseUrl > settings.models.providers[id].baseUrl > ENDPOINTS[provider]` 兜底，与 legacy `getDynamicCustomProvider` 对齐，不再直接抛"无法解析 baseURL"（`src/main/model/providers/providerResolution.ts`）。
- **能力识别从用户设置兜底**：`modelRouter.getModelInfo` 在静态 `PROVIDER_REGISTRY` 查不到时，从用户设置构造 `ModelInfo`——动态 custom provider 模型此前一律被判为"无 vision 能力"，用户配置里的 `supportsVision: true` 被忽略，触发无意义的 vision fallback（`src/main/model/modelRouter.ts`）。
- **relay 模型处理**：处理未配置（unconfigured）和混合（mixed）relay 模型场景（`src/shared/modelRuntime.ts`、`src/renderer/components/ChatView.tsx`）。

**ModelSwitcher 过滤未配置 Key 的 provider**：聊天模型切换面板不再展示没配 API Key 的默认启用 provider（避免新用户看到一堆点了就报错的死模型）。`apiKeyConfigured` 由 `configService.getSettings()` 动态注入（SecureStorage / env 任一有 key 即 true）；`local`（Ollama）无需 key 豁免；当前会话 / 默认 provider 走 `includeDisabledProviders` 豁免，选中项不会凭空消失（`src/shared/modelRuntime.ts`、`.../StatusBar/ModelSwitcher.tsx`）。

### 自适应路由 (v0.16.22+，ADR-019 重构于 2026-06-03)

简单任务自动路由到免费模型，降低 API 成本。该能力只在“自动”模式生效；显式模型不会自动切换到免费模型或默认模型。

| 复杂度 | 判定条件 | 路由目标 |
|--------|---------|---------|
| `simple` (score < 30) | 用户消息 < 50 字 + 无代码块 + 无文件引用 | zhipu/glm-4-flash（免费）|
| `moderate` (30-60) | 50-200 字 或 1 个代码块 | 保持默认（moonshot/kimi-k2.5） |
| `complex` (60+) | > 200 字 或 多代码块 或 "重构/架构" 关键词 | 保持默认 |

**计费门控（2026-06-03）**：simple → 免费模型路由不再一刀切，按用户默认 provider 的**计费方式**门控——只有按量付费（`payg`）才路由（真省钱）；包月（`plan`）或未知（`unknown`）默认不路由（省的钱是 0，纯增加不确定性）。判定见 `resolveProviderBillingMode()`（`src/main/model/modelDecision.ts`）。

**两条主链路真正生效（2026-06-03）**：此前自动模式在打包版的桌面/web 主链路（`/api/run` + aiSdk 引擎）失效，UI 选“自动”后简单任务仍直打默认模型。三个断点已修复：

1. **`/api/run` 透传 adaptive**：会话 override 读取时把 `override.adaptive=true` 透传进 agent loop 的 `modelConfig.adaptive`，否则 vision capability fallback 的闸门（`modelConfig.adaptive === true`）恒为 false（`src/web/routes/agent.ts`）。
2. **aiSdk 引擎接入免费模型路由**：aiSdk 引擎（`CODE_AGENT_MODEL_ENGINE` 默认值）此前完全绕过 adaptiveRouter，简单任务→免费模型只存在于 legacy `modelRouter.inference` 内部。现在 `runEngineInference` 在 aiSdk 路径等价接入（含 apiKey 解析、跨 provider 清 baseUrl、失败回退默认模型、401/403 永久禁用免费模型），见 `src/main/agent/runtime/contextAssembly/inference.ts`。
3. **CLI_MODE 守卫加 WEB_MODE 例外**：webServer（桌面/web 聊天主链路）为 keytar 守卫也设了 `CLI_MODE=true`，导致 adaptiveRouter 的 CLI_MODE 守卫把简单任务路由一刀切禁用。现在加 `CODE_AGENT_WEB_MODE` 例外，只禁纯 CLI / 评测场景（`src/main/model/adaptiveRouter.ts`）。

相关代码：`src/main/model/adaptiveRouter.ts`、`src/main/model/modelDecision.ts`

### 计费语义四分类（ADR-019 决策 4，2026-06-03）

为替代不可维护的"价格感知路由"（BYOK 场景下精确价格表无法维护），路由门控改为读 provider 的**计费方式**标记。这是「某 provider 对当前用户怎么计费」的用户配置，与模型目录里的静态成本标签（市场价）分离：

| `billingMode` | 含义 | 来源 | 默认值 |
|---------------|------|------|--------|
| `free` | provider 官方免费（如 glm-4-flash） | 全局常量 | — |
| `plan` | 用户套餐内 / 包月（如当前用户的 kimi-k2.5） | **用户设置** | — |
| `payg` | 低成本按量 / 普通 API Key | 用户设置 | 普通 provider 默认 `payg` |
| `unknown` | 中转站 / 未知价格 | 用户设置 | 动态 custom provider 默认 `unknown` |

默认值贴近现实：普通 provider 默认按量（API Key 主流形态，省钱路由默认生效），中转站保守取未知。配错的代价不对称——包月被当按量 = 没省到钱但不多花钱；按量不路由 = 损失真实节省。详见 [ADR-019](../decisions/019-auto-mode-scope.md)。

相关代码：`src/shared/contract/modelDecision.ts`（`BillingMode` 类型）、`src/shared/contract/settings.ts`（`ModelProviderSettings.billingMode`）

### 路由透明度（model_decision trace，ADR-019 批 3，2026-06-03）

每次推理前路由决策结构化为 `ModelDecision`，作为 `model_decision` 事件透传到 trace / 消息，UI 据此渲染路由可视化（业内 auto 模式普遍是黑盒，透明度是本产品差异化点）：

- **RouteTraceChip**（`src/renderer/components/features/chat/RouteTraceChip.tsx`）：主聊天消息上方的收起式 chip（如「自动 · 已用 GLM-4-Flash 回答 · 免费 ▸」），点击展开决策详情。
- **FallbackBanner**（`.../chat/MessageBubble/FallbackBanner.tsx`）：可用性降级（限流 / 网络 / 余额不足切 provider）时原位插入聊天流的横幅；文案只说"回复风格可能略有差异"，不夸大成丢上下文（Neo 消息历史模型无关，切 provider 不丢上下文）。
- subagent 任务卡常驻模型标签（`RunWorkbenchCards.tsx`）。

`ModelDecisionReason` 枚举：`user-selected` / `role-tier` / `simple-task-free` / `billing-gate-skip` / `capability-vision` / `fallback-availability`。

### 跨 Provider 降级链 (v0.16.42+)

当主 Provider 的瞬态重试（429/超时/连接错误）全部耗尽后，自动按配置链尝试下一个 Provider。2026-05-22 后，这条链只在 `adaptive=true` 的自动模式生效；手动点选具体模型时失败会返回原 Provider 错误。

**降级规则**：
- 仅瞬态错误触发降级（429、timeout、ECONNRESET 等），非瞬态错误（认证失败、参数错误）**不会**降级
- 跳过未配置 API Key 的 Provider
- 所有降级均失败时，抛出原始 Provider 的错误

**当前降级链**（定义在 `PROVIDER_FALLBACK_CHAIN`）：

| 主 Provider | 降级目标 1 | 降级目标 2 |
|------------|-----------|-----------|
| moonshot | deepseek/deepseek-chat | zhipu/glm-4.7-flash |
| deepseek | moonshot/kimi-k2.5 | zhipu/glm-4.7-flash |
| claude | moonshot/kimi-k2.5 | deepseek/deepseek-chat |
| openai | moonshot/kimi-k2.5 | deepseek/deepseek-chat |
| zhipu | moonshot/kimi-k2.5 | deepseek/deepseek-chat |

**日志标识**：降级时日志输出 `[ModelRouter] Fallback → <provider>/<model>`

相关代码：`src/shared/constants.ts`（`PROVIDER_FALLBACK_CHAIN`）、`src/main/model/modelRouter.ts`

### 推理请求缓存 (v0.16.22+)

非流式请求的 LRU 缓存，避免重复调用 API。

| 配置项 | 值 |
|--------|------|
| 缓存容量 | 50 条 |
| TTL | 5 分钟 |
| Key 算法 | md5(last 3 messages + provider + model) |
| 缓存范围 | 仅 `type: 'text'` 响应（不缓存 tool_use） |
| 流式请求 | 不缓存（`onStream` 非空时跳过） |

相关代码：`src/main/model/inferenceCache.ts`

### Anthropic Prompt Caching（GAP-003，PR #192）

AI SDK 迁移时丢失的 Anthropic provider 端 prompt caching 已恢复。`applyAnthropicCacheBreakpoints()` 在 AI SDK 路径注入两个 `cache_control` 断点：

| 断点 | 位置 | 缓存内容 |
|------|------|----------|
| 1 | 最后一条 system 消息 | tools + system 前缀（Anthropic 缓存覆盖断点之前的全部内容） |
| 2 | 倒数第二条对话消息 | 对话历史增量缓存（长 cowork 会话的主要收益，连 legacy 路径都没有） |

仅 anthropic/claude provider 需要显式断点（DeepSeek/Kimi 等服务端自动缓存，原样透传）；cache hit 价格 0.1x、miss 写入 1.25x，多轮 agent loop 净收益显著为正。验证方式：日志 `cachedInputTokens > 0`。这与上面的本地推理请求缓存（LRU）互补——前者省 provider 计费，后者省重复请求。细节见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

相关代码：`src/main/model/adapters/aiSdkAdapter.ts`

### 评测系统专用配置

评测系统使用 **Kimi K2.5** 作为评审模型（支持并发 4 个评审员同时调用）：

| 配置项 | 值 | 说明 |
|--------|------|------|
| Provider | `moonshot` | Kimi/Moonshot |
| Model | `kimi-k2.5` | K2.5 旗舰版 |
| Base URL | `https://cn.haioi.net/v1` | haioi.net 代理 |
| 环境变量 | `KIMI_K25_API_KEY` | API Key |
| 环境变量 | `KIMI_K25_API_URL` | 可选，覆盖默认 URL |

> **注意**: GLM 不支持高并发，评测需要 4 个并行请求，因此使用 Kimi K2.5 包月套餐。

---

## 配置文件位置

| 文件 | 用途 |
|------|------|
| `.env` | API Keys |
| `~/Library/Application Support/code-agent/config.json` | 路由配置 |
| `src/main/model/providerRegistry.ts` | 模型注册表 |
