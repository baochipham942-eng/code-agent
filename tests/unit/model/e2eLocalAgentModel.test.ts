import { describe, expect, it } from 'vitest';

import {
  buildE2ELocalAgentModelResponse,
  shouldUseE2ELocalAgentModel,
  shouldUseE2ELocalAgentModelForMessages,
} from '../../../src/main/model/e2eLocalAgentModel';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/main/model/types';

const config: ModelConfig = {
  provider: 'openai',
  model: 'e2e-local-agent-model',
  apiKey: 'test',
  maxTokens: 1000,
};

const readTool: ToolDefinition = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
    },
    required: ['file_path'],
  },
  requiresPermission: false,
  permissionLevel: 'read',
};

const taskManagerTool: ToolDefinition = {
  name: 'TaskManager',
  description: 'Manage tasks',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
    },
    required: ['action'],
  },
  requiresPermission: true,
  permissionLevel: 'write',
};

describe('e2eLocalAgentModel', () => {
  it('requires both E2E env guards', () => {
    expect(shouldUseE2ELocalAgentModel({ CODE_AGENT_E2E: '1' })).toBe(false);
    expect(shouldUseE2ELocalAgentModel({ CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1' })).toBe(false);
    expect(shouldUseE2ELocalAgentModel({
      CODE_AGENT_E2E: '1',
      CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1',
    })).toBe(true);
  });

  it('allows the task panel smoke marker in E2E mode', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'E2E_TASK_PANEL_SESSION_TASKS' }];

    expect(shouldUseE2ELocalAgentModelForMessages(messages, {})).toBe(false);
    expect(shouldUseE2ELocalAgentModelForMessages(messages, { CODE_AGENT_E2E: '1' })).toBe(true);
  });

  it('calls the real Read tool before producing the final eval response', () => {
    const first = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'read the fixture' }],
      [readTool],
      config,
      undefined,
      {
        CODE_AGENT_E2E_AGENT_MODEL_READ_FILE: '/tmp/e2e-fixture.txt',
      },
    );

    expect(first.type).toBe('tool_use');
    expect(first.toolCalls?.[0]).toMatchObject({
      id: 'e2e-real-agent-read-fixture',
      name: 'Read',
      arguments: {
        file_path: '/tmp/e2e-fixture.txt',
      },
    });

    const toolResult: ModelMessage = {
      role: 'tool',
      toolCallId: 'e2e-real-agent-read-fixture',
      content: 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE=true',
    };
    const final = buildE2ELocalAgentModelResponse(
      [toolResult],
      [readTool],
      config,
    );

    expect(final.type).toBe('text');
    expect(final.content).toContain('E2E real agent replay eval smoke completed');
    expect(final.content).toContain('E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE');
  });

  it('drives the task panel smoke through TaskManager create and cancel calls', () => {
    const first = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'E2E_TASK_PANEL_SESSION_TASKS' }],
      [taskManagerTool],
      config,
    );

    expect(first.type).toBe('tool_use');
    expect(first.toolCalls?.map((toolCall) => toolCall.name)).toEqual([
      'TaskManager',
      'TaskManager',
      'TaskManager',
    ]);
    expect(first.toolCalls?.[0].arguments).toMatchObject({
      action: 'create',
      subject: '梳理真实 agent 任务',
    });

    const second = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_TASK_PANEL_SESSION_TASKS' },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-create-3',
          content: 'Task #3 created:\n  Subject: 放弃旧路径',
        },
      ],
      [taskManagerTool],
      config,
    );

    expect(second.type).toBe('tool_use');
    expect(second.toolCalls?.[0]).toMatchObject({
      id: 'e2e-task-panel-cancel-old-path',
      name: 'TaskManager',
      arguments: {
        action: 'update',
        taskId: '3',
        status: 'cancelled',
      },
    });

    const final = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_TASK_PANEL_SESSION_TASKS' },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-cancel-old-path',
          content: 'Task #3 updated:\n  Subject: 放弃旧路径\n  Status: cancelled',
        },
      ],
      [taskManagerTool],
      config,
    );

    expect(final.type).toBe('text');
    expect(final.content).toContain('E2E task panel real-agent smoke completed');
  });
});
