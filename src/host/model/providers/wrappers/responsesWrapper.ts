// ============================================================================
// Responses Wrapper — /responses 完整响应解析。
//
// 设计原则：schema 写在 provider 旁边；safeParse 失败只 logger.debug 降级；
// .passthrough() 容忍新增字段；只解析完整 JSON 响应，不在字节流层校验。
// ============================================================================
import { z } from 'zod';

import type { ToolCall, ToolDefinition } from '../../../../shared/contract';
import type { ModelResponse } from '../../types';
import { logger, safeJsonParse } from '../providerRuntime';
import { extractToolCallMeta } from '../toolCallMeta';
import { normalizeResponsesUsage } from './usageNormalization';

const OutputItemSchema = z.object({ type: z.string().optional() }).passthrough();
const ResponsesSchema = z.object({
  output: z.array(OutputItemSchema).optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    input_tokens_details: z.object({ cached_tokens: z.number().optional() }).passthrough().nullish(),
  }).passthrough().optional(),
}).passthrough();

type SearchTrace = NonNullable<ModelResponse['searchTrace']>[number];

/** Responses 的 function 定义是扁平 wire format，不能复用 chat-completions converter。 */
export function convertToolsToResponses(tools: ToolDefinition[]): Array<{
  type: 'function'; name: string; description: string; parameters: ToolDefinition['inputSchema'];
}> {
  return tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }));
}

// 与 OpenAI wrapper 对齐：代理偶尔给工具名包 functions_ 前缀及数字后缀。
function normalizeToolName(name: string): string {
  const withoutPrefix = name.startsWith('functions_') ? name.slice('functions_'.length) : name;
  return withoutPrefix.replace(/_\d+$/, '') || name;
}

function functionCallsOf(output: unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of output) {
    const record = item as Record<string, unknown>;
    if (record.type !== 'function_call' || typeof record.name !== 'string') continue;
    const rawArguments = typeof record.arguments === 'string' ? record.arguments : '{}';
    const argumentsObject = safeJsonParse(rawArguments);
    if (argumentsObject.__parseError) {
      logger.warn('[Responses] ignoring function call with invalid JSON arguments', { name: record.name });
      continue;
    }
    calls.push({
      id: typeof record.call_id === 'string' ? record.call_id : typeof record.id === 'string' ? record.id : `call_${calls.length}`,
      name: normalizeToolName(record.name),
      ...extractToolCallMeta(argumentsObject),
    });
  }
  return calls;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return textOf(record.text ?? record.content ?? record.value);
}

function reasoningText(item: Record<string, unknown>): string {
  return textOf(item.summary ?? item.content ?? item.text ?? item.reasoning);
}

function messageText(item: Record<string, unknown>): string {
  return textOf(item.content ?? item.text);
}

function searchTraceOf(item: Record<string, unknown>): SearchTrace {
  const action = item.action;
  const actionRecord = action && typeof action === 'object' ? action as Record<string, unknown> : {};
  return {
    ...(typeof item.id === 'string' ? { id: item.id } : {}),
    ...(typeof actionRecord.type === 'string' ? { action: actionRecord.type } : {}),
    ...(typeof actionRecord.query === 'string' ? { query: actionRecord.query } : {}),
    ...(typeof actionRecord.url === 'string' ? { url: actionRecord.url } : {}),
  };
}

/** 解析 Responses 完整返回体；未知项保留在 responsesOutput，保证下一轮可无损回填。 */
export function parseResponsesResponse(raw: unknown): ModelResponse {
  const parsed = ResponsesSchema.safeParse(raw);
  if (!parsed.success) {
    logger.debug('[Responses] schema mismatch; returning safe empty response', { issues: parsed.error.issues });
    return { type: 'text', content: '', responsesOutput: [] };
  }

  const output = parsed.data.output ?? [];
  const text: string[] = [];
  const thinking: string[] = [];
  const searchTrace: SearchTrace[] = [];
  const toolCalls = functionCallsOf(output);

  // 服务端 agent 循环会在每次工具调用前后各插一条 message，中间那些是过程旁白
  // （真机实测一次问答产生 7 条 message，前 6 条都是「让我打开官方文档核实…」这类交代下一步，
  // 只有最后一次工具调用之后的那条才是答案）。全部 join 起来会把旁白当正文喂给用户，
  // 所以以「最后一个 *_call 项」为界：界前的 message 进思考轨，界后的才是正文。
  const lastCallIndex = output.reduce(
    (last, item, index) => (String((item as Record<string, unknown>).type ?? '').endsWith('_call') ? index : last),
    -1,
  );

  output.forEach((item, index) => {
    const record = item as Record<string, unknown>;
    if (record.type === 'reasoning') {
      const value = reasoningText(record);
      if (value) thinking.push(value);
    } else if (record.type === 'web_search_call') {
      const trace = searchTraceOf(record);
      searchTrace.push(trace);
      logger.debug('[Responses] web search trace', trace);
    } else if (record.type === 'message') {
      const value = messageText(record);
      if (value) (index > lastCallIndex ? text : thinking).push(value);
    }
  });

  return {
    type: toolCalls.length ? 'tool_use' : 'text',
    content: text.join(''),
    ...(thinking.length ? { thinking: thinking.join('\n') } : {}),
    ...(parsed.data.usage ? { usage: normalizeResponsesUsage(parsed.data.usage) } : {}),
    responsesOutput: output,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(searchTrace.length ? { searchTrace } : {}),
  };
}
