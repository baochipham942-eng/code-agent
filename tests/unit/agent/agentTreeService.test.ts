import { describe, expect, it } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
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
          messages: [{
            id: 'message-tool-edit',
            role: 'assistant',
            content: '',
            timestamp: 55,
            toolCalls: [{
              id: 'tool-edit',
              name: 'Edit',
              arguments: { file_path: '/repo/src/main.ts' },
            }],
          }],
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
    expect(child?.lastToolStep).toEqual({
      tool: 'Edit',
      target: '/repo/src/main.ts',
      at: 55,
    });
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
            { path: 'src/host/agent/foo.ts', status: 'modified' },
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
      { path: 'src/host/agent/foo.ts', status: 'modified' },
    ]);
    expect(node?.evidenceRefs).toEqual([evidence]);
    expect(node?.sources).toContain('agentWorktree');
    expect(snapshot.summary.withWorktree).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 重启孤儿收口（N-STALE-AGENT-CHIP-AFTER-QUIT A）
  // subagent 都活在宿主进程内：context 记录的最后更新早于本进程启动 = 写它的
  // 执行方已死，节点不能再以 unknown（renderer 口径 = 工作中）谎报在跑。
  // 用 Date.now() 相对量构造「上一进程写的」与「本进程刚写的」两类记录。
  // --------------------------------------------------------------------------
  describe('restart orphan reconciliation', () => {
    function contextRecord(agentId: string, updatedAt: number) {
      return {
        sessionId: 'session-1',
        agentId,
        messages: [],
        updatedAt,
      };
    }

    it('marks a context record last updated before this process booted as cancelled, not unknown', () => {
      const snapshot = buildAgentTreeSnapshot({
        sessionId: 'session-1',
        contextRecords: [contextRecord('ghost', Date.now() - 60_000)],
      });

      const node = snapshot.nodes.find((item) => item.id === 'ghost');
      expect(node?.status).toBe('cancelled');
      expect(node?.statusLabel).toBe('已取消');
    });

    it('keeps a fresh in-process context record as unknown (better say working than dead)', () => {
      const snapshot = buildAgentTreeSnapshot({
        sessionId: 'session-1',
        contextRecords: [contextRecord('live', Date.now())],
      });

      const node = snapshot.nodes.find((item) => item.id === 'live');
      expect(node?.status).toBe('unknown');
    });

    it('a genuinely live spawnGuard agent stays running even when its context record is from a previous process', () => {
      const snapshot = buildAgentTreeSnapshot({
        sessionId: 'session-1',
        spawnAgents: [
          {
            id: 'alive',
            role: 'explore',
            treeId: 'session-1',
            status: 'running',
            task: 'scan the tree',
            createdAt: 10,
          },
        ],
        contextRecords: [contextRecord('alive', Date.now() - 60_000)],
      });

      const node = snapshot.nodes.find((item) => item.id === 'alive');
      expect(node?.status).toBe('running');
    });
  });

  it('sources.ownershipConflicts 原样带进 snapshot.summary（path/ownerAgentId/requesterAgentId）', () => {
    const snapshot = buildAgentTreeSnapshot({
      now: 300,
      ownershipConflicts: [
        { path: 'src/host/agent/foo.ts', ownerAgentId: 'coder-1', requesterAgentId: 'reviewer-1' },
      ],
    });

    expect(snapshot.summary.ownershipConflicts).toEqual([
      { path: 'src/host/agent/foo.ts', ownerAgentId: 'coder-1', requesterAgentId: 'reviewer-1' },
    ]);
  });

  it('不传 ownershipConflicts 时 snapshot.summary.ownershipConflicts 为空数组', () => {
    const snapshot = buildAgentTreeSnapshot({ now: 400 });

    expect(snapshot.summary.ownershipConflicts).toEqual([]);
  });
});
