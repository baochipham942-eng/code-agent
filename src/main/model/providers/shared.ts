// ============================================================================
// Shared Utilities for Model Providers
// ============================================================================

import axios, { type AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ToolDefinition, ToolCall } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback, ToolCallAccumulator } from '../types';
import { ContextLengthExceededError } from '../types';
import { createLogger } from '../../services/infra/logger';

export const logger = createLogger('ModelRouter');

// ----------------------------------------------------------------------------
// Proxy Configuration
// ----------------------------------------------------------------------------

const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const USE_PROXY = !!PROXY_URL && process.env.NO_PROXY !== 'true' && process.env.DISABLE_PROXY !== 'true';
export const httpsAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : undefined;

logger.info(' Proxy:', USE_PROXY ? PROXY_URL : 'disabled (no proxy env var set)');

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
      timeout: 300000,
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
  } catch (error: any) {
    if (axios.isCancel(error) || error.name === 'AbortError' || error.name === 'CanceledError') {
      throw new Error('Request was cancelled');
    }
    throw new Error(`Network request failed: ${error.message}`);
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
export function normalizeJsonSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const normalized: any = { ...schema };

  if (schema.type === 'object') {
    if (normalized.additionalProperties === undefined) {
      normalized.additionalProperties = false;
    }

    if (normalized.properties) {
      const normalizedProps: any = {};
      for (const [key, value] of Object.entries(normalized.properties)) {
        normalizedProps[key] = normalizeJsonSchema(value);
      }
      normalized.properties = normalizedProps;
    }
  }

  if (schema.type === 'array' && normalized.items) {
    normalized.items = normalizeJsonSchema(normalized.items);
  }

  return normalized;
}

// ----------------------------------------------------------------------------
// Tool Conversion
// ----------------------------------------------------------------------------

/**
 * Convert tools to OpenAI format
 */
export function convertToolsToOpenAI(tools: ToolDefinition[], strict = false): any[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeJsonSchema(tool.inputSchema),
      ...(strict && { strict: true }),
    },
  }));
}

/**
 * Convert tools to Claude format
 */
export function convertToolsToClaude(tools: ToolDefinition[]): any[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

// ----------------------------------------------------------------------------
// Message Conversion
// ----------------------------------------------------------------------------

/**
 * Convert messages to OpenAI format
 */
export function convertToOpenAIMessages(messages: ModelMessage[]): any[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return {
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content,
      };
    }

    return {
      role: m.role === 'tool' ? 'user' : m.role,
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
}

/**
 * Convert messages to Claude format
 */
export function convertToClaudeMessages(messages: ModelMessage[]): any[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return {
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content,
      };
    }

    return {
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.content,
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
 * Safely parse JSON with better error messages
 */
export function safeParseJsonWithContext(jsonStr: string, context: string): any {
  try {
    return JSON.parse(jsonStr);
  } catch (error: any) {
    const position = error.message.match(/position (\d+)/)?.[1];
    const preview = position
      ? `...${jsonStr.substring(Math.max(0, parseInt(position) - 20), parseInt(position) + 20)}...`
      : jsonStr.substring(0, 100);
    throw new Error(`JSON parse error in ${context}: ${error.message}. Near: ${preview}`);
  }
}

/**
 * Attempt to repair common JSON issues
 */
export function repairJson(jsonStr: string): any | null {
  try {
    return JSON.parse(jsonStr);
  } catch {
    let repaired = jsonStr;

    const lastBrace = repaired.lastIndexOf('}');
    const lastBracket = repaired.lastIndexOf(']');

    if (lastBrace === -1 && lastBracket === -1) {
      return null;
    }

    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < repaired.length; i++) {
      const char = repaired[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        else if (char === '[') bracketCount++;
        else if (char === ']') bracketCount--;
      }
    }

    if (inString) {
      repaired += '"';
    }

    while (bracketCount > 0) {
      repaired += ']';
      bracketCount--;
    }

    while (braceCount > 0) {
      repaired += '}';
      braceCount--;
    }

    try {
      const result = JSON.parse(repaired);
      logger.info(' Successfully repaired JSON');
      return result;
    } catch {
      try {
        const match = jsonStr.match(/^\s*\{[\s\S]*?\}(?=\s*$|\s*,|\s*\])/);
        if (match) {
          return JSON.parse(match[0]);
        }
      } catch {
        // Ignore
      }

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
  if (!str || !str.trim()) return null;

  let repaired = str.trim();

  repaired = repaired.replace(/^[^{\[]*/, '');
  repaired = repaired.replace(/[^}\]]*$/, '');

  if (!repaired.startsWith('{') && !repaired.startsWith('[')) {
    return null;
  }

  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }
  }

  if (inString) {
    repaired += '"';
  }

  while (bracketCount > 0) {
    repaired += ']';
    bracketCount--;
  }

  while (braceCount > 0) {
    repaired += '}';
    braceCount--;
  }

  try {
    return JSON.parse(repaired);
  } catch {
    const lastComma = repaired.lastIndexOf(',');
    if (lastComma > 0) {
      const truncated = repaired.substring(0, lastComma) + '}';
      try {
        return JSON.parse(truncated);
      } catch {
        // Continue
      }
    }

    return null;
  }
}

/**
 * 从原始字符串提取键值对
 */
function extractKeyValuePairs(str: string): Record<string, unknown> | null {
  if (!str || !str.trim()) return null;

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
    logger.error('[parseOpenAIResponse] No choices in response:', dataPreview);
    throw new Error(`No response from model. Response: ${dataPreview}`);
  }

  const message = choice.message;

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: ToolCall[] = [];

    for (const tc of message.tool_calls) {
      try {
        const args = safeJsonParse(tc.function.arguments || '{}');
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        });
      } catch (parseError: any) {
        logger.error(`Failed to parse tool call arguments for ${tc.function.name}:`, parseError);
        const repairedArgs = repairJson(tc.function.arguments || '{}');
        if (repairedArgs) {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: repairedArgs,
          });
        } else {
          logger.error(' Could not repair JSON, raw arguments:', tc.function.arguments?.substring(0, 500));
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
      logger.error(' Failed to parse text-based tool call args:', argsStr.substring(0, 100), e);
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
 * Handle generic OpenAI-compatible stream
 * @param signal - AbortSignal for cancellation support
 */
export async function handleStream(
  body: ReadableStream<Uint8Array>,
  onStream: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let toolCalls: ToolCall[] = [];
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
        if (!line.trim().startsWith('data:')) continue;
        const data = line.replace('data:', '').trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            fullContent += delta.content;
            onStream(delta.content);
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = {
                    id: tc.id || '',
                    name: tc.function?.name || '',
                    arguments: {},
                  };
                }
                if (tc.function?.arguments) {
                  const existing = toolCalls[tc.index];
                  const args = existing.arguments as Record<string, string>;
                  args._raw = (args._raw || '') + tc.function.arguments;
                }
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Handle remaining buffer
    if (buffer.trim().startsWith('data:')) {
      const data = buffer.replace('data:', '').trim();
      if (data && data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            onStream(delta.content);
          }
        } catch {
          // Ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  toolCalls = toolCalls.filter(Boolean).map((tc) => {
    const args = tc.arguments as Record<string, string>;
    if (args._raw) {
      try {
        tc.arguments = JSON.parse(args._raw);
      } catch {
        tc.arguments = {};
      }
    }
    return tc;
  });

  if (toolCalls.length > 0) {
    return { type: 'tool_use', toolCalls };
  }

  return { type: 'text', content: fullContent };
}

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

/**
 * Create an SSE stream result builder
 */
export function createStreamResultBuilder() {
  let content = '';
  let finishReason: string | undefined;
  const toolCalls: Map<number, ToolCallAccumulator> = new Map();

  return {
    addContent(text: string) {
      content += text;
    },
    setFinishReason(reason: string) {
      finishReason = reason;
    },
    addToolCall(index: number, tc: Partial<ToolCallAccumulator>) {
      if (!toolCalls.has(index)) {
        toolCalls.set(index, {
          id: tc.id || `call_${index}`,
          name: tc.name || '',
          arguments: '',
        });
      }
      const existing = toolCalls.get(index)!;
      if (tc.id) existing.id = tc.id;
      if (tc.name) existing.name = tc.name;
      if (tc.arguments) existing.arguments += tc.arguments;
    },
    hasToolCalls() {
      return toolCalls.size > 0;
    },
    getToolCalls() {
      return toolCalls;
    },
    build(): ModelResponse {
      const truncated = finishReason === 'length';
      const result: ModelResponse = {
        type: toolCalls.size > 0 ? 'tool_use' : 'text',
        content: content || undefined,
        truncated,
        finishReason,
      };

      if (toolCalls.size > 0) {
        result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: safeJsonParse(tc.arguments),
        }));
      }

      return result;
    },
    getContent() {
      return content;
    },
    getFinishReason() {
      return finishReason;
    },
  };
}
