import type { ModelMessage as AiModelMessage } from 'ai';
import { extractToolCallMeta } from '../providers/toolCallMeta';
import { getIncompleteToolCallIds } from '../../session/streamSnapshot';
import type { ResponseContentPart } from '../types';
import type { ModelResponse } from '../../agent/loopTypes';
import type { ToolCall, ModelConfig } from '../../../shared/contract';
import { logger } from './aiSdkFetch';
import type { AiSdkPromptShape } from './aiSdkPromptBuilder';

export function safeParse(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── 流式累积状态（首字节前重试每次全新实例；断流续接 attempt 用断点态 seed，见
//    seedAccumulatorFromBreakpoint —— ADR-068 刀 1）──
export interface StreamAccumulator {
  content: string;
  reasoning: string;
  finishReason: string | undefined;
  usage:
    | { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
    | undefined;
  // 按 toolCallId 索引；index 保留模型发出的先后顺序，对齐 SSE delta.tool_calls[].index 语义。
  toolCalls: Map<string, { id: string; name: string; argsText: string; input?: Record<string, unknown>; index: number }>;
  contentParts: ResponseContentPart[];
  lastPartType: 'text' | 'tool_call' | null;
  charCount: number;
  nextToolIndex: number;
}

export function createAccumulator(): StreamAccumulator {
  return {
    content: '', reasoning: '', finishReason: undefined, usage: undefined,
    toolCalls: new Map(), contentParts: [], lastPartType: null, charCount: 0, nextToolIndex: 0,
  };
}

export function registerToolCall(acc: StreamAccumulator, id: string, name: string) {
  let entry = acc.toolCalls.get(id);
  if (!entry) {
    entry = { id, name, argsText: '', index: acc.nextToolIndex++ };
    acc.toolCalls.set(id, entry);
    // 追踪交错：记录 tool_call 在内容流中的出现位置（对齐 sseStream contentParts）。
    acc.contentParts.push({ type: 'tool_call', toolCallId: id });
    acc.lastPartType = 'tool_call';
  }
  return entry;
}

export function stringifyArgs(input: Record<string, unknown> | undefined, fallback: string): string {
  if (!input) return fallback;
  try { return JSON.stringify(input); } catch { return fallback; }
}

// ── ADR-068 刀 1：首字节后断流续接的 accumulator 断点态 seed ──
// 打破「每次尝试全新累积器」不变量（该不变量以 emittedOutput 闸门为前提，续接场景由
// ADR D2 的 prefix 边界接管）：续接 attempt 从断点态续起，续写 delta 追加其上。
// - 保留 content / contentParts / reasoning / 完整 toolCalls；
// - 半截 tool_call（JSON.parse 不可过，判据复用 getIncompleteToolCallIds）永不进 seed，
//   让模型重发完整调用——执行安全幂等比续接完整性更硬（D2/D4）；
// - 请求体的 prefix 注入（末条 assistant 前缀）与启用开关由刀 2 落地
//   （STREAM_RESUME_B1_PREFIX_SHAPE_LANDED=true，withResumePrefixAssistant 在 attempt
//   顶部消费 seed 时拼装）；本函数只管断点态本身的筛选，B1/B2 两种续接形态共用。
export function seedAccumulatorFromBreakpoint(acc: StreamAccumulator): StreamAccumulator {
  const incompleteIds = new Set(getIncompleteToolCallIds({
    // 映射形状对齐 emitSnapshot；断点必非终态，isFinal 恒 false。
    isFinal: false,
    toolCalls: [...acc.toolCalls.values()].map((t) => ({
      id: t.id, name: t.name, arguments: stringifyArgs(t.input, t.argsText),
    })),
  }));
  const toolCalls: StreamAccumulator['toolCalls'] = new Map();
  for (const entry of acc.toolCalls.values()) {
    // 拷贝 entry：续接 attempt 的 tool-input-delta 会原地追加 argsText，不能与断点前的 Map 共享对象。
    if (!incompleteIds.has(entry.id)) toolCalls.set(entry.id, { ...entry });
  }
  // 半截 tool_call 的 contentParts 条目一并移除，text/tool_call 交错序列保持真实。
  const contentParts = acc.contentParts.filter(
    (part) => !(part.type === 'tool_call' && incompleteIds.has(part.toolCallId)),
  );
  const lastPartType = contentParts.length > 0
    ? (contentParts[contentParts.length - 1].type === 'text' ? 'text' : 'tool_call')
    : null;
  return {
    content: acc.content,
    reasoning: acc.reasoning,
    // 断点处尚未 finish：finishReason / usage 不带入断点态。usage 跨 attempt 合并记账
    // （ADR-068 刀 3）在 streamViaAiSdk 里用 usageFromBrokenAttempts 累积——不挂在
    // accumulator 上，B1/B2 两种续接形态共用同一份账。
    finishReason: undefined,
    usage: undefined,
    toolCalls,
    contentParts,
    lastPartType,
    charCount: acc.charCount,
    // tool_call index 映射跨 attempt 保持稳定（ADR D2）：nextToolIndex 不回卷，
    // 续写新发的 tool_call 接着断点前的序号编，不与已 seed 的 index 冲突。
    nextToolIndex: acc.nextToolIndex,
  };
}

// ── ADR-068 刀 3：usage 跨 attempt 合并记账 ──
// 每次续接尝试都是真实计费（重发整段 input + 各自的 output），单轮展示 usage = Σ attempts。
// 缺侧未上报的可选字段按 0 计入求和（另一侧报了就是真实花费）。
export type StreamUsageTotal = NonNullable<StreamAccumulator['usage']>;
export function mergeAttemptUsage(a: StreamUsageTotal | undefined, b: StreamUsageTotal | undefined): StreamUsageTotal | undefined {
  if (!a) return b;
  if (!b) return a;
  const sumOptional = (x: number | undefined, y: number | undefined): number | undefined =>
    (x === undefined && y === undefined) ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: sumOptional(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: sumOptional(a.cacheCreationTokens, b.cacheCreationTokens),
  };
}

// ADR-068 刀 3：B1 生效需两件事同时就位——能力表档位（prefix-param / trailing-assistant，
// modelCapabilityMatrix）与刀 2 的 prefix 请求形状（把断点前缀真的拼进重发请求）。只有
// 重发请求携带前缀，续写才是「模型以传入前缀为条件继续同一次生成」（D2 (a)）；否则一切
// 续接走 B2 诚实分段（D2 (b)）。刀 2 已落地：开关翻开，prefix 注入接上。
export const STREAM_RESUME_B1_PREFIX_SHAPE_LANDED = true;

// ADR-068 刀 2：prefix-param 档端点覆盖——替换 baseURL 末尾的版本段（…/vN → /beta），
// host 与自定义 baseURL 的目录前缀不变（中转站路由）：官方 'https://api.deepseek.com/v1'
// → '…/beta'；中转 'https://proxy.example/deepseek/v1' → '…/deepseek/beta'。末段不是
// 版本段时 append（不覆盖自定义路径）。非法 baseURL 保持原样（后续请求层自然报错）。
export function withEndpointPath(baseURL: string, endpointPath: string): string {
  try {
    const u = new URL(baseURL);
    const segments = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const normalizedPath = endpointPath.replace(/^\//, '');
    if (segments.length > 0 && /^v\d+$/.test(segments[segments.length - 1])) {
      segments[segments.length - 1] = normalizedPath;
    } else {
      segments.push(normalizedPath);
    }
    u.pathname = `/${segments.join('/')}`;
    return u.toString();
  } catch {
    return baseURL;
  }
}

// ── ADR-068 刀 2：B1 续接请求的末条 assistant prefix（D2 (a) 合同形状）──
// 断点前的文本前缀拼成末条 assistant 消息。调用点保证 acc 为「无完整 tool_call」的断点态
// （含完整 tool_call 的断点在 catch 分流处回落 B2——AI SDK 的配对校验对未配对 tool-call
// 直接抛 MissingToolResultsError，见 toAiMessages 同约束注释）；半截 tool_call 已在
// seedAccumulatorFromBreakpoint 剔除（D2 铁律：永不进 prefix、永不执行，续写中模型重发
// 完整调用）。reasoning 不回传：各家 thinking 协议不通用（deepseek reasoning_content /
// anthropic thinking blocks / gemini thought signatures），前缀不变量只压 text；断点前
// 只有 reasoning 时不拼空 prefix（函数内空 content 短路，见下），原样重发重写正文——
// 诚实优先于伪续接。
// 原 messages 数组元素引用原样 append（不重建不重排，cacheControl 断点不动）：续接请求
// 与原请求共享逐字相同的前缀（system + history + user），ADR-032 prompt cache 命中前提
// （D4 增量成本控制全压在这条上）。
export function withResumePrefixAssistant(prompt: AiSdkPromptShape, acc: StreamAccumulator): AiSdkPromptShape {
  // 空文本断点（断流发生在 reasoning 阶段，acc.content=''）：空 prefix 不带任何续写信息，
  // 且 Moonshot 明确 400「assistant must not be empty」（N-STREAM-RESUME-DOGFOOD 刀 D 真机
  // 抓获，非重试类错误会直接杀死整轮）——不 append，续接 attempt 退化为原样重发：seed 的
  // content 本来就是空的，重生成 delta append 进空 seed 无重复可拼，天然诚实。prefix-param
  // 档的双重收紧（末条 assistant 才注入 prefix/partial）随之自动失效，不会误发裸 prefix:true。
  if (!acc.content) return prompt;
  // content '' 的空形态对齐 toAiMessages 的空 assistant 先例（string content）。
  const prefixMessage = { role: 'assistant', content: acc.content } as AiModelMessage;
  return { ...prompt, messages: [...prompt.messages, prefixMessage] };
}

export function finalToolInput(
  input: unknown,
  accumulatedArgsText: string,
): Record<string, unknown> | undefined {
  const hasAccumulatedArgs = accumulatedArgsText.trim().length > 0;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length > 0 || !hasAccumulatedArgs) {
      return record;
    }
  }
  return hasAccumulatedArgs ? undefined : {};
}

export function buildStreamResponse(acc: StreamAccumulator, config: ModelConfig): ModelResponse {
  const toolCalls: ToolCall[] = [...acc.toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .map((t) => ({
      id: t.id,
      name: t.name,
      // 权威 input（已解析对象）优先；provider 未在 tool-call 给 input 时回落解析累积的 argsText。
      ...extractToolCallMeta(t.input ?? safeParse(t.argsText), t.name),
    }));

  logger.debug('inferenceViaAiSdk done', {
    provider: config.provider, model: config.model,
    type: toolCalls.length ? 'tool_use' : 'text',
    toolCallCount: toolCalls.length,
    streaming: true,
  });

  return {
    type: toolCalls.length > 0 ? 'tool_use' : 'text',
    content: acc.content || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    contentParts: acc.contentParts.length > 0 ? acc.contentParts : undefined,
    thinking: acc.reasoning || undefined,
    usage: acc.usage || { inputTokens: 0, outputTokens: Math.ceil(acc.charCount / 4) },
    finishReason: acc.finishReason,
    truncated: acc.finishReason === 'length',
  };
}
