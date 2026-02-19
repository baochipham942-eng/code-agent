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
import { MODEL_API_ENDPOINTS, API_VERSIONS, getModelMaxOutputTokens } from '../../../shared/constants';

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
    max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || 'claude-sonnet-4-20250514'),
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

  // Thinking support: add thinking parameter before tools/system to ensure correct API shape
  if (config.thinkingBudget) {
    requestBody.thinking = {
      type: 'enabled',
      budget_tokens: config.thinkingBudget,
    };
  }

  // Prompt caching: wrap system prompt and last tool definition with cache_control
  if (config.promptCaching?.enabled) {
    if (config.promptCaching.cacheSystem !== false && requestBody.system) {
      // Wrap system as structured block with cache_control
      requestBody.system = [
        {
          type: 'text',
          text: requestBody.system as string,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }
    // Add cache_control to the last tool definition
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
    'anthropic-version': API_VERSIONS.ANTHROPIC,
  };

  if (betaFeatures.length > 0) {
    headers['anthropic-beta'] = betaFeatures.join(',');
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
