import path from 'path';

import type { ModelConfig, ToolDefinition } from '../../shared/contract';
import type { ModelMessage, ModelResponse, StreamCallback } from './types';

const E2E_READ_TOOL_CALL_ID = 'e2e-real-agent-read-fixture';
const E2E_FIXTURE_MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shouldUseE2ELocalAgentModel(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_E2E === '1' && env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL === '1';
}

function getMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => part.text || part.thinking || part.compaction || '')
    .join('\n');
}

function hasFixtureToolResult(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'tool') return false;
    if (message.toolCallId === E2E_READ_TOOL_CALL_ID) return true;
    const content = getMessageText(message);
    return content.includes(E2E_FIXTURE_MARKER) || content.includes(E2E_READ_TOOL_CALL_ID);
  });
}

function resolveFixturePath(env: NodeJS.ProcessEnv): string {
  const configured = env.CODE_AGENT_E2E_AGENT_MODEL_READ_FILE?.trim();
  if (configured) return configured;
  return path.join(process.cwd(), 'package.json');
}

function hasReadTool(tools: ToolDefinition[]): boolean {
  return tools.some((tool) => tool.name === 'Read');
}

export function buildE2ELocalAgentModelResponse(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  env: NodeJS.ProcessEnv = process.env,
): ModelResponse {
  const actualProvider = 'acceptance';
  const actualModel = 'e2e-local-agent-model';

  if (hasFixtureToolResult(messages)) {
    const content = [
      'E2E real agent replay eval smoke completed.',
      `${E2E_FIXTURE_MARKER} observed through a real Read tool result.`,
    ].join(' ');
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text',
      content,
      finishReason: 'stop',
      actualProvider,
      actualModel,
      usage: { inputTokens: 180, outputTokens: 24 },
    };
  }

  if (!hasReadTool(tools)) {
    const content = `E2E local agent model could not find the Read tool for ${config.provider}/${config.model}.`;
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text',
      content,
      finishReason: 'stop',
      actualProvider,
      actualModel,
      usage: { inputTokens: 120, outputTokens: 18 },
    };
  }

  const fixturePath = resolveFixturePath(env);
  const toolCall = {
    id: E2E_READ_TOOL_CALL_ID,
    name: 'Read',
    arguments: {
      file_path: fixturePath,
      offset: 1,
      limit: 20,
    },
  };
  if (isRecord(toolCall.arguments)) {
    onStream?.({
      type: 'tool_call_start',
      toolCall: { index: 0, id: toolCall.id, name: toolCall.name },
    });
  }
  onStream?.({ type: 'complete', finishReason: 'tool_calls' });
  return {
    type: 'tool_use',
    content: 'Reading the E2E replay/eval fixture through the real tool executor.',
    toolCalls: [toolCall],
    finishReason: 'tool_calls',
    actualProvider,
    actualModel,
    usage: { inputTokens: 160, outputTokens: 32 },
    contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
  };
}
