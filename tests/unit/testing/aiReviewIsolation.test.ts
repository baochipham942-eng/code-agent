import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiReviewVerdict } from '../../../src/shared/contract/evaluation';
import type { TestCase, TestResult, TestRunnerConfig } from '../../../src/host/testing/types';

const quickTask = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/quickModel', () => ({ quickTask }));

import { attachAiReview } from '../../../src/host/testing/testRunnerAiReview';

const verdict = (value: 'yes' | 'no'): AiReviewVerdict => ({
  verdict: value, reasoning: value, judgeModel: 'judge/model', promptHash: 'hash',
});

function reviewed(value: 'yes' | 'no'): TestResult {
  const review = verdict(value);
  return {
    testId: 'case-1', description: '任务', status: 'passed', score: 1,
    scoreAuthority: 'deterministic_assertion', duration: 1, startTime: 0, endTime: 1,
    toolExecutions: [], responses: [], errors: [], turnCount: 1,
    aiReview: {
      task_completed: review, tool_choice: review, confirmed_before_acting: review,
      no_extra_changes: review, self_tested: review,
    },
  };
}

function unreviewed(): TestResult {
  const result = reviewed('yes');
  delete result.aiReview;
  return result;
}

const config: TestRunnerConfig = {
  testCaseDir: '/cases', resultsDir: '/results', workingDirectory: '/work',
  defaultTimeout: 1_000, stopOnFailure: false, verbose: false, parallel: false,
  maxParallel: 1, aiReview: ['task_completed'],
};

const testCase: TestCase = {
  id: 'case-1', type: 'task', description: '任务', prompt: '完成任务', expect: {},
};

describe('AI 评审隔离', () => {
  beforeEach(() => {
    quickTask.mockReset();
  });

  it('T3：五维全否与全是的 score/status/scoreAuthority 完全相同', () => {
    const yes = reviewed('yes');
    const no = reviewed('no');
    expect({ score: no.score, status: no.status, scoreAuthority: no.scoreAuthority }).toEqual({
      score: yes.score, status: yes.status, scoreAuthority: yes.scoreAuthority,
    });
  });

  it('T3：执行器接线只附加 aiReview，不改评分三元组', async () => {
    const yes = unreviewed();
    const no = unreviewed();
    quickTask
      .mockResolvedValueOnce({ success: true, content: '完成证据充分\n是', provider: 'p', model: 'm' })
      .mockResolvedValueOnce({ success: true, content: '完成证据不足\n否', provider: 'p', model: 'm' });

    await attachAiReview(config, testCase, yes, false);
    await attachAiReview(config, testCase, no, false);

    expect(yes).toMatchObject({ aiReview: { task_completed: { verdict: 'yes' } } });
    expect(no).toMatchObject({ aiReview: { task_completed: { verdict: 'no' } } });
    expect({ score: no.score, status: no.status, scoreAuthority: no.scoreAuthority }).toEqual({
      score: yes.score, status: yes.status, scoreAuthority: yes.scoreAuthority,
    });
  });

  it('mock 路径完全跳过 AI 评审调用与写回', async () => {
    const mockResult = unreviewed();

    await attachAiReview(config, testCase, mockResult, true);

    expect(quickTask).not.toHaveBeenCalled();
    expect(mockResult.aiReview).toBeUndefined();
    expect(mockResult).toMatchObject({
      score: 1,
      status: 'passed',
      scoreAuthority: 'deterministic_assertion',
    });
  });

  it('评审模型异常只写 unavailable，不改变评分三元组', async () => {
    const failedJudge = unreviewed();
    quickTask.mockRejectedValueOnce(new Error('judge down'));

    await attachAiReview(config, testCase, failedJudge, false);

    expect(failedJudge.aiReview?.task_completed).toMatchObject({
      verdict: 'unavailable',
      reason: 'judge_error',
    });
    expect(failedJudge).toMatchObject({
      score: 1,
      status: 'passed',
      scoreAuthority: 'deterministic_assertion',
    });
  });
});
