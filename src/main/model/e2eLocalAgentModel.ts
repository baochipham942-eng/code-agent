import path from 'path';

import type { ModelConfig, ToolDefinition } from '../../shared/contract';
import type { ModelMessage, ModelResponse, StreamCallback } from './types';

const E2E_READ_TOOL_CALL_ID = 'e2e-real-agent-read-fixture';
const E2E_FIXTURE_MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';
const E2E_TASK_PANEL_MARKER = 'E2E_TASK_PANEL_SESSION_TASKS';
const E2E_TASK_CREATE_PREFIX = 'e2e-task-panel-create';
const E2E_TASK_CANCEL_CALL_ID = 'e2e-task-panel-cancel-old-path';

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

function hasTool(tools: ToolDefinition[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

function hasTaskPanelMarker(messages: ModelMessage[]): boolean {
  return messages.some((message) => getMessageText(message).includes(E2E_TASK_PANEL_MARKER));
}

export function shouldUseE2ELocalAgentModelForMessages(
  messages: ModelMessage[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return shouldUseE2ELocalAgentModel(env)
    || (env.CODE_AGENT_E2E === '1' && hasTaskPanelMarker(messages));
}

function findToolResultContent(messages: ModelMessage[], toolCallId: string): string | null {
  const match = messages.find((message) => (
    message.role === 'tool'
    && (
      message.toolCallId === toolCallId
      || getMessageText(message).includes(toolCallId)
    )
  ));
  return match ? getMessageText(match) : null;
}

function extractCreatedTaskId(messages: ModelMessage[], toolCallId: string): string | null {
  const content = findToolResultContent(messages, toolCallId);
  return content?.match(/Task #([^\s]+) created:/)?.[1] ?? null;
}

function taskManagerCall(id: string, args: Record<string, unknown>) {
  return { id, name: 'TaskManager', arguments: args };
}

function buildTaskPanelE2EResponse(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  onStream?: StreamCallback,
): ModelResponse | null {
  if (!hasTaskPanelMarker(messages)) return null;

  const actualProvider = 'acceptance';
  const actualModel = 'e2e-local-agent-model';

  if (!hasTool(tools, 'TaskManager')) {
    const content = 'E2E task panel smoke could not find the TaskManager tool.';
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text',
      content,
      finishReason: 'stop',
      actualProvider,
      actualModel,
      usage: { inputTokens: 120, outputTokens: 16 },
    };
  }

  if (findToolResultContent(messages, E2E_TASK_CANCEL_CALL_ID)) {
    const content = `E2E task panel real-agent smoke completed. ${E2E_TASK_PANEL_MARKER}`;
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text',
      content,
      finishReason: 'stop',
      actualProvider,
      actualModel,
      usage: { inputTokens: 220, outputTokens: 18 },
    };
  }

  const oldPathTaskId = extractCreatedTaskId(messages, `${E2E_TASK_CREATE_PREFIX}-3`);
  if (oldPathTaskId) {
    const toolCall = taskManagerCall(E2E_TASK_CANCEL_CALL_ID, {
      action: 'update',
      taskId: oldPathTaskId,
      status: 'cancelled',
    });
    onStream?.({
      type: 'tool_call_start',
      toolCall: { index: 0, id: toolCall.id, name: toolCall.name },
    });
    onStream?.({ type: 'complete', finishReason: 'tool_calls' });
    return {
      type: 'tool_use',
      content: 'Cancelling the obsolete task through TaskManager.',
      toolCalls: [toolCall],
      finishReason: 'tool_calls',
      actualProvider,
      actualModel,
      usage: { inputTokens: 210, outputTokens: 34 },
      contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
    };
  }

  const toolCalls = [
    taskManagerCall(`${E2E_TASK_CREATE_PREFIX}-1`, {
      action: 'create',
      subject: '梳理真实 agent 任务',
      description: '用真实 agent loop 创建右侧面板任务',
      activeForm: '梳理真实 agent 任务',
    }),
    taskManagerCall(`${E2E_TASK_CREATE_PREFIX}-2`, {
      action: 'create',
      subject: '执行保留路径',
      description: '保留仍然需要执行的任务路径',
      activeForm: '执行保留路径',
    }),
    taskManagerCall(`${E2E_TASK_CREATE_PREFIX}-3`, {
      action: 'create',
      subject: '放弃旧路径',
      description: '创建后用 cancelled 留痕，验证取消态进入任务面板',
      activeForm: '放弃旧路径',
    }),
  ];

  toolCalls.forEach((toolCall, index) => {
    onStream?.({
      type: 'tool_call_start',
      toolCall: { index, id: toolCall.id, name: toolCall.name },
    });
  });
  onStream?.({ type: 'complete', finishReason: 'tool_calls' });
  return {
    type: 'tool_use',
    content: 'Creating SessionTask records through the real TaskManager tool.',
    toolCalls,
    finishReason: 'tool_calls',
    actualProvider,
    actualModel,
    usage: { inputTokens: 190, outputTokens: 72 },
    contentParts: toolCalls.map((toolCall) => ({ type: 'tool_call' as const, toolCallId: toolCall.id })),
  };
}

export function buildE2ELocalAgentModelResponse(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  env: NodeJS.ProcessEnv = process.env,
): ModelResponse {
  const taskPanelResponse = buildTaskPanelE2EResponse(messages, tools, onStream);
  if (taskPanelResponse) return taskPanelResponse;

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
