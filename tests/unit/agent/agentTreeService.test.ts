import { describe, expect, it } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { buildAgentTreeSnapshot } from '../../../src/main/agent/agentTreeService';
import type { EvidenceRef } from '../../../src/shared/contract/evidence';

describe('agentTreeService', () => {
  it('builds a read-only tree while keeping SpawnGuard as lifecycle truth', () => {
    const snapshot = buildAgentTreeSnapshot({
      now: 1000,
      sessionId: 'session-1',
      spawnAgents: [
        {
          id: 'parent',
          role: 'coordinator',
          treeId: 'session-1',
          status: 'running',
          task: 'coordinate the long task',
          createdAt: 10,
        },
        {
          id: 'child',
          role: 'coder',
          treeId: 'session-1',
          parentId: 'parent',
          status: 'failed',
          task: 'implement the change',
          createdAt: 20,
          completedAt: 50,
          result: {
            success: false,
            output: '',
            error: 'budget exhausted',
            toolsUsed: ['Read', 'Edit'],
            iterations: 3,
            cost: 0.42,
            tokensUsed: 1800,
            failureCode: AgentFailureCode.BudgetExhausted,
          },
        },
      ],
      parallelTasks: [
        {
          taskId: 'child',
          role: 'coder',
          task: 'parallel task state says completed',
          tools: ['Read'],
          status: 'completed',
          result: {
            taskId: 'child',
            role: 'coder',
            success: true,
            output: 'parallel completed',
            toolsUsed: ['Read'],
            iterations: 1,
            startTime: 25,
            endTime: 40,
            duration: 15,
          },
        },
      ],
      contextRecords: [
        {
          sessionId: 'session-1',
          agentId: 'child',
          messages: [],
          updatedAt: 60,
          snapshot: {
            currentTokens: 1900,
            maxTokens: 4000,
            usagePercent: 47.5,
            messageCount: 4,
            warningLevel: 'normal',
            lastUpdated: 60,
            tools: ['Read', 'Edit'],
            attachments: [],
            previews: [
              {
                role: 'coder',
                contentPreview: '正在整理失败前的产物和证据',
                tokens: 120,
              },
            ],
            truncatedMessages: 0,
          },
        },
      ],
    });

    const parent = snapshot.roots.find((node) => node.id === 'parent');
    const child = snapshot.nodes.find((node) => node.id === 'child');

    expect(snapshot.generatedAt).toBe(1000);
    expect(parent?.children.map((node) => node.id)).toEqual(['child']);
    expect(child?.status).toBe('failed');
    expect(child?.statusLabel).toBe('遇到问题');
    expect(child?.failureCode).toBe(AgentFailureCode.BudgetExhausted);
    expect(child?.failureReason).toBe('可用预算已经用完');
    expect(child?.activeTool).toBe('Edit');
    expect(child?.budgetSummary).toMatchObject({
      costUsd: 0.42,
      tokensUsed: 1900,
      maxTokens: 4000,
      usagePercent: 47.5,
      iterations: 3,
      toolCalls: 2,
    });
    expect(child?.sources).toEqual([
      'spawnGuard',
      'parallelCoordinator',
      'subagentContext',
    ]);
  });

  it('attaches worktree review metadata and ADR-029 evidence refs without inventing a new evidence shape', () => {
    const evidence: EvidenceRef = {
      id: 'evidence-diff-1',
      kind: 'diff',
      ref: '/repo/.git/worktrees/coder.diff',
      source: 'agentWorktree',
      freshness: {
        capturedAtMs: 123,
        state: 'fresh',
      },
      redactionStatus: 'clean',
    };

    const snapshot = buildAgentTreeSnapshot({
      now: 200,
      worktrees: [
        {
          agentId: 'coder-1',
          status: 'preserved',
          path: '/tmp/coder-worktree',
          branch: 'codex/coder-1',
          changedFiles: [
            { path: 'src/main/agent/foo.ts', status: 'modified' },
          ],
          diffSummary: '1 file changed',
          evidenceRefs: [evidence],
          updatedAt: 150,
        },
      ],
    });

    const node = snapshot.nodes.find((item) => item.id === 'coder-1');
    expect(node?.worktreeState).toMatchObject({
      status: 'preserved',
      path: '/tmp/coder-worktree',
      branch: 'codex/coder-1',
      diffSummary: '1 file changed',
    });
    expect(node?.worktreeState.changedFiles).toEqual([
      { path: 'src/main/agent/foo.ts', status: 'modified' },
    ]);
    expect(node?.evidenceRefs).toEqual([evidence]);
    expect(node?.sources).toContain('agentWorktree');
    expect(snapshot.summary.withWorktree).toBe(1);
  });
});
