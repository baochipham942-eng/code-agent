// ============================================================================
// Shared Utilities for Model Providers
// ============================================================================

import axios, { type AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ToolDefinition, ToolCall } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import { ContextLengthExceededError } from '../types';
import { createLogger } from '../../services/infra/logger';
import { PROVIDER_TIMEOUT } from '../../../shared/constants';

export const logger = createLogger('ModelRouter');

// ----------------------------------------------------------------------------
// Provider Message & Tool Types
// ----------------------------------------------------------------------------

/** OpenAI chat completion message format */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
  tool_calls?: Array<OpenAIToolCall>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

/** OpenAI tool call within an assistant message */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI function tool definition */
export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

/** Claude content block types */
interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;

/** Claude message format */
export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

/** Claude tool definition format */
interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** JSON Schema type for normalizeJsonSchema */
type JsonSchemaNode = Record<string, unknown>;

// ----------------------------------------------------------------------------
// Proxy Configuration
// ----------------------------------------------------------------------------

const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const USE_PROXY = !!PROXY_URL && process.env.NO_PROXY !== 'true' && process.env.DISABLE_PROXY !== 'true';
export const httpsAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : undefined;

// Proxy status logged on first inference call, not at module init (CLI mode timing issue)

// ----------------------------------------------------------------------------
// HTTP Utilities
// ----------------------------------------------------------------------------

/**
 * Helper function to wrap axios in a fetch-like interface for consistency
 * @param signal - AbortSignal for cancellation support
 */
export async function electronFetch(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; body?: ReadableStream<Uint8Array> }> {
  try {
    const response: AxiosResponse = await axios({
      url,
      method: options.method || 'GET',
      headers: options.headers,
      data: options.body ? JSON.parse(options.body) : undefined,
      timeout: PROVIDER_TIMEOUT,
      httpsAgent,
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      signal: options.signal,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
      json: async () => response.data,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (axios.isCancel(error) || (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'))) {
      throw new Error('Request was cancelled');
    }
    throw new Error(`Network request failed: ${errMsg}`);
  }
}

// ----------------------------------------------------------------------------
// Error Detection
// ----------------------------------------------------------------------------

/**
 * 检测错误消息是否为上下文超限错误，并提取相关信息
 */
export function parseContextLengthError(errorMessage: string, provider: string): ContextLengthExceededError | null {
  // DeepSeek 格式
  const deepseekMatch = errorMessage.match(
    /maximum context length is (\d+).*?requested (\d+)/i
  );
  if (deepseekMatch) {
    return new ContextLengthExceededError(
      parseInt(deepseekMatch[2]),
      parseInt(deepseekMatch[1]),
      provider
    );
  }

  // OpenAI 格式
  const openaiMatch = errorMessage.match(
    /maximum context length is (\d+).*?you requested (\d+)/i
  );
  if (openaiMatch) {
    return new ContextLengthExceededError(
      parseInt(openaiMatch[2]),
      parseInt(openaiMatch[1]),
      provider
    );
  }

  // Claude 格式
  const claudeMatch = errorMessage.match(
    /prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)/i
  );
  if (claudeMatch) {
    return new ContextLengthExceededError(
      parseInt(claudeMatch[1]),
      parseInt(claudeMatch[2]),
      provider
    );
  }

  // 通用检测
  if (/context.?length|token.?limit|max.?tokens?.*exceeded/i.test(errorMessage)) {
    const numbers = errorMessage.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      const sorted = numbers.map(n => parseInt(n)).sort((a, b) => b - a);
      return new ContextLengthExceededError(sorted[0], sorted[1], provider);
    }
  }

  return null;
}

// ----------------------------------------------------------------------------
// JSON Schema Normalization
// ----------------------------------------------------------------------------

/**
 * Normalize JSON Schema for better model compliance
 */
export function normalizeJsonSchema(schema: JsonSchemaNode | undefined | null): JsonSchemaNode | undefined | null {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const normalized: JsonSchemaNode = { ...schema };

  if (schema.type === 'object') {
    if (normalized.additionalProperties === undefined) {
      normalized.additionalProperties = false;
    }

    if (normalized.properties) {
      const normalizedProps: Record<string, JsonSchemaNode | undefined | null> = {};
      for (const [key, value] of Object.entries(normalized.properties)) {
        normalizedProps[key] = normalizeJsonSchema(value as JsonSchemaNode);
      }
      normalized.properties = normalizedProps;
    }
  }

  if (schema.type === 'array' && normalized.items) {
    normalized.items = normalizeJsonSchema(normalized.items as JsonSchemaNode);
  }

  return normalized;
}

// ----------------------------------------------------------------------------
// Tool Conversion
// ----------------------------------------------------------------------------

/**
 * Convert tools to OpenAI format
 */
export function convertToolsToOpenAI(tools: ToolDefinition[], strict = false): OpenAIToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeJsonSchema(tool.inputSchema as unknown as JsonSchemaNode) as Record<string, unknown>,
      ...(strict && { strict: true }),
    },
  }));
}

/**
 * Convert tools to Claude format
 */
export function convertToolsToClaude(tools: ToolDefinition[]): ClaudeToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as unknown as Record<string, unknown>,
  }));
}

function createToolCallIdNormalizer(messages: ModelMessage[]): (id: string) => string {
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();

  const remember = (original: string, normalized: string): string => {
    idMap.set(original, normalized);
    usedIds.add(normalized);
    return normalized;
  };

  for (const message of messages) {
    if (message.toolCalls?.length) {
      for (const toolCall of message.toolCalls) {
        if (toolCall.id && !idMap.has(toolCall.id)) {
          const candidate = /^[a-zA-Z0-9_-]+$/.test(toolCall.id)
            ? toolCall.id
            : toolCall.id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'tool_call';
          let normalized = candidate;
          let suffix = 1;
          while (usedIds.has(normalized)) {
            suffix += 1;
            normalized = `${candidate}_${suffix}`;
          }
          remember(toolCall.id, normalized);
        }
      }
    }
  }

  return (id: string): string => {
    const existing = idMap.get(id);
    if (existing) {
      return existing;
    }

    const candidate = id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'tool_call';
    let normalized = candidate;
    let suffix = 1;
    while (usedIds.has(normalized)) {
      suffix += 1;
      normalized = `${candidate}_${suffix}`;
    }
    return remember(id, normalized);
  };
}

// ----------------------------------------------------------------------------
// Message Conversion
// ----------------------------------------------------------------------------

/**
 * Convert messages to OpenAI format (supports structured tool_calls)
 * 包含 sanitizeToolCallOrder 后处理，确保 assistant+tool_calls 后紧跟 tool 响应
 */
export function convertToOpenAIMessages(messages: ModelMessage[]): OpenAIMessage[] {
  const normalizeToolCallId = createToolCallIdNormalizer(messages);
  const raw = messages.map((m) => {
    // 结构化工具调用（assistant + toolCalls）
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const msg: OpenAIMessage = {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: normalizeToolCallId(tc.id),
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      // Kimi K2.5 / DeepSeek: 推理模型要求 history 中保留 reasoning_content
      if (m.thinking) {
        msg.reasoning_content = m.thinking;
      }
      return msg;
    }
    // 结构化工具结果（role='tool' + toolCallId）
    if (m.role === 'tool' && m.toolCallId) {
      return {
        role: 'tool' as const,
        tool_call_id: normalizeToolCallId(m.toolCallId),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    }
    // 回退：无结构化数据的 tool 消息 → user
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: typeof m.content === 'string' ? m.content : '',
      };
    }
    // 其他消息（system, user, 无 toolCalls 的 assistant）
    if (typeof m.content === 'string') {
      return { role: m.role as OpenAIMessage['role'], content: m.content };
    }
    return {
      role: m.role as OpenAIMessage['role'],
      content: m.content.map((c) => {
        if (c.type === 'text') {
          return { type: 'text', text: c.text };
        }
        if (c.type === 'image' && c.source) {
          return {
            type: 'image_url',
            image_url: {
              url: `data:${c.source.media_type};base64,${c.source.data}`,
            },
          };
        }
        return c;
      }),
    };
  });

  return sanitizeToolCallOrder(raw);
}

/**
 * OpenAI 协议要求：assistant(+tool_calls) 后必须紧跟对应的 tool 响应消息。
 * agentLoop 会在 assistant 和 tool 之间注入 system 消息（thinking step、hook、nudge 等），
 * 导致 API 400 错误。此函数将这些夹层消息移到 tool 响应之后。
 */
function sanitizeToolCallOrder(messages: OpenAIMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      result.push(msg);
      i++;

      // 收集期望的 tool_call_ids
      const expectedIds = new Set<string>(msg.tool_calls.map((tc: OpenAIToolCall) => tc.id));
      const toolResponses: OpenAIMessage[] = [];
      const deferredMessages: OpenAIMessage[] = [];

      // 向前扫描，收集 tool 响应和需要延后的消息
      while (i < messages.length) {
        const next = messages[i];
        if (next.role === 'tool' && next.tool_call_id && expectedIds.has(next.tool_call_id)) {
          toolResponses.push(next);
          expectedIds.delete(next.tool_call_id);
          i++;
          if (expectedIds.size === 0) break; // 所有 tool_calls 都匹配到了
        } else if (next.role === 'assistant' || next.role === 'user') {
          // 遇到新的 assistant/user 消息，停止扫描（不跨轮次重排）
          break;
        } else {
          // system 消息或无 tool_call_id 的 tool 消息 → 延后
          deferredMessages.push(next);
          i++;
        }
      }

      // 先放 tool 响应（满足协议要求），再放延后的消息
      result.push(...toolResponses);
      result.push(...deferredMessages);
    } else {
      result.push(msg);
      i++;
    }
  }

  // Layer 3: 孤立 tool_call 检测 — 为缺失响应的 tool_call 合成占位 tool 消息
  // 原因：compaction 可能删除旧 tool 响应，留下孤立的 assistant(tool_calls)
  // 合成占位比删除 tool_call 更安全（OpenAI 协议不允许修改 assistant.tool_calls 数组）
  const allToolResponseIds = new Set<string>();
  for (const m of result) {
    if (m.role === 'tool' && m.tool_call_id) {
      allToolResponseIds.add(m.tool_call_id);
    }
  }

  const placeholders: OpenAIMessage[] = [];
  for (const m of result) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        if (!allToolResponseIds.has(tc.id)) {
          placeholders.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: '[context compacted]',
          });
          allToolResponseIds.add(tc.id); // 防止重复合成
        }
      }
    }
  }

  if (placeholders.length > 0) {
    // 将占位消息插入到对应 assistant 消息之后（而非末尾），以满足协议的顺序要求
    for (const ph of placeholders) {
      // 找到对应 assistant 消息的位置
      const assistantIdx = result.findIndex(
        m => m.role === 'assistant' && m.tool_calls?.some((tc: OpenAIToolCall) => tc.id === ph.tool_call_id)
      );
      if (assistantIdx >= 0) {
        // 在 assistant 之后、下一个 non-tool 消息之前插入
        let insertIdx = assistantIdx + 1;
        while (insertIdx < result.length && result[insertIdx].role === 'tool') {
          insertIdx++;
        }
        result.splice(insertIdx, 0, ph);
      } else {
        result.push(ph);
      }
    }
    logger.info(`[sanitizeToolCallOrder] Synthesized ${placeholders.length} placeholder tool responses for orphaned tool_calls`);
  }

  return result;
}

/**
 * Convert messages to Claude format (supports structured tool_use / tool_result)
 */
export function convertToClaudeMessages(messages: ModelMessage[]): ClaudeMessage[] {
  const normalizeToolCallId = createToolCallIdNormalizer(messages);
  const result: ClaudeMessage[] = [];

  for (const m of messages) {
    // assistant + toolCalls → content blocks with tool_use
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: ClaudeContentBlock[] = [];
      if (m.content && typeof m.content === 'string' && m.content.trim()) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.toolCalls) {
        let input: Record<string, unknown>;
        try { input = JSON.parse(tc.arguments); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: normalizeToolCallId(tc.id), name: tc.name, input });
      }
      result.push({ role: 'assistant', content: blocks });
      continue;
    }
    // tool result → user message with tool_result block
    // Claude 要求连续的 tool_result 合并为一个 user 消息
    if (m.role === 'tool' && m.toolCallId) {
      const lastMsg = result[result.length - 1];
      const toolResultBlock: ClaudeToolResultBlock = {
        type: 'tool_result',
        tool_use_id: normalizeToolCallId(m.toolCallId),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ...(m.toolError ? { is_error: true } : {}),
      };
      // 合并到前一个 user 消息（如果也是 tool_result）
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === 'tool_result') {
        lastMsg.content.push(toolResultBlock);
      } else {
        result.push({ role: 'user', content: [toolResultBlock] });
      }
      continue;
    }
    // 回退：无结构化的 tool 消息
    if (m.role === 'tool') {
      result.push({
        role: 'user' as const,
        content: typeof m.content === 'string' ? m.content : '',
      });
      continue;
    }
    // 其他消息保持不变
    if (typeof m.content === 'string') {
      result.push({ role: m.role as ClaudeMessage['role'], content: m.content });
    } else {
      result.push({ role: m.role as ClaudeMessage['role'], content: m.content as unknown as ClaudeContentBlock[] });
    }
  }

  // Sanitize: ensure every tool_use has a matching tool_result in the next user message
  return sanitizeClaudeToolPairing(result);
}

/**
 * Claude 协议要求：assistant 消息中的每个 tool_use 都必须在紧随其后的 user 消息中有对应 tool_result。
 * 此函数检测孤立的 tool_use 并合成 placeholder tool_result，防止 400 错误。
 */
function sanitizeClaudeToolPairing(messages: ClaudeMessage[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    // Check assistant messages with tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUseIds = (msg.content as ClaudeContentBlock[])
        .filter((b): b is ClaudeToolUseBlock => b.type === 'tool_use')
        .map(b => b.id);

      if (toolUseIds.length === 0) continue;

      // Look at the next message — should be a user message with matching tool_results
      const nextMsg = messages[i + 1];
      const existingResultIds = new Set<string>();
      if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
        for (const block of nextMsg.content as ClaudeContentBlock[]) {
          if (block.type === 'tool_result') {
            existingResultIds.add((block as ClaudeToolResultBlock).tool_use_id);
          }
        }
      }

      // Find orphaned tool_use ids
      const orphanedIds = toolUseIds.filter(id => !existingResultIds.has(id));
      if (orphanedIds.length > 0) {
        const placeholders: ClaudeToolResultBlock[] = orphanedIds.map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: '[context compacted]',
        }));

        if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
          // Append placeholders to existing user message
          (nextMsg.content as ClaudeContentBlock[]).push(...placeholders);
        } else {
          // Insert a new user message with placeholders before next message
          result.push({ role: 'user', content: placeholders as ClaudeContentBlock[] });
        }

        logger.info(`[sanitizeClaudeToolPairing] Synthesized ${orphanedIds.length} placeholder tool_results`);
      }
    }
  }

  return result;
}

/**
 * Convert messages to text-only format (for models that don't support tool calling)
 * 回退到纯文本：toolCalls → toolCallText, tool → user
 */
export function convertToTextOnlyMessages(messages: ModelMessage[]): any[] {
  return messages.map((m) => {
    // assistant + toolCallText → 纯文本回退
    if (m.role === 'assistant' && m.toolCallText) {
      return { role: 'assistant', content: m.toolCallText };
    }
    // tool → user（保持旧行为）
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return { role: 'user', content: m.toolCallId ? content : `Tool results:\n${content}` };
    }
    // 其他消息
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    return {
      role: m.role,
      content: m.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text };
        if (c.type === 'image' && c.source) {
          return {
            type: 'image_url',
            image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` },
          };
        }
        return c;
      }),
    };
  });
}

/**
 * Convert messages to Gemini format
 */
export function convertToGeminiMessages(messages: ModelMessage[]): any[] {
  const contents: any[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      contents.push({
        role: 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
      });
      contents.push({
        role: 'model',
        parts: [{ text: 'Understood. I will follow these instructions.' }],
      });
    } else if (m.role === 'user' || m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      });
    } else if (m.role === 'assistant') {
      contents.push({
        role: 'model',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      });
    }
  }

  return contents;
}

// ----------------------------------------------------------------------------
// Response Parsing
// ----------------------------------------------------------------------------

/**
 * 修复未闭合的 JSON 括号/引号
 */
function closeOpenBrackets(str: string): string {
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }
  }

  let result = str;
  if (inString) result += '"';
  while (bracketCount > 0) { result += ']'; bracketCount--; }
  while (braceCount > 0) { result += '}'; braceCount--; }
  return result;
}

/**
 * Attempt to repair common JSON issues
 */
function repairJson(jsonStr: string): any | null {
  try {
    return JSON.parse(jsonStr);
  } catch {
    if (jsonStr.lastIndexOf('}') === -1 && jsonStr.lastIndexOf(']') === -1) {
      return null;
    }

    const repaired = closeOpenBrackets(jsonStr);
    try {
      const result = JSON.parse(repaired);
      logger.info(' Successfully repaired JSON');
      return result;
    } catch {
      try {
        const match = jsonStr.match(/^\s*\{[\s\S]*?\}(?=\s*$|\s*,|\s*\])/);
        if (match) return JSON.parse(match[0]);
      } catch { /* Ignore */ }
      return null;
    }
  }
}

/**
 * 安全解析 JSON，支持多级备份提取策略
 */
export function safeJsonParse(str: string): Record<string, unknown> {
  // 策略 1: 直接解析
  try {
    const result = JSON.parse(str);
    logger.debug('[safeJsonParse] Direct parse succeeded');
    return result;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown parse error';
    logger.debug(`[safeJsonParse] Direct parse failed: ${errorMessage}, trying repair strategies...`);
  }

  // 策略 2: 修复常见 JSON 问题
  const repaired = repairJsonForArguments(str);
  if (repaired) {
    logger.info('[safeJsonParse] Repaired JSON parse succeeded');
    return repaired;
  }

  // 策略 3: 从原始字符串提取键值对
  const extracted = extractKeyValuePairs(str);
  if (extracted && Object.keys(extracted).length > 0) {
    logger.info('[safeJsonParse] Extracted key-value pairs:', Object.keys(extracted).join(', '));
    return extracted;
  }

  logger.warn('[safeJsonParse] All parse strategies failed');
  logger.warn(`[safeJsonParse] Raw arguments (first 500 chars): ${str.substring(0, 500)}`);
  return {
    __parseError: true,
    __errorMessage: 'All JSON parse strategies failed',
    __rawArguments: str.substring(0, 1000),
  };
}

/**
 * 修复常见的 JSON 问题用于 arguments 解析
 */
function repairJsonForArguments(str: string): Record<string, unknown> | null {
  if (!str?.trim()) return null;

  let repaired = str.trim();
  repaired = repaired.replace(/^[^{\[]*/, '');
  repaired = repaired.replace(/[^}\]]*$/, '');

  if (!repaired.startsWith('{') && !repaired.startsWith('[')) {
    return null;
  }

  repaired = closeOpenBrackets(repaired);

  try {
    return JSON.parse(repaired);
  } catch {
    const lastComma = repaired.lastIndexOf(',');
    if (lastComma > 0) {
      try { return JSON.parse(repaired.substring(0, lastComma) + '}'); } catch { /* Continue */ }
    }
    return null;
  }
}

/**
 * 从原始字符串提取键值对
 */
function extractKeyValuePairs(str: string): Record<string, unknown> | null {
  if (!str?.trim()) return null;

  const result: Record<string, unknown> = {};

  const stringPattern = /"(\w+)":\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  const numberPattern = /"(\w+)":\s*(-?\d+\.?\d*)/g;
  const booleanPattern = /"(\w+)":\s*(true|false)/g;
  const nullPattern = /"(\w+)":\s*null/g;

  let match;
  while ((match = stringPattern.exec(str)) !== null) {
    result[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  while ((match = numberPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = parseFloat(match[2]);
    }
  }

  while ((match = booleanPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = match[2] === 'true';
    }
  }

  while ((match = nullPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = null;
    }
  }

  const arrayPattern = /"(\w+)":\s*\[([^\]]*)\]/g;
  while ((match = arrayPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      try {
        result[match[1]] = JSON.parse(`[${match[2]}]`);
      } catch {
        result[match[1]] = match[2].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse OpenAI-compatible response
 */
export function parseOpenAIResponse(data: any): ModelResponse {
  const choice = data.choices?.[0];
  if (!choice) {
    const dataPreview = JSON.stringify(data).substring(0, 200);
    logger.warn('[parseOpenAIResponse] No choices in response:', dataPreview);
    throw new Error(`No response from model. Response: ${dataPreview}`);
  }

  const message = choice.message;

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: ToolCall[] = [];

    for (const tc of message.tool_calls) {
      // 规范化工具名：去掉代理层添加的 functions_ 前缀和 _N 数字后缀
      const rawName = tc.function.name;
      const normalizedName = rawName.startsWith('functions_')
        ? rawName.slice('functions_'.length).replace(/_\d+$/, '') || rawName
        : rawName;

      try {
        const args = safeJsonParse(tc.function.arguments || '{}');
        toolCalls.push({
          id: tc.id,
          name: normalizedName,
          arguments: args,
        });
      } catch (parseError: unknown) {
        logger.warn(`Failed to parse tool call arguments for ${normalizedName}:`, parseError);
        const repairedArgs = repairJson(tc.function.arguments || '{}');
        if (repairedArgs) {
          toolCalls.push({
            id: tc.id,
            name: normalizedName,
            arguments: repairedArgs,
          });
        } else {
          logger.warn(' Could not repair JSON, raw arguments:', tc.function.arguments?.substring(0, 500));
          const content = message.content || `Tool call failed: ${tc.function.name} - Invalid JSON arguments`;
          return { type: 'text', content };
        }
      }
    }

    if (toolCalls.length > 0) {
      return { type: 'tool_use', toolCalls };
    }
  }

  const content = message.content || '';

  // Fallback: parse text-based tool calls
  const textToolCallMatch = content.match(/Calling\s+(\w+)\s*\(/);
  if (textToolCallMatch) {
    const toolName = textToolCallMatch[1];
    const callStart = content.indexOf(textToolCallMatch[0]);
    const argsStart = callStart + textToolCallMatch[0].length;

    let depth = 1;
    let argsEnd = argsStart;
    for (let i = argsStart; i < content.length && depth > 0; i++) {
      if (content[i] === '{' || content[i] === '[') depth++;
      else if (content[i] === '}' || content[i] === ']') depth--;
      else if (content[i] === ')' && depth === 1) {
        argsEnd = i;
        break;
      }
      argsEnd = i + 1;
    }

    const argsStr = content.slice(argsStart, argsEnd);
    try {
      const args = safeJsonParse(argsStr);
      logger.info(' Parsed text-based tool call:', toolName);
      return {
        type: 'tool_use',
        toolCalls: [{
          id: `text-${Date.now()}`,
          name: toolName,
          arguments: args,
        }],
      };
    } catch (e) {
      logger.warn(' Failed to parse text-based tool call args:', argsStr.substring(0, 100), e);
    }
  }

  return { type: 'text', content };
}

/**
 * Parse Claude response
 */
export function parseClaudeResponse(data: any): ModelResponse {
  const content = data.content;
  if (!content || content.length === 0) {
    throw new Error('No response from model');
  }

  const toolUseBlocks = content.filter((block: any) => block.type === 'tool_use');
  if (toolUseBlocks.length > 0) {
    const toolCalls: ToolCall[] = toolUseBlocks.map((block: any) => ({
      id: block.id,
      name: block.name,
      arguments: block.input || {},
    }));

    return { type: 'tool_use', toolCalls };
  }

  const textBlocks = content.filter((block: any) => block.type === 'text');
  const text = textBlocks.map((block: any) => block.text).join('\n');

  return { type: 'text', content: text };
}

/**
 * Parse Gemini response
 */
export function parseGeminiResponse(data: any): ModelResponse {
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('No response from Gemini');
  }

  const content = candidate.content?.parts?.[0]?.text || '';
  const toolCalls: ToolCall[] = [];

  const functionCalls = candidate.content?.parts?.filter((p: any) => p.functionCall);
  if (functionCalls?.length > 0) {
    for (const fc of functionCalls) {
      toolCalls.push({
        id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: fc.functionCall.name,
        arguments: fc.functionCall.args || {},
      });
    }
  }

  return {
    type: toolCalls.length > 0 ? 'tool_use' : 'text',
    content,
    toolCalls,
  };
}

// ----------------------------------------------------------------------------
// Streaming Utilities
// ----------------------------------------------------------------------------

/**
 * Handle Gemini stream
 * @param signal - AbortSignal for cancellation support
 */
export async function handleGeminiStream(
  body: ReadableStream<Uint8Array>,
  onStream: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';

  if (signal) {
    signal.addEventListener('abort', () => {
      reader.cancel('Request cancelled').catch(() => {});
    }, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Request was cancelled');
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line.startsWith('data: [DONE]')) continue;

        try {
          const cleanLine = line.replace(/^data:\s*/, '');
          if (!cleanLine) continue;

          const json = JSON.parse(cleanLine);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            fullContent += text;
            onStream({ type: 'text', content: text });
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { type: 'text', content: fullContent, toolCalls: [] };
}
