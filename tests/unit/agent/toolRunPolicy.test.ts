import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import { filterToolsByRunPolicy, isToolDeniedForRun } from '../../../src/host/agent/runtime/toolRunPolicy';

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  requiresPermission: false,
  permissionLevel: 'read',
});

describe('toolRunPolicy', () => {
  it('filters denied tools case-insensitively for a run', () => {
    const ctx = {
      deniedToolNames: ['ask_user_question', 'AskUserQuestion'],
    } as any;

    expect(isToolDeniedForRun(ctx, 'ASK_USER_QUESTION')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'AskUserQuestion')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'bash')).toBe(false);

    expect(filterToolsByRunPolicy([
      tool('AskUserQuestion'),
      tool('bash'),
      tool('ask_user_question'),
    ], ctx).map((item) => item.name)).toEqual(['bash']);
  });

  it('enforces a strict allowlist before a foreground brain can call tools', () => {
    const ctx = {
      allowedToolNames: ['spawn_task', 'task_status', 'AskUserQuestion'],
      deniedToolNames: ['task_status'],
    } as any;

    expect(filterToolsByRunPolicy([
      tool('spawn_task'),
      tool('task_status'),
      tool('AskUserQuestion'),
      tool('bash'),
    ], ctx).map((item) => item.name)).toEqual(['spawn_task', 'AskUserQuestion']);
    expect(isToolDeniedForRun(ctx, 'bash')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'task_status')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'spawn_task')).toBe(false);
  });
});
