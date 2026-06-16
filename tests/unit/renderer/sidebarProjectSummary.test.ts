import { describe, expect, it } from 'vitest';
import {
  buildSidebarProjectSummary,
  formatSidebarProjectSummaryLine,
} from '../../../src/renderer/utils/sidebarProjectSummary';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type { WorkspaceGroup } from '../../../src/renderer/utils/workspaceGrouping';

function makeSession(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: overrides.id ?? 'session',
    title: overrides.title ?? 'Session',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    modelConfig: { provider: 'test' as any, model: 'test' },
    messageCount: overrides.messageCount ?? 0,
    turnCount: overrides.turnCount ?? 0,
    ...overrides,
  } as SessionWithMeta;
}

function makeGroup(sessions: SessionWithMeta[]): WorkspaceGroup {
  return {
    key: '/repo/code-agent',
    name: 'code-agent',
    path: '/repo/code-agent',
    isUncategorized: false,
    projectId: 'proj-code-agent',
    sessions,
    latestActivityAt: Math.max(...sessions.map((session) => session.updatedAt || 0)),
  };
}

describe('buildSidebarProjectSummary', () => {
  it('counts running, pending approval, and attention sessions for a workspace group', () => {
    const sessions = [
      makeSession({ id: 'running', messageCount: 3, turnCount: 1, status: 'running', updatedAt: 100 }),
      makeSession({ id: 'approval', messageCount: 3, turnCount: 1, updatedAt: 90 }),
      makeSession({ id: 'error', messageCount: 3, turnCount: 1, status: 'error', updatedAt: 80 }),
      makeSession({ id: 'done', messageCount: 6, turnCount: 2, status: 'completed', updatedAt: 70 }),
    ];

    const summary = buildSidebarProjectSummary({
      group: makeGroup(sessions),
      backgroundTaskMap: new Map(),
      sessionRuntimes: new Map(),
      sessionStates: {},
      hasPendingApprovalForSession: (sessionId) => sessionId === 'approval',
      reviewItemsBySessionId: {
        running: [
          { reviewStatus: 'pending' },
          { reviewStatus: 'approved' },
        ] as any[],
        done: [
          { reviewStatus: 'pending' },
        ] as any[],
      },
      projectMeta: {
        name: 'Agent Neo',
        goalCount: 2,
        activeGoalTitles: ['补齐 Project / Session 组织入口'],
        artifactCount: 4,
        sessionCount: 12,
      },
    });

    expect(summary.displayName).toBe('Agent Neo');
    expect(summary.sessionCount).toBe(12);
    expect(summary.runningCount).toBe(1);
    expect(summary.pendingApprovalCount).toBe(1);
    expect(summary.attentionCount).toBe(1);
    expect(summary.unfinishedCount).toBe(3);
    expect(summary.reviewIssueCount).toBe(2);
    expect(summary.goalCount).toBe(2);
    expect(summary.activeGoalTitle).toBe('补齐 Project / Session 组织入口');
    expect(summary.artifactCount).toBe(4);
    expect(summary.latestActivityAt).toBe(100);
  });

  it('uses a clearer display name for uncategorized blank sessions', () => {
    const summary = buildSidebarProjectSummary({
      group: {
        key: '__chats__',
        name: '对话',
        isUncategorized: true,
        sessions: [makeSession({ id: 'blank' })],
        latestActivityAt: 1,
      },
      backgroundTaskMap: new Map(),
      sessionRuntimes: new Map(),
      sessionStates: {},
      hasPendingApprovalForSession: () => false,
    });

    expect(summary.displayName).toBe('对话');
  });

  it('formats a scan-friendly project header line with active goal and multiple workspaces', () => {
    const line = formatSidebarProjectSummaryLine({
      summary: {
        displayName: 'Agent Neo',
        sessionCount: 5,
        unfinishedCount: 2,
        pendingApprovalCount: 1,
        attentionCount: 0,
        runningCount: 1,
        reviewIssueCount: 0,
        goalCount: 3,
        activeGoalTitle: '补齐 Project / Session 组织入口',
        artifactCount: 4,
        latestActivityAt: 90_000,
      },
      isUncategorized: false,
      isFiltered: false,
      workspacePaths: ['/repo/code-agent-worktree', '/repo/code-agent'],
      now: 150_000,
    });

    expect(line).toBe('repo/code-agent-worktree +1 工作区 · 目标：补齐 Project / Session 组织… · 1 待确认 · 1 执行中 · 3 目标 · 4 产物 · 5 会话 · 最近 1m');
  });

  it('keeps filtered blank-session groups clear', () => {
    const line = formatSidebarProjectSummaryLine({
      summary: {
        displayName: '未分类',
        sessionCount: 2,
        unfinishedCount: 0,
        pendingApprovalCount: 0,
        attentionCount: 0,
        runningCount: 0,
        reviewIssueCount: 0,
        latestActivityAt: 0,
      },
      isUncategorized: true,
      isFiltered: true,
      workspacePaths: [],
    });

    expect(line).toBe('2 命中');
  });
});
