# 模型配置指南

> 更新时间: 2026-02-01 (v0.16.15)

## 已配置的模型供应商

| 供应商 | API Key | 成本类型 | 主要用途 |
|--------|---------|----------|----------|
| **DeepSeek** | ✅ 已配置 | 按量 | 主力代码模型 |
| **智谱 GLM** | ✅ 已配置 | 包年/免费 | 视觉 + 免费快速模型 |
| **Groq** | ✅ 已配置 | 免费额度 | 极速推理 |
| **百炼/千问** | ✅ 已配置 | 按量 | 全模态 (视频/音频/图像) |
| **Kimi K2.5** | ✅ 已配置 | 包月 | 长上下文代码 (haioi.net) |
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
    "video": {"provider": "qwen", "model": "qwen3-vl-plus"}
  }
}
```

---

## 配置文件位置

| 文件 | 用途 |
|------|------|
| `.env` | API Keys |
| `~/Library/Application Support/code-agent/config.json` | 路由配置 |
| `src/main/model/providerRegistry.ts` | 模型注册表 |
