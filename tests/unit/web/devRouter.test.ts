import { describe, expect, it } from 'vitest';
import {
  devExecToolRequiresAllowWrite,
  isDevApiEnabled,
  isDevExecToolAllowed,
  normalizeDevCompactStateSeed,
  normalizeDevTodoItems,
} from '../../../src/web/routes/dev';

describe('dev route guard', () => {
  it('requires an explicit dev API or E2E flag', () => {
    expect(isDevApiEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isDevApiEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isDevApiEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isDevApiEnabled({ CODE_AGENT_E2E: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isDevApiEnabled({ CODE_AGENT_ENABLE_DEV_API: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isDevApiEnabled({
      CODE_AGENT_ENABLE_DEV_API: 'true',
      CODE_AGENT_TAURI_BOOT_TOKEN: 'boot-token',
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('allows only bounded planning tools for app-host recovery smoke', () => {
    expect(isDevExecToolAllowed('task_create')).toBe(true);
    expect(isDevExecToolAllowed('task_list')).toBe(true);
    expect(isDevExecToolAllowed('task_update')).toBe(true);
    expect(isDevExecToolAllowed('Bash')).toBe(false);
    // delegate_task 只在 e2e 模式下可达：它能用任意 prompt 起带 shell/文件工具的后台 agent，
    // 不能随 CODE_AGENT_ENABLE_DEV_API 常驻（PR#1601 ai-review）
    expect(isDevExecToolAllowed('delegate_task', { CODE_AGENT_ENABLE_DEV_API: 'true' })).toBe(false);
    expect(isDevExecToolAllowed('delegate_task', { CODE_AGENT_E2E: '1' })).toBe(true);
    expect(devExecToolRequiresAllowWrite('delegate_task')).toBe(true);
    expect(isDevExecToolAllowed('bash')).toBe(false);

    expect(devExecToolRequiresAllowWrite('task_create')).toBe(true);
    expect(devExecToolRequiresAllowWrite('task_update')).toBe(true);
    expect(devExecToolRequiresAllowWrite('task_list')).toBe(false);
  });

  it('normalizes bounded dev todo seed payloads', () => {
    expect(normalizeDevTodoItems([
      {
        content: 'Persist todo',
        status: 'in_progress',
        activeForm: 'Persisting todo',
      },
    ])).toEqual([
      {
        content: 'Persist todo',
        status: 'in_progress',
        activeForm: 'Persisting todo',
      },
    ]);

    expect(() => normalizeDevTodoItems([
      {
        content: 'Bad todo',
        status: 'cancelled',
        activeForm: 'Bad todo',
      },
    ])).toThrow(/status must be/);
  });

  it('normalizes bounded dev compact state seed payloads', () => {
    expect(normalizeDevCompactStateSeed({
      sessionId: 'session-1',
      summaryMessageId: 'compact-1',
      summary: 'Compacted history',
      compactedMessageIds: ['u1', 'a1'],
      preservedMessageIds: ['a2'],
      anchorMessageId: 'a1',
    })).toEqual({
      sessionId: 'session-1',
      summaryMessageId: 'compact-1',
      summary: 'Compacted history',
      compactedMessageIds: ['u1', 'a1'],
      preservedMessageIds: ['a2'],
      anchorMessageId: 'a1',
    });

    expect(normalizeDevCompactStateSeed({
      sessionId: 'session-2',
    })).toMatchObject({
      sessionId: 'session-2',
      summaryMessageId: 'session-2-compact-summary',
      compactedMessageIds: ['session-2-compact-source-user', 'session-2-compact-source-assistant'],
      preservedMessageIds: [],
      anchorMessageId: 'session-2-compact-source-assistant',
    });

    expect(() => normalizeDevCompactStateSeed({
      sessionId: 'session-3',
      compactedMessageIds: 'bad',
    })).toThrow(/compactedMessageIds must be an array/);
  });
});
