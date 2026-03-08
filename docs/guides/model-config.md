# 模型配置指南

> 更新时间: 2026-02-12 (GLM-5 升级)

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

### 自适应路由 (v0.16.22+)

简单任务自动路由到免费模型，降低 API 成本。失败时自动 fallback 到默认模型。

| 复杂度 | 判定条件 | 路由目标 |
|--------|---------|---------|
| `simple` (score < 30) | 用户消息 < 50 字 + 无代码块 + 无文件引用 | zhipu/glm-4.7-flash（免费）|
| `moderate` (30-60) | 50-200 字 或 1 个代码块 | 保持默认（moonshot/kimi-k2.5） |
| `complex` (60+) | > 200 字 或 多代码块 或 "重构/架构" 关键词 | 保持默认 |

相关代码：`src/main/model/adaptiveRouter.ts`

### 跨 Provider 降级链 (v0.16.42+)

当主 Provider 的瞬态重试（429/超时/连接错误）全部耗尽后，自动按配置链尝试下一个 Provider，无需人工干预。

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
