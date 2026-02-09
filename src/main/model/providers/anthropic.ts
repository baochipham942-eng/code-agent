// ============================================================================
// Anthropic Claude Provider Implementation
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  electronFetch,
  convertToolsToClaude,
  convertToClaudeMessages,
  parseClaudeResponse,
} from './shared';
import { MODEL_API_ENDPOINTS, API_VERSIONS } from '../../../shared/constants';

/**
 * Call Claude API
 * @param signal - AbortSignal for cancellation support
 */
export async function callClaude(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  _onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = MODEL_API_ENDPOINTS.claude;

  // Convert messages for Claude format
  const systemMessage = messages.find((m) => m.role === 'system');
  const otherMessages = messages.filter((m) => m.role !== 'system');

  // Convert tools to Claude format
  const claudeTools = convertToolsToClaude(tools);

  // 如果启用 Computer Use，添加计算机工具
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
    model: config.model || 'claude-sonnet-4-20250514',
    max_tokens: config.maxTokens ?? 8192,
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

  // Computer Use beta header
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey || '',
    'anthropic-version': API_VERSIONS.ANTHROPIC,
  };

  if (config.computerUse) {
    headers['anthropic-beta'] = 'computer-use-2024-10-22';
  }

  // Check for cancellation before starting
  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

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
