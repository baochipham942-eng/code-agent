import { describe, expect, it } from 'vitest';

import {
  buildE2ELocalAgentModelResponse,
  shouldUseE2ELocalAgentModel,
  shouldUseE2ELocalAgentModelForMessages,
} from '../../../src/host/model/e2eLocalAgentModel';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/host/model/types';

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

const spawnTaskTool: ToolDefinition = {
  name: 'spawn_task',
  description: 'Spawn a background task',
  inputSchema: { type: 'object', properties: {} },
  requiresPermission: false,
  permissionLevel: 'write',
};

const taskStatusTool: ToolDefinition = {
  name: 'task_status',
  description: 'Read background task status',
  inputSchema: { type: 'object', properties: {} },
  requiresPermission: false,
  permissionLevel: 'read',
};

const steerTaskTool: ToolDefinition = {
  name: 'steer_task',
  description: 'Steer a background task',
  inputSchema: { type: 'object', properties: {} },
  requiresPermission: false,
  permissionLevel: 'write',
};

const askUserQuestionTool: ToolDefinition = {
  name: 'AskUserQuestion',
  description: 'Ask the user',
  inputSchema: { type: 'object', properties: {} },
  requiresPermission: false,
  permissionLevel: 'execute',
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

  it('drives foreground command-center dispatch and live status through real tools', () => {
    const first = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'E2E_SESSION_COMMAND_CENTER SPAWN' }],
      [spawnTaskTool, taskStatusTool, steerTaskTool],
      config,
    );
    expect(first.type).toBe('tool_use');
    expect(first.toolCalls?.[0]).toMatchObject({
      id: 'e2e-command-center-spawn',
      name: 'spawn_task',
      arguments: {
        short_name: '项目身份',
        lane_key: 'acceptance-read',
      },
    });

    const accepted = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_SESSION_COMMAND_CENTER SPAWN' },
        { role: 'tool', toolCallId: 'e2e-command-center-spawn', content: 'accepted：后台任务已开始。' },
      ],
      [spawnTaskTool, taskStatusTool, steerTaskTool],
      config,
    );
    expect(accepted.type).toBe('text');
    expect(accepted.content).toContain('dispatch accepted');

    const status = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'E2E_SESSION_COMMAND_CENTER STATUS' }],
      [spawnTaskTool, taskStatusTool, steerTaskTool],
      config,
    );
    expect(status.toolCalls?.[0]).toMatchObject({
      id: 'e2e-command-center-status',
      name: 'task_status',
      arguments: {},
    });

    const second = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'E2E_SESSION_COMMAND_CENTER SECOND' }],
      [spawnTaskTool, taskStatusTool, steerTaskTool],
      config,
    );
    expect(second.toolCalls?.[0]).toMatchObject({
      id: 'e2e-command-center-second',
      name: 'spawn_task',
      arguments: { short_name: '审批任务', prompt: 'E2E_BACKGROUND_APPROVAL' },
    });

    const steer = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'E2E_SESSION_COMMAND_CENTER STEER' }],
      [spawnTaskTool, taskStatusTool, steerTaskTool],
      config,
    );
    expect(steer.toolCalls?.[0]).toMatchObject({
      id: 'e2e-command-center-steer',
      name: 'steer_task',
      arguments: { target: '审批任务' },
    });
  });

  it('pauses a real auxiliary model turn on AskUserQuestion until the background approval returns', () => {
    const first = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'E2E_BACKGROUND_APPROVAL' }],
      [askUserQuestionTool],
      config,
    );
    expect(first.toolCalls?.[0]).toMatchObject({
      id: 'e2e-background-approval',
      name: 'AskUserQuestion',
    });

    const completed = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_BACKGROUND_APPROVAL' },
        { role: 'tool', toolCallId: 'e2e-background-approval', content: 'User responses: [后台审批]: 允许（推荐）' },
      ],
      [askUserQuestionTool],
      config,
    );
    expect(completed.type).toBe('text');
    expect(completed.content).toContain('background approval completed');

    const foregroundStatus = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_BACKGROUND_APPROVAL' },
        { role: 'user', content: 'E2E_SESSION_COMMAND_CENTER STATUS' },
      ],
      [askUserQuestionTool, spawnTaskTool, taskStatusTool],
      config,
    );
    expect(foregroundStatus.toolCalls?.[0]).toMatchObject({
      id: 'e2e-command-center-status',
      name: 'task_status',
    });
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
      subject: '梳理任务面板验收口径',
    });

    const second = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_TASK_PANEL_SESSION_TASKS' },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-create-1',
          content: 'Task #1 created:\n  Subject: 梳理任务面板验收口径',
        },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-create-2',
          content: 'Task #2 created:\n  Subject: 验证保留任务路径',
        },
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
    expect(second.toolCalls?.map((toolCall) => toolCall.id)).toEqual([
      'e2e-task-panel-complete-scope',
      'e2e-task-panel-start-retained-path',
      'e2e-task-panel-cancel-old-path',
    ]);
    expect(second.toolCalls?.map((toolCall) => toolCall.arguments)).toEqual([
      expect.objectContaining({
        action: 'update',
        taskId: '1',
        status: 'completed',
        addBlocks: ['2'],
      }),
      expect.objectContaining({
        action: 'update',
        taskId: '2',
        status: 'in_progress',
        addBlockedBy: ['1'],
      }),
      expect.objectContaining({
        action: 'update',
        taskId: '3',
        status: 'cancelled',
      }),
    ]);

    const third = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_TASK_PANEL_SESSION_TASKS' },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-create-1',
          content: 'Task #1 created:\n  Subject: 梳理任务面板验收口径',
        },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-create-2',
          content: 'Task #2 created:\n  Subject: 验证保留任务路径',
        },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-create-3',
          content: 'Task #3 created:\n  Subject: 放弃旧路径',
        },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-complete-scope',
          content: 'Task #1 updated:\n  Subject: 梳理任务面板验收口径\n  Status: completed',
        },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-start-retained-path',
          content: 'Task #2 updated:\n  Subject: 验证保留任务路径\n  Status: in_progress',
        },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-cancel-old-path',
          content: 'Task #3 updated:\n  Subject: 放弃旧路径\n  Status: cancelled',
        },
      ],
      [taskManagerTool],
      config,
    );

    expect(third.type).toBe('tool_use');
    expect(third.toolCalls?.[0]).toMatchObject({
      id: 'e2e-task-panel-complete-retained-path',
      name: 'TaskManager',
      arguments: {
        action: 'update',
        taskId: '2',
        status: 'completed',
      },
    });

    const final = buildE2ELocalAgentModelResponse(
      [
        { role: 'user', content: 'E2E_TASK_PANEL_SESSION_TASKS' },
        {
          role: 'tool',
          toolCallId: 'e2e-task-panel-complete-retained-path',
          content: 'Task #2 updated:\n  Subject: 验证保留任务路径\n  Status: completed',
        },
      ],
      [taskManagerTool],
      config,
    );

    expect(final.type).toBe('text');
    expect(final.content).toContain('E2E task panel real-agent smoke completed');
  });
});
