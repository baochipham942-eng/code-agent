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

  it('workflow 提案带 priorProjection → prompt 注入结构化现场段并要求续跑而非考古', () => {
    const proposal = buildWorkflowFailureRecoveryProposal({
      sessionId: 'session-1',
      runId: 'wf-run-1',
      status: 'failed',
      priorProjection: '未完成任务（末态）：\n- [created] t2: 补单测',
    });
    expect(proposal?.prompt).toContain('上一 run 现场（有界投影，来自 session 一本账）');
    expect(proposal?.prompt).toContain('t2: 补单测');
    expect(proposal?.prompt).toContain('基于上述现场续跑');
  });

  it('agent-team 提案同样支持 priorProjection 注入（对称应用）', () => {
    const proposal = buildAgentTeamFailureRecoveryProposal({
      sessionId: 'session-1',
      totalTasks: 2,
      failedTasks: [{ taskId: 'a1', role: 'coder', error: 'timeout' }],
      priorProjection: '最近失败的验证/工具执行：\n- bash npm test 失败（2 tests failed）',
    });
    expect(proposal?.prompt).toContain('上一 run 现场（有界投影，来自 session 一本账）');
    expect(proposal?.prompt).toContain('npm test 失败');
  });

  it('无 priorProjection 时 prompt 不含现场段（旧行为不变）', () => {
    const proposal = buildWorkflowFailureRecoveryProposal({
      sessionId: 'session-1',
      runId: 'wf-run-1',
      status: 'failed',
    });
    expect(proposal?.prompt).not.toContain('上一 run 现场');
  });
});
