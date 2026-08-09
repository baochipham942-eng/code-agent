import path from 'path';

import type { ModelConfig, ToolDefinition } from '../../shared/contract';
import type { ModelMessage, ModelResponse, StreamCallback } from './types';

const E2E_READ_TOOL_CALL_ID = 'e2e-real-agent-read-fixture';
const E2E_FIXTURE_MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';
const E2E_TASK_PANEL_MARKER = 'E2E_TASK_PANEL_SESSION_TASKS';
const E2E_TASK_CREATE_PREFIX = 'e2e-task-panel-create';
const E2E_TASK_COMPLETE_SCOPE_CALL_ID = 'e2e-task-panel-complete-scope';
const E2E_TASK_START_RETAINED_CALL_ID = 'e2e-task-panel-start-retained-path';
const E2E_TASK_CANCEL_CALL_ID = 'e2e-task-panel-cancel-old-path';
const E2E_TASK_COMPLETE_RETAINED_CALL_ID = 'e2e-task-panel-complete-retained-path';
const E2E_WEB_SEARCH_MARKER = 'E2E_WEB_SEARCH_TOOL';
const E2E_WEB_SEARCH_CALL_ID = 'e2e-web-search-cloud-key';
const E2E_COMMAND_CENTER_MARKER = 'E2E_SESSION_COMMAND_CENTER';
const E2E_COMMAND_CENTER_SPAWN_CALL_ID = 'e2e-command-center-spawn';
const E2E_COMMAND_CENTER_SECOND_CALL_ID = 'e2e-command-center-second';
const E2E_COMMAND_CENTER_STATUS_CALL_ID = 'e2e-command-center-status';
const E2E_COMMAND_CENTER_STEER_CALL_ID = 'e2e-command-center-steer';
const E2E_BACKGROUND_APPROVAL_MARKER = 'E2E_BACKGROUND_APPROVAL';
const E2E_BACKGROUND_APPROVAL_CALL_ID = 'e2e-background-approval';

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

function hasWebSearchMarker(messages: ModelMessage[]): boolean {
  return messages.some((message) => getMessageText(message).includes(E2E_WEB_SEARCH_MARKER));
}

function hasCommandCenterMarker(messages: ModelMessage[]): boolean {
  return messages.some((message) => getMessageText(message).includes(E2E_COMMAND_CENTER_MARKER));
}

function latestUserText(messages: ModelMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === 'user');
  return latest ? getMessageText(latest) : '';
}

export function shouldUseE2ELocalAgentModelForMessages(
  messages: ModelMessage[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return shouldUseE2ELocalAgentModel(env)
    || (env.CODE_AGENT_E2E === '1' && (hasTaskPanelMarker(messages) || hasCommandCenterMarker(messages)));
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

function buildBackgroundApprovalE2EResponse(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  onStream?: StreamCallback,
): ModelResponse | null {
  if (!messages.some((message) => getMessageText(message).includes(E2E_BACKGROUND_APPROVAL_MARKER))) return null;
  if (hasTool(tools, 'delegate_task')) return null;
  const actualProvider = 'acceptance';
  const actualModel = 'e2e-local-agent-model';
  const result = findToolResultContent(messages, E2E_BACKGROUND_APPROVAL_CALL_ID);
  if (result) {
    const content = `E2E background approval completed. ${result}`;
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text', content, finishReason: 'stop', actualProvider, actualModel,
      usage: { inputTokens: 140, outputTokens: 24 },
    };
  }
  if (!hasTool(tools, 'AskUserQuestion')) {
    const content = 'E2E background approval could not find AskUserQuestion.';
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text', content, finishReason: 'stop', actualProvider, actualModel,
      usage: { inputTokens: 100, outputTokens: 16 },
    };
  }
  const toolCall = {
    id: E2E_BACKGROUND_APPROVAL_CALL_ID,
    name: 'AskUserQuestion',
    arguments: {
      questions: [{
        header: '后台审批',
        question: '允许后台任务继续完成验收吗？',
        options: [
          { label: '允许（推荐）', description: '继续只读验收并回流结果。' },
          { label: '拒绝', description: '终止本次后台验收。' },
        ],
        multiSelect: false,
      }],
    },
  };
  onStream?.({ type: 'tool_call_start', toolCall: { index: 0, id: toolCall.id, name: toolCall.name } });
  onStream?.({ type: 'complete', finishReason: 'tool_calls' });
  return {
    type: 'tool_use',
    content: 'Waiting for a real background approval response.',
    toolCalls: [toolCall],
    finishReason: 'tool_calls',
    actualProvider,
    actualModel,
    usage: { inputTokens: 130, outputTokens: 36 },
    contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
  };
}

function buildCommandCenterE2EResponse(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  onStream?: StreamCallback,
): ModelResponse | null {
  if (!hasCommandCenterMarker(messages)) return null;

  const actualProvider = 'acceptance';
  const actualModel = 'e2e-local-agent-model';
  const userText = latestUserText(messages);
  const statusRequested = userText.includes('STATUS');
  const steerRequested = userText.includes('STEER');
  const secondRequested = userText.includes('SECOND');
  const callId = statusRequested
    ? E2E_COMMAND_CENTER_STATUS_CALL_ID
    : steerRequested
      ? E2E_COMMAND_CENTER_STEER_CALL_ID
      : secondRequested
        ? E2E_COMMAND_CENTER_SECOND_CALL_ID
        : E2E_COMMAND_CENTER_SPAWN_CALL_ID;
  const toolName = statusRequested ? 'task_status' : steerRequested ? 'steer_task' : 'delegate_task';
  const result = findToolResultContent(messages, callId);
  if (result) {
    const content = statusRequested
      ? `E2E command center status completed. ${result}`
      : `E2E command center dispatch accepted. ${result}`;
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text',
      content,
      finishReason: 'stop',
      actualProvider,
      actualModel,
      usage: { inputTokens: 160, outputTokens: 28 },
    };
  }

  if (!hasTool(tools, toolName)) {
    const content = `E2E command center smoke could not find the ${toolName} tool.`;
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

  const toolCall = statusRequested
    ? { id: callId, name: toolName, arguments: {} }
    : steerRequested
      ? {
        id: callId,
        name: toolName,
        arguments: { target: '审批任务', instruction: '用户补充：审批通过后明确写出已收到转向要求。' },
      }
      : secondRequested
        ? {
          id: callId,
          name: toolName,
          arguments: {
            title: '后台审批验收',
            short_name: '审批任务',
            lane_key: 'acceptance-approval',
            submission_key: 'e2e-command-center-approval',
            prompt: E2E_BACKGROUND_APPROVAL_MARKER,
          },
        }
        : {
      id: callId,
      name: toolName,
      arguments: {
        title: '读取项目身份',
        short_name: '项目身份',
        lane_key: 'acceptance-read',
        submission_key: 'e2e-command-center-project-identity',
        prompt: '只读检查当前项目 package.json 的 name 与 version，并用一句话给出结论。',
      },
    };
  onStream?.({
    type: 'tool_call_start',
    toolCall: { index: 0, id: toolCall.id, name: toolCall.name },
  });
  onStream?.({ type: 'complete', finishReason: 'tool_calls' });
  return {
    type: 'tool_use',
    content: statusRequested ? 'Reading live command-center task status.' : 'Dispatching work through the command center.',
    toolCalls: [toolCall],
    finishReason: 'tool_calls',
    actualProvider,
    actualModel,
    usage: { inputTokens: 150, outputTokens: 36 },
    contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
  };
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

  if (findToolResultContent(messages, E2E_TASK_COMPLETE_RETAINED_CALL_ID)) {
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

  const retainedTaskId = extractCreatedTaskId(messages, `${E2E_TASK_CREATE_PREFIX}-2`);
  if (
    retainedTaskId
    && findToolResultContent(messages, E2E_TASK_COMPLETE_SCOPE_CALL_ID)
    && findToolResultContent(messages, E2E_TASK_START_RETAINED_CALL_ID)
    && findToolResultContent(messages, E2E_TASK_CANCEL_CALL_ID)
  ) {
    const toolCall = taskManagerCall(E2E_TASK_COMPLETE_RETAINED_CALL_ID, {
      action: 'update',
      taskId: retainedTaskId,
      status: 'completed',
    });
    onStream?.({
      type: 'tool_call_start',
      toolCall: { index: 0, id: toolCall.id, name: toolCall.name },
    });
    onStream?.({ type: 'complete', finishReason: 'tool_calls' });
    return {
      type: 'tool_use',
      content: 'Completing the retained task path through TaskManager.',
      toolCalls: [toolCall],
      finishReason: 'tool_calls',
      actualProvider,
      actualModel,
      usage: { inputTokens: 225, outputTokens: 28 },
      contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
    };
  }

  const scopeTaskId = extractCreatedTaskId(messages, `${E2E_TASK_CREATE_PREFIX}-1`);
  const oldPathTaskId = extractCreatedTaskId(messages, `${E2E_TASK_CREATE_PREFIX}-3`);
  if (scopeTaskId && retainedTaskId && oldPathTaskId) {
    const toolCalls = [
      taskManagerCall(E2E_TASK_COMPLETE_SCOPE_CALL_ID, {
        action: 'update',
        taskId: scopeTaskId,
        status: 'completed',
        addBlocks: [retainedTaskId],
      }),
      taskManagerCall(E2E_TASK_START_RETAINED_CALL_ID, {
        action: 'update',
        taskId: retainedTaskId,
        status: 'in_progress',
        addBlockedBy: [scopeTaskId],
      }),
      taskManagerCall(E2E_TASK_CANCEL_CALL_ID, {
        action: 'update',
        taskId: oldPathTaskId,
        status: 'cancelled',
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
      content: 'Updating retained task lifecycle states through TaskManager.',
      toolCalls,
      finishReason: 'tool_calls',
      actualProvider,
      actualModel,
      usage: { inputTokens: 215, outputTokens: 76 },
      contentParts: toolCalls.map((toolCall) => ({ type: 'tool_call' as const, toolCallId: toolCall.id })),
    };
  }

  const toolCalls = [
    taskManagerCall(`${E2E_TASK_CREATE_PREFIX}-1`, {
      action: 'create',
      subject: '梳理任务面板验收口径',
      description: '明确真实 agent loop 需要验证的任务拆分、状态和取消记录',
      activeForm: '梳理任务面板验收口径',
    }),
    taskManagerCall(`${E2E_TASK_CREATE_PREFIX}-2`, {
      action: 'create',
      subject: '验证保留任务路径',
      description: '确认仍需执行的任务会留在右侧任务面板并展示进度',
      activeForm: '验证保留任务路径',
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

function buildWebSearchE2EResponse(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  onStream?: StreamCallback,
): ModelResponse | null {
  if (!hasWebSearchMarker(messages)) return null;

  const actualProvider = 'acceptance';
  const actualModel = 'e2e-local-agent-model';

  const result = findToolResultContent(messages, E2E_WEB_SEARCH_CALL_ID);
  if (result) {
    const content = [
      'E2E web search smoke completed.',
      'WebSearch returned data through the real tool executor.',
      result.includes('No search sources available') ? 'No sources were available.' : 'Search sources were available.',
    ].join(' ');
    onStream?.({ type: 'text', content });
    onStream?.({ type: 'complete', finishReason: 'stop' });
    return {
      type: 'text',
      content,
      finishReason: 'stop',
      actualProvider,
      actualModel,
      usage: { inputTokens: 180, outputTokens: 28 },
    };
  }

  if (!hasTool(tools, 'WebSearch')) {
    const content = 'E2E web search smoke could not find the WebSearch tool.';
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

  const toolCall = {
    id: E2E_WEB_SEARCH_CALL_ID,
    name: 'WebSearch',
    arguments: {
      query: 'OpenAI web search tool official documentation',
      count: 3,
      source: 'auto',
      mode: 'quick',
    },
  };
  onStream?.({
    type: 'tool_call_start',
    toolCall: { index: 0, id: toolCall.id, name: toolCall.name },
  });
  onStream?.({ type: 'complete', finishReason: 'tool_calls' });
  return {
    type: 'tool_use',
    content: 'Searching the web through the real WebSearch tool executor.',
    toolCalls: [toolCall],
    finishReason: 'tool_calls',
    actualProvider,
    actualModel,
    usage: { inputTokens: 160, outputTokens: 32 },
    contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
  };
}

export function buildE2ELocalAgentModelResponse(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  env: NodeJS.ProcessEnv = process.env,
): ModelResponse {
  const backgroundApprovalResponse = buildBackgroundApprovalE2EResponse(messages, tools, onStream);
  if (backgroundApprovalResponse) return backgroundApprovalResponse;

  const commandCenterResponse = buildCommandCenterE2EResponse(messages, tools, onStream);
  if (commandCenterResponse) return commandCenterResponse;

  const webSearchResponse = buildWebSearchE2EResponse(messages, tools, onStream);
  if (webSearchResponse) return webSearchResponse;

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
