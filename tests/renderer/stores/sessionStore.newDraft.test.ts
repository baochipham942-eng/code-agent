import { describe, expect, it } from 'vitest';
import { findReusableNewSessionDraft } from '../../../src/renderer/stores/sessionStore';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

function session(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-1',
    title: '新对话',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    workbenchSnapshot: {
      summary: '纯对话',
      labels: [],
      recentToolNames: [],
    },
    ...overrides,
  };
}

describe('findReusableNewSessionDraft', () => {
  it('reuses the current empty new session draft', () => {
    const draft = session({ id: 'draft-1', workingDirectory: '/repo/code-agent' });

    expect(findReusableNewSessionDraft({
      sessions: [draft],
      currentSessionId: 'draft-1',
      messages: [],
      todos: [],
      workingDirectory: '/repo/code-agent',
    })?.id).toBe('draft-1');
  });

  it('does not reuse sessions that already have messages', () => {
    expect(findReusableNewSessionDraft({
      sessions: [session({ id: 'used-1', messageCount: 1 })],
      currentSessionId: 'used-1',
      messages: [],
      todos: [],
      workingDirectory: null,
    })).toBeNull();
  });
});
