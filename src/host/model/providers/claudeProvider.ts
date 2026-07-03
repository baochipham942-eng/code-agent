// ============================================================================
// ClaudeProvider - Anthropic Claude API Provider 实现
// 自有 SSE 解析 + Messages API 格式 + Prompt Caching + Thinking
// ============================================================================

import https from 'https';
import http from 'http';
import { StringDecoder } from 'string_decoder';
import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage, ModelResponse, StreamCallback, ResponseContentPart, Provider, InferenceOptions } from '../types';
import {
  logger,
  getHttpsAgent,
  safeJsonParse,
  convertToolsToClaude,
  convertToClaudeMessages,
  parseClaudeResponse,
  electronFetch,
  normalizeClaudeBaseUrl,
} from './shared';
import { parseClaudeSSEEvent } from './wrappers/anthropicWrapper';
import { normalizeClaudeUsage } from './wrappers/usageNormalization';
import { MODEL_API_ENDPOINTS, API_VERSIONS, getModelMaxOutputTokens, PROVIDER_TIMEOUT } from '../../../shared/constants';

/**
 * Claude SSE 流式请求处理
 */
function claudeSSEStream(options: {
  baseUrl: string;
  headers: Record<string, string>;
  requestBody: Record<string, unknown>;
  onStream?: StreamCallback;
  signal?: AbortSignal;
}): Promise<ModelResponse> {
  const { baseUrl, headers, requestBody, onStream, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was cancelled before starting'));
      return;
    }

    const url = new URL(`${baseUrl}/messages`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    let content = '';
    let thinking = '';
    let finishReason: string | undefined;
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let blockIndex = 0;
    let charCount = 0;
    let lastEstimateTime = 0;
    let usageData:
      | { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
      | undefined;
    const contentParts: ResponseContentPart[] = [];
    let currentBlockType: 'text' | 'tool_use' | 'thinking' | null = null;
    let currentTextBuffer = '';

    const reqOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'text/event-stream',
      },
      agent: isHttps ? getHttpsAgent(url.href, 'claude') : undefined,
      timeout: PROVIDER_TIMEOUT,
    };

    const req = httpModule.request(reqOptions, (res) => {
      logger.info(`[Claude] SSE response status: ${res.statusCode}`);
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          logger.warn('[Claude] API error:', res.statusCode, errorData);
          let errorMessage: string;
          try {
            // Anthropic 官方格式: {error: {message}}；中转/代理常见: {code, message} 平级。
            // 两种都兜住，保证 error message 携带 "insufficient balance" 等关键词，
            // 下游 retryStrategy.NON_RETRYABLE_PATTERNS 才能正确识别并熔断。
            const parsed = JSON.parse(errorData) as { error?: { message?: string }; message?: string };
            const realMessage = parsed.error?.message || parsed.message;
            if (realMessage) {
              errorMessage = `Claude API (${res.statusCode}): ${realMessage}`;
            } else {
              errorMessage = `Claude API error: ${res.statusCode} - ${errorData.substring(0, 200)}`;
            }
          } catch {
            errorMessage = `Claude API error: ${res.statusCode} - ${errorData.substring(0, 200)}`;
          }
          if (onStream) {
            onStream({ type: 'error', error: errorMessage, errorCode: String(res.statusCode) });
          }
          reject(new Error(errorMessage));
        });
        return;
      }

      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let currentEvent = '';

      res.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
            continue;
          }

          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();

          let rawParsed: unknown;
          try {
            rawParsed = JSON.parse(data);
          } catch {
            logger.debug(`[Claude] JSON parse skipped: ${data.substring(0, 50)}`);
            continue;
          }

          // zod 验证 + discriminatedUnion narrow（schema 失败返回 null，hot path 安全降级）
          const event = parseClaudeSSEEvent(currentEvent, rawParsed);
          if (!event) continue;

          {
            switch (event.type) {
              case 'message_start': {
                if (event.message.usage) {
                  // cache_read/cache_creation 在 message_start 报告，归一化后带回预算层
                  usageData = normalizeClaudeUsage(event.message.usage);
                }
                break;
              }

              case 'content_block_start': {
                const block = event.content_block;
                // server_tool_use 等未识别 block 类型保持 null（与旧行为一致）
                currentBlockType =
                  block.type === 'text' || block.type === 'tool_use' || block.type === 'thinking'
                    ? block.type
                    : null;
                currentTextBuffer = '';
                if (block.type === 'tool_use') {
                  toolCalls.set(blockIndex, {
                    id: block.id || `call_${blockIndex}`,
                    name: block.name || '',
                    arguments: '',
                  });
                  if (onStream) {
                    onStream({
                      type: 'tool_call_start',
                      toolCall: {
                        index: blockIndex,
                        id: block.id || `call_${blockIndex}`,
                        name: block.name || '',
                      },
                    });
                  }
                }
                break;
              }

              case 'content_block_delta': {
                const delta = event.delta;
                if (delta.type === 'text_delta' && delta.text) {
                  content += delta.text;
                  currentTextBuffer += delta.text;
                  charCount += delta.text.length;
                  if (onStream) {
                    onStream({ type: 'text', content: delta.text });
                    const now = Date.now();
                    if (now - lastEstimateTime > 500) {
                      lastEstimateTime = now;
                      onStream({
                        type: 'token_estimate',
                        inputTokens: 0,
                        outputTokens: Math.ceil(charCount / 4),
                      });
                    }
                  }
                } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                  const existing = toolCalls.get(blockIndex);
                  if (existing) {
                    existing.arguments += delta.partial_json;
                    if (onStream) {
                      onStream({
                        type: 'tool_call_delta',
                        toolCall: {
                          index: blockIndex,
                          argumentsDelta: delta.partial_json,
                        },
                      });
                    }
                  }
                } else if (delta.type === 'thinking_delta' && delta.thinking) {
                  thinking += delta.thinking;
                  if (onStream) {
                    onStream({ type: 'reasoning', content: delta.thinking });
                  }
                }
                break;
              }

              case 'content_block_stop': {
                if (currentBlockType === 'text' && currentTextBuffer) {
                  contentParts.push({ type: 'text', text: currentTextBuffer });
                } else if (currentBlockType === 'tool_use') {
                  const tc = toolCalls.get(blockIndex);
                  if (tc) {
                    contentParts.push({ type: 'tool_call', toolCallId: tc.id });
                  }
                }
                currentBlockType = null;
                currentTextBuffer = '';
                blockIndex++;
                break;
              }

              case 'message_delta': {
                if (event.delta.stop_reason) {
                  finishReason = event.delta.stop_reason;
                }
                if (event.usage) {
                  usageData = {
                    ...usageData,
                    inputTokens: usageData?.inputTokens ?? 0,
                    outputTokens: event.usage.output_tokens ?? usageData?.outputTokens ?? 0,
                  };
                }
                break;
              }

              case 'message_stop': {
                const truncated = finishReason === 'max_tokens';
                const result: ModelResponse = {
                  type: toolCalls.size > 0 ? 'tool_use' : 'text',
                  content: content || undefined,
                  truncated,
                  finishReason,
                  thinking: thinking || undefined,
                  usage: usageData || { inputTokens: 0, outputTokens: Math.ceil(charCount / 4) },
                };

                if (toolCalls.size > 0) {
                  result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: safeJsonParse(tc.arguments),
                  }));
                }
                if (contentParts.length > 1 || (contentParts.length === 1 && toolCalls.size > 0 && content)) {
                  result.contentParts = contentParts;
                }

                if (onStream && usageData) {
                  onStream({
                    type: 'usage',
                    inputTokens: usageData.inputTokens,
                    outputTokens: usageData.outputTokens,
                    cacheReadTokens: usageData.cacheReadTokens,
                    cacheCreationTokens: usageData.cacheCreationTokens,
                  });
                }
                if (onStream) {
                  onStream({ type: 'complete', finishReason: finishReason || 'end_turn' });
                }

                resolve(result);
                return;
              }

              case 'error': {
                const errorMsg = event.error.message || JSON.stringify(event);
                logger.warn('[Claude] stream error event:', errorMsg);
                if (onStream) {
                  onStream({ type: 'error', error: errorMsg });
                }
                reject(new Error(`Claude stream error: ${errorMsg}`));
                return;
              }

              case 'ping':
                // ping 事件用于保持连接活跃，无需处理
                break;
            }
          }
        }
      });

      res.on('end', () => {
        if (content || toolCalls.size > 0) {
          const result: ModelResponse = {
            type: toolCalls.size > 0 ? 'tool_use' : 'text',
            content: content || undefined,
            finishReason,
            thinking: thinking || undefined,
            usage: usageData || { inputTokens: 0, outputTokens: Math.ceil(charCount / 4) },
          };
          if (toolCalls.size > 0) {
            result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: safeJsonParse(tc.arguments),
            }));
          }
          if (contentParts.length > 1 || (contentParts.length === 1 && toolCalls.size > 0 && content)) {
            result.contentParts = contentParts;
          }
          resolve(result);
        } else {
          reject(new Error('[Claude] Stream ended with no content'));
        }
      });

      res.on('error', (err) => {
        logger.warn('[Claude] Response error:', err);
        if (onStream) {
          onStream({ type: 'error', error: err.message });
        }
        reject(err);
      });
    });

    req.on('error', (err) => {
      const errCode = (err as NodeJS.ErrnoException).code;
      logger.warn(`[Claude] Request error: ${err.message} (code=${errCode})`);
      if (onStream) {
        onStream({ type: 'error', error: err.message, errorCode: errCode });
      }
      reject(err);
    });

    req.on('timeout', () => {
      logger.warn('[Claude] Request timeout');
      req.destroy(new Error('Claude API request timeout'));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Request was cancelled'));
      }, { once: true });
    }

    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

export class ClaudeProvider implements Provider {
  readonly name = 'Claude';

  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse> {
    // Auto-enable prompt caching if not explicitly configured
    const effectiveConfig = config.promptCaching
      ? config
      : { ...config, promptCaching: { enabled: true, cacheSystem: true } };

    const baseUrl = normalizeClaudeBaseUrl(
      effectiveConfig.baseUrl || process.env.ANTHROPIC_BASE_URL || MODEL_API_ENDPOINTS.claude
    );

    // 动态尾巴（transient system）先转成历史末尾的 user + <system-reminder>：
    // 本路径只保留首条 system 进 system 参数、其余 system 全部丢弃，不转换会静默丢失；
    // 且尾巴每请求变化，进 system 参数会打掉 prompt cache 前缀。
    const normalizedMessages = messages.map((m) =>
      m.role === 'system' && m.transient && typeof m.content === 'string'
        ? { ...m, role: 'user', content: `<system-reminder>\n${m.content}\n</system-reminder>`, transient: undefined }
        : m,
    );
    // System message 单独提取（Claude API 要求 system 不在 messages 数组中）
    const systemMessage = normalizedMessages.find((m) => m.role === 'system');
    const otherMessages = normalizedMessages.filter((m) => m.role !== 'system');

    const claudeTools = convertToolsToClaude(tools);

    // Computer Use support
    if (config.computerUse) {
      claudeTools.push({
        name: 'computer',
        description: 'Control computer screen, mouse and keyboard',
        input_schema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['screenshot', 'click', 'type', 'scroll', 'key', 'move'],
              description: 'The action to perform',
            },
            coordinate: {
              type: 'array',
              description: '[x, y] coordinate for click/move actions',
            },
            text: {
              type: 'string',
              description: 'Text to type',
            },
          },
          required: ['action'],
        },
      });
    }

    const requestBody: Record<string, unknown> = {
      model: config.model || 'claude-sonnet-4-6',
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || 'claude-sonnet-4-6'),
      messages: convertToClaudeMessages(otherMessages),
    };

    if (systemMessage) {
      requestBody.system =
        typeof systemMessage.content === 'string'
          ? systemMessage.content
          : systemMessage.content[0]?.text || '';
    }

    if (claudeTools.length > 0) {
      requestBody.tools = claudeTools;
    }

    // Thinking support. Caller-supplied thinkingBudget wins; otherwise map
    // the cross-provider reasoningEffort hint (from options or config) into a
    // numeric budget so callers — e.g. modelRouter's artifact-path default of
    // reasoningEffort='low' — also get extended thinking on claude without
    // having to set thinkingBudget explicitly.
    const reasoningEffort = options?.reasoningEffort ?? config.reasoningEffort;
    const thinkingBudget = config.thinkingBudget
      ?? (reasoningEffort
        ? (reasoningEffort === 'low' ? 4096 : reasoningEffort === 'medium' ? 16384 : 32768)
        : undefined);
    if (thinkingBudget) {
      if ((requestBody.max_tokens as number) <= thinkingBudget) {
        requestBody.max_tokens = thinkingBudget + 16384;
      }
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };
    }

    // Prompt caching
    if (effectiveConfig.promptCaching?.enabled) {
      if (effectiveConfig.promptCaching.cacheSystem !== false && requestBody.system) {
        requestBody.system = [
          {
            type: 'text',
            text: requestBody.system as string,
            cache_control: { type: 'ephemeral' },
          },
        ];
      }
      if (Array.isArray(requestBody.tools) && (requestBody.tools as unknown[]).length > 0) {
        const toolsArr = requestBody.tools as Array<Record<string, unknown>>;
        toolsArr[toolsArr.length - 1].cache_control = { type: 'ephemeral' };
      }
    }

    // Beta headers
    const betaFeatures: string[] = [];
    if (config.computerUse) {
      betaFeatures.push('computer-use-2024-10-22');
    }
    if (effectiveConfig.promptCaching?.enabled) {
      betaFeatures.push('prompt-caching-2024-07-31');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey || '',
      'anthropic-version': API_VERSIONS.ANTHROPIC,
    };

    if (betaFeatures.length > 0) {
      headers['anthropic-beta'] = betaFeatures.join(',');
    }

    if (signal?.aborted) {
      throw new Error('Request was cancelled before starting');
    }

    // Streaming mode
    if (onStream) {
      requestBody.stream = true;
      return claudeSSEStream({ baseUrl, headers, requestBody, onStream, signal });
    }

    // Non-streaming fallback
    const response = await electronFetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
      provider: config.provider,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${error}`);
    }

    const data: unknown = await response.json();
    return parseClaudeResponse(data);
  }
}
