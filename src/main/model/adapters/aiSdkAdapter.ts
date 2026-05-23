// ============================================================================
// AI SDK Adapter — 用 Vercel AI SDK 归一 provider 工具调用，替代手写解析。
//
// 实现与 ModelRouter.inference 相同的契约：
//   (messages, tools, config, onStream?, signal?) => Promise<ModelResponse>
// 内部用 AI SDK 的 generateText 做【单步】推理（不设 stopWhen）——Neo 自己驱动
// agent loop + 执行工具，所以这里只要把模型这一轮的 text/tool-call 归一返回。
//
// P0 范围：先服务子代理路径（subagentExecutor），该路径 onStream 为 no-op，
// 故本适配器暂不映射流式事件，只保证 ModelResponse 正确。flag 关时不生效。
//
// 收益：DeepSeek 非流式不再漏 <｜｜DSML｜｜>（SDK 层归一）；工具名经 tool() 单一
// 定义，无 snake_case/PascalCase 漂移（对照 Bug B / Bug C）。
// ============================================================================

import { generateText, jsonSchema, tool as aiTool } from 'ai';
import type { LanguageModel, ModelMessage as AiModelMessage, ToolSet } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ModelMessage, MessageContent } from '../types';
import type { ModelResponse } from '../../agent/loopTypes';
import type { ToolCall, ToolDefinition, ModelConfig } from '../../../shared/contract';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';
import { PROVIDER_REGISTRY } from '../providerRegistry';
import { resolveProviderBaseUrl, resolveProviderApiKey } from '../providers/providerResolution';

const logger = createLogger('AiSdkAdapter');

interface ProviderRequest {
  baseURL: string | undefined;
  apiKey: string | undefined;
  supportsTool: boolean;
}

// baseURL / apiKey 走与 provider 类同一份解析（providerResolution）——不再在适配器里复制
// zhipu 三态等逻辑（消除「每加一个 provider 就要在 adapter 再打一次补丁」）。
// trustConfigKey:false：子代理 modelConfig 的 apiKey 是从父代理继承来的，provider 可能已被
// 角色策略改成别家（deepseek→zhipu/xiaomi），故按 provider 重新解析（configService→env），
// config.apiKey 仅作最后兜底，避免拿父的 key 去打子代理的 provider → "Invalid token"。
// supportsTool（能力即数据，对照 Models.dev）仍取自 providerRegistry。
function resolveProviderRequest(config: ModelConfig): ProviderRequest {
  const modelEntry = PROVIDER_REGISTRY[config.provider]?.models.find((m) => m.id === config.model);
  return {
    baseURL: resolveProviderBaseUrl(config) || undefined,
    apiKey: resolveProviderApiKey(config, { trustConfigKey: false }) || undefined,
    supportsTool: modelEntry?.supportsTool ?? true,
  };
}

// ── provider 解析：优先专用包（专用包能处理 thinking 回传等坑，通用 openai-compatible 不行）──
function resolveModel(config: ModelConfig, req: ProviderRequest): LanguageModel {
  switch (config.provider) {
    case 'deepseek':
      return createDeepSeek({ apiKey: req.apiKey })(config.model);
    case 'anthropic':
    case 'claude':
      return createAnthropic({ apiKey: req.apiKey, baseURL: req.baseURL ?? MODEL_API_ENDPOINTS.claude })(config.model);
    default: {
      if (!req.baseURL) {
        throw new Error(`[AiSdkAdapter] 无法解析 provider "${config.provider}" 的 baseURL`);
      }
      return createOpenAICompatible({ name: config.provider, baseURL: req.baseURL, apiKey: req.apiKey })(config.model);
    }
  }
}

// content 运行时形状不保证（buildInferenceMessages 后可能是 string / 数组 / 对象），
// 全部容错取文本，绝不对非数组调 .filter（曾导致 "r.filter is not a function" 崩子代理）。
function textOf(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  // 递归处理数组（MessageContent[] / OpenAI content parts）
  if (Array.isArray(content)) return content.map(textOf).join('');
  // 对象：用属性访问而非 'in' 操作符（'in' 对意外的字符串原语会抛
  // "Cannot use 'in' operator"，曾崩子代理）。兼容 {text} / {type,text} / {content}。
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (o.content != null) return textOf(o.content);
    return '';
  }
  return '';
}

// 用户消息：保留文本 + base64 图片（多模态）。content 形状容错。
function userContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  const parts: unknown[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as MessageContent;
    if (c.type === 'text' && c.text) parts.push({ type: 'text', text: c.text });
    else if (c.type === 'image' && c.source?.data) {
      parts.push({ type: 'image', image: `data:${c.source.media_type};base64,${c.source.data}` });
    }
  }
  return parts.length ? parts : textOf(content);
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// tool 结果消息的 toolCallId：顶层 m.toolCallId 或结构化 m.toolResults[0].toolCallId
function toolMsgCallId(m: ModelMessage): string {
  if (m.toolCallId) return m.toolCallId;
  const tr = (m as { toolResults?: Array<{ toolCallId?: string }> }).toolResults;
  return tr?.[0]?.toolCallId ?? '';
}

// tool-call 参数运行时可能是 JSON 字符串或对象，统一成对象
function asInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object') return args as Record<string, unknown>;
  if (typeof args === 'string') return safeParse(args);
  return {};
}

// ── Neo ModelMessage[]（结构化 inferenceMessages）→ AI SDK ModelMessage[] ──
// AI SDK 严格要求 assistant 的每个 tool-call 都配一个 tool-result，否则抛
// "Tool result is missing"。因此先建配对集合，只输出"有结果的 tool-call"和
// "有 tool-call 的结果"，把 orphan 双向丢弃（防 Neo 历史里 in-flight / 被压缩的残缺对）。
function toAiMessages(messages: ModelMessage[]): AiModelMessage[] {
  const idToName = new Map<string, string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) idToName.set(tc.id, tc.name);
    if (m.role === 'tool') {
      const id = toolMsgCallId(m);
      if (id) resultIds.add(id);
    }
  }

  const out: AiModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: textOf(m.content) });
    } else if (m.role === 'tool') {
      const id = toolMsgCallId(m);
      if (!id || !idToName.has(id)) continue; // orphan 结果（无对应 tool-call）→ 丢
      out.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: id,
          toolName: idToName.get(id) ?? 'tool',
          output: { type: 'text', value: textOf(m.content) },
        }],
      } as AiModelMessage);
    } else if (m.role === 'assistant') {
      const txt = textOf(m.content);
      const calls = (m.toolCalls ?? []).filter((tc) => resultIds.has(tc.id)); // 只留有结果的
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: txt || '' });
      } else {
        const parts: unknown[] = [];
        if (txt) parts.push({ type: 'text', text: txt });
        for (const tc of calls) {
          parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: asInput(tc.arguments) });
        }
        out.push({ role: 'assistant', content: parts } as AiModelMessage);
      }
    } else {
      out.push({ role: 'user', content: userContent(m.content) } as AiModelMessage);
    }
  }
  return out;
}

// ── 工具映射：tool() 只取 schema，不传 execute（执行仍由 Neo toolExecutor 负责）──
function buildTools(toolDefs: ToolDefinition[]): ToolSet {
  const tools: Record<string, ReturnType<typeof aiTool>> = {};
  for (const d of toolDefs) {
    tools[d.name] = aiTool({
      description: d.description,
      inputSchema: jsonSchema(d.inputSchema as unknown as Parameters<typeof jsonSchema>[0]),
    });
  }
  return tools as ToolSet;
}

/**
 * 与 ModelRouter.inference 同契约的 AI SDK 实现（P0：单步、非流式、服务子代理）。
 */
export async function inferenceViaAiSdk(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  _onStream?: unknown,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  const req = resolveProviderRequest(config);
  const model = resolveModel(config, req);
  let aiTools: ToolSet | undefined;
  let aiMessages: AiModelMessage[] | undefined;
  let result;
  try {
    // P1b：模型不支持 tool_call 时不传 tools（能力即数据，来自 providerRegistry）
    aiTools = tools.length > 0 && req.supportsTool ? buildTools(tools) : undefined;
    aiMessages = toAiMessages(messages);
    result = await generateText({
      model,
      messages: aiMessages,
      tools: aiTools,
      abortSignal: signal,
      temperature: config.temperature,
      // 不设 stopWhen → 单步：返回模型这一轮的 text 或 tool-call，由 Neo loop 继续驱动
    });
  } catch (err) {
    // 失败诊断：定位崩在哪个阶段（buildTools/toAiMessages/generateText）+ 原始消息形状
    const stage = !aiTools && tools.length > 0 ? 'buildTools'
      : !aiMessages ? 'toAiMessages'
      : 'generateText';
    logger.error('[AiSdkAdapter] inference failed', {
      error: err instanceof Error ? err.message : String(err),
      stage,
      provider: config.provider,
      model: config.model,
      rawMsgShapes: messages.map((m) => ({
        role: (m as { role?: string }).role,
        contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
        hasToolCalls: !!m.toolCalls?.length,
        hasToolResults: !!(m as { toolResults?: unknown[] }).toolResults?.length,
      })),
    });
    throw err;
  }

  const toolCalls: ToolCall[] = (result.toolCalls ?? []).map((tc) => ({
    id: tc.toolCallId,
    name: tc.toolName,
    // 对齐 openaiWrapper：arguments 为已解析对象
    arguments: (tc.input ?? {}) as ToolCall['arguments'],
  }));

  logger.debug('inferenceViaAiSdk done', {
    provider: config.provider, model: config.model,
    type: toolCalls.length ? 'tool_use' : 'text',
    toolCallCount: toolCalls.length,
  });

  // contentParts：text 与 tool_call 的交错顺序。老路径(openaiWrapper)对 tool_use 会带它，
  // 下游子代理据此把 assistant.content 建成数组；缺了会建成字符串，Neo 转换器下一轮
  // 对其 .content.filter 崩（"r.content.filter is not a function"）。对齐契约。
  const contentParts: NonNullable<ModelResponse['contentParts']> = [];
  if (result.text) contentParts.push({ type: 'text', text: result.text });
  for (const tc of toolCalls) contentParts.push({ type: 'tool_call', toolCallId: tc.id });

  return {
    type: toolCalls.length > 0 ? 'tool_use' : 'text',
    content: result.text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    contentParts: contentParts.length > 0 ? contentParts : undefined,
    thinking: result.reasoningText || undefined,
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    },
    finishReason: result.finishReason,
  };
}
