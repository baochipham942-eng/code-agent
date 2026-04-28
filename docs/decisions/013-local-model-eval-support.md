# ADR-013: 评测中心支持本地 Ollama 模型

> 状态: accepted
> 日期: 2026-04-28
> 关联: `~/.claude/projects/-Users-linchen/memory/[Obsidian: 本地LLM-9B评测实测-2026-04-28]`、commit `fd5cd436`

## 背景

code-agent 评测中心（`EvalCenterPanel` + `CreateExperimentDialog` + `evaluation.ipc`）原本只设计跑云端模型：
- 前端 `MODEL_OPTIONS` 硬编码 6 个云端 provider 模型（Claude Opus/Sonnet/Haiku、Kimi、DeepSeek、Gemini）
- 后端 `evaluation.ipc.ts:547` 硬编码 `provider: 'anthropic'`
- 后端 `evaluation.ipc.ts:644-647` `StandaloneAgentAdapter` 硬编码 anthropic provider + `process.env.ANTHROPIC_API_KEY`

但 `src/shared/constants/providers.ts:94-100` 已经定义了 `local` provider（endpoint `http://localhost:11434/v1`，对应 Ollama）。**provider registry 支持 local，评测中心却接不进去**。

实际需求：
- 用本地 Ollama 模型作为 **toy provider** 学模型特征（Qwen3.5-9B / Gemma4-E4B / huihui-ai abliterated 系列）
- 跑同一套 testSet 拿对比 baseline，跨 provider 对比能力差异
- 长期还可能接入用户自托管的 vLLM / LM Studio 等

## 决策

**采纳**：解除评测中心 provider 硬编码，让前端 MODEL_OPTIONS 显式声明 provider，后端 IPC handler 接收并按 provider 路由 API key。

四处代码改动构成完整链路：

### 1. 前端 — `CreateExperimentDialog.tsx`

```typescript
interface ExperimentConfig {
  name: string;
  model: string;
  provider: string;          // 新增字段
  testSetId: string;
  // ...
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7',  label: 'Claude Opus 4.7',  provider: 'anthropic' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
  // ... 6 个云端模型 + provider 字段
  // 本地 Ollama 模型（toy provider + 评测 baseline）
  { value: 'qwen3.5:9b',        label: '[本地] Qwen3.5 9B 原版',  provider: 'local' },
  { value: 'huihui_ai/qwen3.5-abliterated:9b-Qwopus-q4_K',
                                label: '[本地] Qwen3.5 9B Qwopus (agent 调优)', provider: 'local' },
  { value: 'gemma4-e4b-uncensored:q4km',
                                label: '[本地] Gemma4 E4B Uncensored', provider: 'local' },
];

const getProviderForModel = (modelValue: string): string =>
  MODEL_OPTIONS.find((opt) => opt.value === modelValue)?.provider ?? 'anthropic';
```

### 2. 后端 IPC — `evaluation.ipc.ts`

```typescript
ipcMain.handle(EVALUATION_CHANNELS.CREATE_EXPERIMENT, async (_event, config) => {
  const resolvedProvider = config.provider || 'anthropic';
  const apiKeyByProvider: Record<string, string | undefined> = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    moonshot:  process.env.MOONSHOT_API_KEY,
    deepseek:  process.env.DEEPSEEK_API_KEY,
    gemini:    process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY,
    local:     undefined,  // Ollama 不需要 apiKey
  };
  const resolvedApiKey = apiKeyByProvider[resolvedProvider];

  // DB 写实际 provider，不再硬编码 'anthropic'
  db.insertExperiment({ ..., provider: resolvedProvider });

  // StandaloneAgentAdapter 用实际 provider + 对应 apiKey
  const agent = new StandaloneAgentAdapter({
    workingDirectory,
    generation: 'experiment',
    modelConfig: {
      provider: resolvedProvider,
      model:    config.model,
      apiKey:   resolvedApiKey,
    },
  });
});
```

### 3. TestRunner — `testRunner.ts`

新增两个环境变量解决本地模型慢导致的 timeout 问题：

```typescript
// 默认 timeout 从 60s 改成读环境变量
defaultTimeout: parseInt(process.env.CODE_AGENT_TEST_TIMEOUT || '60000', 10),

// case timeout 加 force override（覆盖 yaml 里的 case-level timeout）
const forceTimeout = process.env.CODE_AGENT_FORCE_TIMEOUT
  ? parseInt(process.env.CODE_AGENT_FORCE_TIMEOUT, 10)
  : null;
const timeout = forceTimeout || testCase.timeout || this.config.defaultTimeout;
```

**关键**：`CODE_AGENT_FORCE_TIMEOUT` 必须 override per-case yaml timeout——本地模型 case 经常需要 10 分钟级跑完，否则被 yaml 的 60s case timeout 卡死。

### 4. ContextAssembly — `contextAssembly.ts`

```typescript
// system prompt budget 从 4000 硬编码改成可配置
export const MAX_SYSTEM_PROMPT_TOKENS =
  parseInt(process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS || '4000', 10);
```

**关键**：默认 4000 tokens 装不下完整 50+ tools 的 schema，会触发 "Skipping deferred tools" 把 tools 砍到 14 个。本地模型评测建议设 `16000`，让模型看到完整工具集。

## 启动配置

dev 模式跑评测建议环境变量：

```bash
cd ~/Downloads/ai/code-agent
CODE_AGENT_FORCE_TIMEOUT=600000 \
CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS=16000 \
npm run dev
```

打包后通过 app 内设置或 launchctl 设环境变量。

## 选项考虑

**方案 A（采纳）**：前端显式声明 provider，后端按 provider 路由 — **链路最清晰、扩展性最好**
**方案 B**：从 model id 字符串推断 provider（如包含 `:` 当本地模型）— 隐式、容易误判（如 `claude-3:opus` 这种 tag 也含冒号）
**方案 C**：在 IPC handler 内查 PROVIDER_REGISTRY 反查 — 需要在前端不传 provider 时遍历查 model，**性能差且语义模糊**

## 实测验证

对三个本地模型跑「任务完成能力测试」5 cases（详见 [Obsidian: 本地LLM-9B评测实测-2026-04-28]）：

| 模型 | passed | failed | partial | avgScore |
|------|--------|--------|---------|----------|
| `qwen3.5:9b` 原版 | 0 | 4 | 1 | 0.111 |
| Qwopus | 0 | 3 | 2 | 0.180 |
| Gemma4-E4B | 0 | 3 | 2 | 0.180 |

**结论**：链路通了，但 9B 量级本地模型完全不能作为 code-agent 主推理（0 个 case 真正 pass）。Qwopus 和 Gemma 的 partial 分数完全相同（0.345 / 0.556 精确一致），是 expectation 评分模板的兜底产物（`no_crash` weight=1），不反映模型差异。

## 不采纳

- 不在 PROVIDER_REGISTRY 加新 provider 类型——`local` 已存在
- 不内置 Ollama 模型清单到代码——Ollama tag 频繁变化，应让用户在 MODEL_OPTIONS 自行扩展
- 不改 `MoonshotProvider` / `DeepSeekProvider` 等具体 provider 实现——它们已经在 modelRouter 注册过

## 后续

- [ ] 让 MODEL_OPTIONS 从配置文件读，不在源码中硬编码（用户自定义本地模型 tag 不用改源码）
- [ ] 评测中心对比页加 provider 维度筛选 / 分组
- [ ] 本地模型场景下 raw SSE 日志开关（看 finishReason 和 tool_calls 字段，分清"真不调工具"还是"emit 错"）

## 关联

- Obsidian 笔记：[[本地LLM-9B评测实测-2026-04-28]]
- 上一篇：[[模型对齐税与本地模型实验-2026-04-27]]
- Spec：`~/.claude/specs/code-agent-eval-via-http-api.md`
- Commit: `fd5cd436 feat(eval): support local Ollama models in evaluation center`
