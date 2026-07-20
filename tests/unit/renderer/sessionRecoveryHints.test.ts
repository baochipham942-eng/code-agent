import { describe, expect, it } from 'vitest';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import {
  buildSessionRecoveryHints,
  hasSessionDeliverySignals,
} from '../../../src/renderer/utils/sessionRecoveryHints';

function makeSession(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-1',
    title: 'Session',
    createdAt: 1,
    updatedAt: 1,
    modelConfig: { provider: 'test' as any, model: 'test' },
    messageCount: 1,
    turnCount: 1,
    ...overrides,
  } as SessionWithMeta;
}

describe('buildSessionRecoveryHints', () => {
  // 简化后：会话项只保留定位上下文（工作区 / 分支 / PR），不再堆最近工具/能力计数/Replay/产物。
  it('summarizes only the locating context (workspace, branch, PR)', () => {
    const hints = buildSessionRecoveryHints(makeSession({
      workingDirectory: '/repo/code-agent',
      gitBranch: 'feature/project-sidebar',
      prLink: {
        owner: 'linchen',
        repo: 'code-agent',
        number: 42,
        title: 'Project sidebar recovery',
        linkedAt: 100,
      },
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区'],
        primarySurface: 'workspace',
        recentToolNames: ['write_file'],
      },
    }));

    // 不再有 '产物' / 'write_file' 这类引擎内幕 chip
    expect(hints.map((hint) => hint.label)).toEqual([
      'code-agent',
      'project-sidebar',
      'PR #42',
    ]);
  });

  it('drops recent-tool and capability-count hints (engine internals)', () => {
    const hints = buildSessionRecoveryHints(makeSession({
      workbenchSnapshot: {
        summary: 'Browser research',
        labels: ['Browser'],
        recentToolNames: ['browser_action'],
        skillIds: ['research'],
        connectorIds: ['mail', 'calendar'],
        mcpServerIds: ['github'],
      },
    }));

    // 没有任何定位上下文（无工作目录/分支/PR）→ 不再退回工具/能力计数，结果为空
    expect(hints).toEqual([]);
  });

  it('keeps the row compact by returning at most three hints', () => {
    const hints = buildSessionRecoveryHints(makeSession({
      workingDirectory: '/repo/code-agent',
      gitBranch: 'main',
      prLink: {
        owner: 'linchen',
        repo: 'code-agent',
        number: 1,
        linkedAt: 100,
      },
      workbenchSnapshot: {
        summary: 'Workspace',
        labels: [],
        primarySurface: 'workspace',
        recentToolNames: ['write_file'],
        skillIds: ['a'],
        connectorIds: ['b'],
        mcpServerIds: ['c'],
      },
    }));

    expect(hints).toHaveLength(3);
  });

  it('no longer emits a Replay hint (Replay has its own button)', () => {
    expect(buildSessionRecoveryHints(makeSession({
      workbenchSnapshot: { summary: 'Workflow', labels: [], recentToolNames: [] },
    }))).toEqual([]);

    expect(buildSessionRecoveryHints(makeSession({
      workbenchSnapshot: { summary: 'Workflow', labels: [], recentToolNames: [] },
    }))).toEqual([]);
  });

  it('reuses delivery signals for sidebar filtering and row hints', () => {
    expect(hasSessionDeliverySignals(makeSession({
      workbenchSnapshot: {
        summary: 'Workspace',
        labels: [],
        primarySurface: 'workspace',
        recentToolNames: [],
      },
    }))).toBe(true);

    expect(hasSessionDeliverySignals(makeSession({
      workbenchSnapshot: {
        summary: 'Write',
        labels: [],
        primarySurface: 'chat',
        recentToolNames: ['MultiEdit'],
      },
    }))).toBe(true);

    expect(hasSessionDeliverySignals(makeSession({
      workbenchSnapshot: {
        summary: 'Research',
        labels: ['Browser'],
        primarySurface: 'browser',
        recentToolNames: ['browser_action'],
      },
    }))).toBe(false);

    expect(hasSessionDeliverySignals(makeSession({
      workbenchSnapshot: {
        summary: 'Workflow',
        labels: [],
        primarySurface: 'chat',
        recentToolNames: [],
      },
    }), { hasReplay: true })).toBe(true);
  });
});
