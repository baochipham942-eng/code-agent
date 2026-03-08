// ============================================================================
// Anthropic Claude Provider Implementation
// ============================================================================

import https from 'https';
import http from 'http';
import { StringDecoder } from 'string_decoder';
import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  electronFetch,
  logger,
  httpsAgent,
  safeJsonParse,
  convertToolsToClaude,
  convertToClaudeMessages,
  parseClaudeResponse,
} from './shared';
import { MODEL_API_ENDPOINTS, API_VERSIONS, getModelMaxOutputTokens } from '../../../shared/constants';

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
      timeout: 300000,
    };

    const req = httpModule.request(reqOptions, (res) => {
      logger.info(`[Claude] SSE response status: ${res.statusCode}`); if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          logger.error('[Claude] API error:', res.statusCode, errorData);
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
        logger.debug(`[Claude] SSE chunk received: ${chunk.length} bytes`);
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

                logger.info('[Claude] stream complete:', {
                  contentLength: content.length,
                  toolCallCount: toolCalls.size,
                  finishReason,
                });

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
                logger.error('[Claude] stream error event:', errorMsg);
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
          resolve(result);
        } else {
          reject(new Error('[Claude] Stream ended with no content'));
        }
      });

      res.on('error', (err) => {
        logger.error('[Claude] Response error:', err);
        if (onStream) {
          onStream({ type: 'error', error: err.message });
        }
        reject(err);
      });
    });

    req.on('error', (err) => {
      const errCode = (err as NodeJS.ErrnoException).code;
      logger.error(`[Claude] Request error: ${err.message} (code=${errCode})`);
      if (onStream) {
        onStream({ type: 'error', error: err.message, errorCode: errCode });
      }
      reject(err);
    });

    req.on('timeout', () => {
      logger.error('[Claude] Request timeout');
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

/**
 * Call Claude API
 * @param signal - AbortSignal for cancellation support
 */
export async function callClaude(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || process.env.ANTHROPIC_BASE_URL || MODEL_API_ENDPOINTS.claude;

  // Convert messages for Claude format
  const systemMessage = messages.find((m) => m.role === 'system');
  const otherMessages = messages.filter((m) => m.role !== 'system');

  // Convert tools to Claude format
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
    requestBody.thinking = {
      type: 'enabled',
      budget_tokens: config.thinkingBudget,
    };
  }

  // Prompt caching
  if (config.promptCaching?.enabled) {
    if (config.promptCaching.cacheSystem !== false && requestBody.system) {
      requestBody.system = [
        {
          type: 'text',
          text: requestBody.system as string,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }
    if (Array.isArray(requestBody.tools) && (requestBody.tools as unknown[]).length > 0) {
      const tools = requestBody.tools as Array<Record<string, unknown>>;
      tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    }
  }

  // Beta headers
  const betaFeatures: string[] = [];
  if (config.computerUse) {
    betaFeatures.push('computer-use-2024-10-22');
  }
  if (config.promptCaching?.enabled) {
    betaFeatures.push('prompt-caching-2024-07-31');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey || '',
    'Authorization': `Bearer ${config.apiKey || ''}`,
    'anthropic-version': API_VERSIONS.ANTHROPIC,
  };

  if (betaFeatures.length > 0) {
    headers['anthropic-beta'] = betaFeatures.join(',');
  }

  // Check for cancellation
  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

  // Streaming mode
  if (onStream) {
    requestBody.stream = true;
    return claudeSSEStream({ baseUrl, headers, requestBody, onStream, signal });
  }

  // Non-streaming mode
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
