import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import type { AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import { AgentTreeSnapshotView } from '../../../src/renderer/components/features/agentTree/AgentTreeView';

describe('AgentTreeSnapshotView', () => {
  it('renders long-task agent progress in human-readable language with worktree review details', () => {
    const snapshot: AgentTreeSnapshot = {
      generatedAt: 123,
      roots: [
        {
          id: 'agent-coder',
          role: 'coder',
          status: 'failed',
          statusLabel: '遇到问题',
          children: [],
          progress: 'typecheck failed with exitCode 2',
          activeTool: 'Bash',
          failureCode: AgentFailureCode.BudgetExhausted,
          failureReason: '可用预算已经用完',
          worktreeState: {
            status: 'preserved',
            path: '/tmp/code-agent-worktrees/agent-coder',
            branch: 'agent/agent-coder',
            changedFiles: [
              { path: 'src/main/agent/agentTreeService.ts', status: 'modified' },
            ],
            diffSummary: '1 file changed',
          },
          budgetSummary: {
            costUsd: 0.42,
            tokensUsed: 1200,
            usagePercent: 52,
          },
          evidenceRefs: [],
          sources: ['spawnGuard', 'agentWorktree'],
        },
      ],
      nodes: [],
      summary: {
        total: 1,
        running: 0,
        completed: 0,
        failed: 1,
        cancelled: 0,
        blocked: 0,
        withWorktree: 1,
      },
    };
    snapshot.nodes = snapshot.roots;

    const html = renderToStaticMarkup(
      <AgentTreeSnapshotView
        snapshot={snapshot}
        worktreeReviews={{
          'agent-coder': {
            agentId: 'agent-coder',
            status: 'preserved',
            path: '/tmp/code-agent-worktrees/agent-coder',
            branch: 'agent/agent-coder',
            updatedAt: 456,
            changedFiles: [
              { path: 'src/main/agent/agentTreeService.ts', status: 'modified' },
            ],
            diffSummary: '1 file changed',
            diff: 'diff --git a/src/main/agent/agentTreeService.ts b/src/main/agent/agentTreeService.ts\n+done',
          },
        }}
        onReviewWorktree={() => undefined}
      />
    );

    expect(html).toContain('任务树');
    expect(html).toContain('coder');
    expect(html).toContain('遇到问题');
    expect(html).toContain('类型检查 failed with 退出状态 2');
    expect(html).toContain('正在用：命令行');
    expect(html).toContain('失败原因：可用预算已经用完');
    expect(html).toContain('/tmp/code-agent-worktrees/agent-coder');
    expect(html).toContain('已修改 src/main/agent/agentTreeService.ts');
    expect(html).toContain('查看变更');
    expect(html).not.toContain('typecheck');
    expect(html).not.toContain('exitCode');
  });
});
