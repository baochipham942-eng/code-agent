// ============================================================================
// ClaudeProvider - Anthropic Claude API Provider 实现
// 自有 SSE 解析 + Messages API 格式 + Prompt Caching + Thinking
// ============================================================================

import https from 'https';
import http from 'http';
import { StringDecoder } from 'string_decoder';
import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage, ModelResponse, StreamCallback, ResponseContentPart, Provider } from '../types';
import {
  logger,
  httpsAgent,
  safeJsonParse,
  convertToolsToClaude,
  convertToClaudeMessages,
  parseClaudeResponse,
  electronFetch,
  normalizeClaudeBaseUrl,
} from './shared';
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
    let usageData: { inputTokens: number; outputTokens: number } | undefined;
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
      agent: isHttps ? httpsAgent : undefined,
      timeout: PROVIDER_TIMEOUT,
    };

    const req = httpModule.request(reqOptions, (res) => {
      logger.info(`[Claude] SSE response status: ${res.statusCode}`);
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          logger.warn('[Claude] API error:', res.statusCode, errorData);
          let errorMessage = `Claude API error: ${res.statusCode}`;
          try {
            const parsed = JSON.parse(errorData);
            if (parsed.error?.message) {
              errorMessage = `Claude API (${res.statusCode}): ${parsed.error.message}`;
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

          try {
            const parsed = JSON.parse(data);

            switch (currentEvent) {
              case 'message_start': {
                if (parsed.message?.usage) {
                  usageData = {
                    inputTokens: parsed.message.usage.input_tokens || 0,
                    outputTokens: parsed.message.usage.output_tokens || 0,
                  };
                }
                break;
              }

              case 'content_block_start': {
                const block = parsed.content_block;
                currentBlockType = block?.type || null;
                currentTextBuffer = '';
                if (block?.type === 'tool_use') {
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
                const delta = parsed.delta;
                if (delta?.type === 'text_delta' && delta.text) {
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
                } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
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
                } else if (delta?.type === 'thinking_delta' && delta.thinking) {
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
                if (parsed.delta?.stop_reason) {
                  finishReason = parsed.delta.stop_reason;
                }
                if (parsed.usage) {
                  usageData = {
                    inputTokens: usageData?.inputTokens || 0,
                    outputTokens: parsed.usage.output_tokens || usageData?.outputTokens || 0,
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
                  });
                }
                if (onStream) {
                  onStream({ type: 'complete', finishReason: finishReason || 'end_turn' });
                }

                resolve(result);
                return;
              }

              case 'error': {
                const errorMsg = parsed.error?.message || JSON.stringify(parsed);
                logger.warn('[Claude] stream error event:', errorMsg);
                if (onStream) {
                  onStream({ type: 'error', error: errorMsg });
                }
                reject(new Error(`Claude stream error: ${errorMsg}`));
                return;
              }
            }
          } catch {
            logger.debug(`[Claude] JSON parse skipped: ${data.substring(0, 50)}`);
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
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    // Auto-enable prompt caching if not explicitly configured
    const effectiveConfig = config.promptCaching
      ? config
      : { ...config, promptCaching: { enabled: true, cacheSystem: true } };

    const baseUrl = normalizeClaudeBaseUrl(
      effectiveConfig.baseUrl || process.env.ANTHROPIC_BASE_URL || MODEL_API_ENDPOINTS.claude
    );

    // System message 单独提取（Claude API 要求 system 不在 messages 数组中）
    const systemMessage = messages.find((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

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

    // Thinking support
    if (config.thinkingBudget) {
      if ((requestBody.max_tokens as number) <= config.thinkingBudget) {
        requestBody.max_tokens = config.thinkingBudget + 16384;
      }
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: config.thinkingBudget,
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
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return parseClaudeResponse(data);
  }
}
