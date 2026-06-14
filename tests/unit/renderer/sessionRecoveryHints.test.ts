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
  it('summarizes workspace, branch, PR, and artifact signals from session metadata', () => {
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

    expect(hints.map((hint) => hint.label)).toEqual([
      'code-agent',
      'project-sidebar',
      'PR #42',
      '产物',
    ]);
  });

  it('falls back to recent tool and capability counts when there is no code metadata', () => {
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

    expect(hints.map((hint) => hint.label)).toEqual([
      'browser_action',
      '1 Skill',
      '2 Connector',
      '1 MCP',
    ]);
  });

  it('keeps the row compact by returning at most four hints', () => {
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

    expect(hints).toHaveLength(4);
  });

  it('shows workflow replay evidence without inventing an artifact row hint', () => {
    const hints = buildSessionRecoveryHints(makeSession({
      workbenchSnapshot: {
        summary: 'Workflow',
        labels: [],
        recentToolNames: [],
      },
    }), { hasReplay: true });

    expect(hints.map((hint) => hint.label)).toEqual(['Replay']);
    expect(hints[0]).toMatchObject({
      kind: 'replay',
      title: '打开这个会话的 Workflow / Replay 证据',
    });
  });

  it('explains restricted replay access while keeping evidence visible', () => {
    const hints = buildSessionRecoveryHints(makeSession({
      workbenchSnapshot: {
        summary: 'Workflow',
        labels: [],
        recentToolNames: [],
      },
    }), { hasReplay: true, canOpenReplay: false });

    expect(hints).toEqual([{
      kind: 'replay',
      label: 'Replay',
      title: '这个会话有 Workflow / Replay 证据，结构化 Replay 仅管理员可打开',
    }]);
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
