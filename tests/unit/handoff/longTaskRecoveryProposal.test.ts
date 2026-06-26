import { describe, expect, it } from 'vitest';
import {
  buildAgentTeamFailureRecoveryProposal,
  buildWorkflowFailureRecoveryProposal,
} from '../../../src/host/handoff/longTaskRecoveryProposal';

describe('long-task recovery proposal builders', () => {
  it('builds workflow failure proposals with replay resume evidence', () => {
    const proposal = buildWorkflowFailureRecoveryProposal({
      sessionId: 'session-1',
      runId: 'wf-run-1',
      goal: '整理产品闭环方案',
      status: 'failed',
      error: 'agent call failed',
      resumeFromRunId: 'wf-run-1',
      cacheHits: 2,
      phaseCount: 3,
    });

    expect(proposal).toMatchObject({
      sessionId: 'session-1',
      sourceMessageId: 'workflow:wf-run-1:failure',
      source: 'workflow_failure',
      title: '重试 workflow：整理产品闭环方案',
      reason: 'workflow failed: agent call failed',
    });
    expect(proposal?.prompt).toContain('Retry with resumeFromRunId: wf-run-1');
    expect(proposal?.prompt).toContain('phases=3, cacheHits=2');
  });

  it('builds Agent Team proposals scoped to failed tasks', () => {
    const proposal = buildAgentTeamFailureRecoveryProposal({
      sessionId: 'session-1',
      sourceMessageId: 'agent-team:tool-1:failure',
      totalTasks: 3,
      failedTasks: [
        {
          taskId: 'agent_reviewer_1',
          role: 'reviewer',
          task: '[工作目录: /tmp/repo] 所有文件路径基于此目录。\n\n审查权限闭环',
          error: 'timeout',
        },
      ],
      summary: '2 completed, 1 failed',
    });

    expect(proposal).toMatchObject({
      sessionId: 'session-1',
      sourceMessageId: 'agent-team:tool-1:failure',
      source: 'agent_team_failure',
      title: '重试 Agent Team：reviewer',
      reason: '1/3 agent tasks failed',
    });
    expect(proposal?.prompt).toContain('Failed tasks: 1');
    expect(proposal?.prompt).toContain('agent_reviewer_1 (reviewer) task=审查权限闭环 error=timeout');
  });
});
