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
    expect(status.label).toBe('执行中');
    expect(status.showBadge).toBe(true);
  });

  it('labels prompt-only sessions as needing attention', () => {
    const status = getSessionStatusPresentation({
      messageCount: 1,
      turnCount: 1,
      sessionStatus: 'idle',
    });

    expect(status.kind).toBe('incomplete');
    expect(status.label).toBe('待处理');
    expect(status.showBadge).toBe(true);
  });

  it('keeps sessions with assistant output in the completed bucket without a sidebar badge', () => {
    const status = getSessionStatusPresentation({
      messageCount: 2,
      turnCount: 1,
      sessionStatus: 'idle',
    });

    expect(status.kind).toBe('done');
    expect(status.label).toBe('已完成');
    expect(status.showBadge).toBe(false);
  });

  it('prioritizes pending approvals over generic running state', () => {
    const status = getSessionStatusPresentation({
      hasPendingApproval: true,
      runtime: {
        sessionId: 'session-1',
        status: 'running',
        activeAgentCount: 1,
        contextHealth: null,
        lastActivityAt: Date.now(),
      },
    });

    expect(status.kind).toBe('approval');
    expect(status.label).toBe('待确认');
    expect(status.showBadge).toBe(true);
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
        label: '执行中',
        toneClassName: '',
        showBadge: true,
      },
    });

    expect(text).toContain('修复浏览器上下文');
    expect(text).toContain('/repo/code-agent');
    expect(text).toContain('browser');
    expect(text).toContain('执行中');
  });
});
