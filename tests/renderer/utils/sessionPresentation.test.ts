import { describe, expect, it } from 'vitest';
import { buildSessionSearchText, getSessionStatusPresentation } from '../../../src/renderer/utils/sessionPresentation';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

describe('sessionPresentation', () => {
  it('explains background sessions before generic running state', () => {
    const status = getSessionStatusPresentation({
      backgroundTask: {
        sessionId: 'session-1',
        title: '后台任务',
        startedAt: Date.now() - 1_000,
        backgroundedAt: Date.now() - 500,
        status: 'running',
      },
      runtime: {
        sessionId: 'session-1',
        status: 'running',
        activeAgentCount: 1,
        contextHealth: null,
        lastActivityAt: Date.now(),
      },
      taskState: { status: 'running' },
    });

    expect(status.kind).toBe('background');
    expect(status.label).toBe('后台');
  });

  it('indexes snapshot and working directory into session search text', () => {
    const session: SessionWithMeta = {
      id: 'session-1',
      title: '修复浏览器上下文',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: 1,
      updatedAt: 2,
      workingDirectory: '/repo/code-agent',
      messageCount: 8,
      turnCount: 3,
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区', 'Browser'],
        recentToolNames: ['browser_action'],
      },
    };

    const text = buildSessionSearchText({
      session,
      snapshot: session.workbenchSnapshot,
      status: {
        kind: 'live',
        label: '进行中',
        toneClassName: '',
      },
    });

    expect(text).toContain('修复浏览器上下文');
    expect(text).toContain('/repo/code-agent');
    expect(text).toContain('browser');
    expect(text).toContain('进行中');
  });
});
