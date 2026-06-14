import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarProjectDrawer } from '../../../src/renderer/components/features/sidebar/SidebarProjectDrawer';

describe('SidebarProjectDrawer', () => {
  it('renders project navigation, recovery signals, artifacts, goals, and context', () => {
    const html = renderToStaticMarkup(
      <SidebarProjectDrawer
        title="code-agent"
        summaryLine="repo/code-agent · 2 待处理 · 3 目标 · 4 产物 · 最近 2m"
        paths={['/Users/linchen/Downloads/ai/code-agent', '/tmp/code-agent-worktree']}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenWorkspaceAssets={vi.fn()}
        onNewSession={vi.fn()}
        onRenameProject={vi.fn()}
        onSetProjectDescription={vi.fn()}
        onSetProjectStatus={vi.fn()}
        onOpenArtifactSession={vi.fn()}
        onStartGoal={vi.fn()}
        onOpenGoalSession={vi.fn()}
        summary={{
          displayName: 'code-agent',
          sessionCount: 8,
          unfinishedCount: 2,
          pendingApprovalCount: 1,
          attentionCount: 1,
          runningCount: 0,
          reviewIssueCount: 1,
          artifactCount: 4,
          goalCount: 3,
          activeGoalTitle: '补齐会话组织',
          latestActivityAt: 1700000000000,
        }}
        meta={{
          name: 'code-agent',
          status: 'active',
          description: 'Alma 对标项目',
          goalCount: 3,
          goals: [
            { id: 'goal-1', title: '补齐会话组织', status: 'active', updatedAt: 3, lastRunSessionId: 'session-goal-1' },
            { id: 'goal-2', title: '收口 Review Queue', status: 'aborted', updatedAt: 2 },
            { id: 'goal-3', title: '研究结论归档', status: 'met', updatedAt: 1 },
          ],
          roleCount: 2,
          roleIds: ['researcher', 'reviewer'],
          artifactCount: 4,
          recentArtifacts: [
            {
              id: 'artifact-1',
              sessionId: 'session-artifact-1',
              messageId: 'message-1',
              title: '研究文档',
              kind: 'document',
              sessionTitle: 'Alma 研究',
              createdAt: 4,
              path: '/tmp/research.md',
            },
          ],
          sessionCount: 8,
          updatedAt: 1700000000000,
        }}
        sessions={[
          {
            id: 'session-1',
            title: 'Session Native Workspace',
            statusLabel: '执行中',
            statusToneClassName: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
            showStatusBadge: true,
            typeLabel: '对话',
            summary: '工作区 · Browser',
            lastActiveLabel: '刚刚',
            workingDirectory: '/Users/linchen/Downloads/ai/code-agent',
            gitBranch: 'codex/alma-project-session-organization-visible',
            prLabel: 'PR #17',
            isCurrent: true,
            messageCount: 12,
            turnCount: 6,
            hasDeliverySignals: true,
            replayEvidenceCount: 2,
            pendingReviewCount: 1,
          },
        ]}
      />,
    );

    expect(html).toContain('aria-label="code-agent 项目控制台"');
    expect(html).toContain('aria-label="编辑 code-agent 项目"');
    expect(html).toContain('Alma 对标项目');
    expect(html).toContain('新建项目会话');
    expect(html).toContain('打开项目产物');
    expect(html).toContain('2');
    expect(html).toContain('补齐会话组织');
    expect(html).toContain('aria-label="打开目标 补齐会话组织 的上次会话"');
    expect(html).toContain('aria-label="从目标 补齐会话组织 新建项目会话"');
    expect(html).toContain('研究文档');
    expect(html).toContain('文档 · Alma 研究');
    expect(html).toContain('Session Native Workspace');
    expect(html).toContain('工作区 · Browser');
    expect(html).toContain('codex/alma-project-session-organization-visible');
    expect(html).toContain('PR #17');
    expect(html).toContain('交付线索');
    expect(html).toContain('Replay 2');
    expect(html).toContain('待审 1');
    expect(html).toContain('/tmp/code-agent-worktree');
    expect(html).toContain('researcher');
    expect(html).toContain('reviewer');
  });
});
