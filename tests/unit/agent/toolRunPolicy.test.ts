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
});
