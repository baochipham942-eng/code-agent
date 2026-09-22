import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiReviewVerdict } from '../../../src/shared/contract/evaluation';
import type { TestCase, TestResult, TestRunnerConfig } from '../../../src/host/testing/types';

const quickTask = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/quickModel', () => ({ quickTask }));
const systemOne = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/providers/typesafeProvider', () => ({ systemOne }));

import { attachAiReview } from '../../../src/host/testing/testRunnerAiReview';
import { JEV_JUDGE_MODEL } from '../../../src/shared/constants/jevQuestions';

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

// N-JEV-EVAL-JUDGE：CODE_AGENT_DIMJUDGE_JEV_PRESCREEN 默认关；开且 key 齐才装配 systemOne。
describe('AI 评审 Jev 初筛开关', () => {
  beforeEach(() => {
    quickTask.mockReset();
    systemOne.mockReset();
    vi.unstubAllEnvs();
  });

  it('开关未设 ⇒ 不装初筛，走生成式，systemOne 零调用', async () => {
    const target = unreviewed();
    quickTask.mockResolvedValueOnce({ success: true, content: '证据充分\n是', provider: 'p', model: 'm' });

    await attachAiReview(config, testCase, target, false);

    expect(systemOne).not.toHaveBeenCalled();
    expect(quickTask).toHaveBeenCalledTimes(1);
    expect(target.aiReview?.task_completed).toMatchObject({ verdict: 'yes' });
    expect(target.aiReview?.task_completed?.prescreen).toBeUndefined();
  });

  it('开关 on 但无 TYPESAFE_API_KEY ⇒ warn 一行并回落生成式；同进程第二题不再重复 warn', async () => {
    vi.stubEnv('CODE_AGENT_DIMJUDGE_JEV_PRESCREEN', '1');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = unreviewed();
    const second = unreviewed();
    quickTask.mockResolvedValue({ success: true, content: '证据充分\n是', provider: 'p', model: 'm' });
    try {
      await attachAiReview(config, testCase, first, false);
      await attachAiReview(config, testCase, second, false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('TYPESAFE_API_KEY'));
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(systemOne).not.toHaveBeenCalled();
    expect(quickTask).toHaveBeenCalledTimes(2);
    expect(first.aiReview?.task_completed?.prescreen).toBeUndefined();
    expect(second.aiReview?.task_completed?.prescreen).toBeUndefined();
  });

  it('CODE_AGENT_DIMJUDGE_EXPECTATION_DIMS 开 ⇒ requiresExpectation 维真调判官（WIRE3 接线）', async () => {
    vi.stubEnv('CODE_AGENT_DIMJUDGE_EXPECTATION_DIMS', '1');
    const target = unreviewed();
    quickTask.mockResolvedValueOnce({ success: true, content: '按期望判断\n否', provider: 'p', model: 'm' });
    try {
      await attachAiReview(
        { ...config, aiReview: ['tool_choice'] },
        testCase,
        target,
        false,
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(quickTask).toHaveBeenCalledTimes(1);
    expect(target.aiReview?.tool_choice).toMatchObject({ verdict: 'no' });
    expect(target.aiReview?.tool_choice?.reason).toBeUndefined();
  });

  it('CODE_AGENT_DIMJUDGE_EXPECTATION_DIMS 未开 ⇒ requiresExpectation 维仍短路（默认不变）', async () => {
    const target = unreviewed();
    await attachAiReview({ ...config, aiReview: ['tool_choice'] }, testCase, target, false);

    expect(quickTask).not.toHaveBeenCalled();
    expect(target.aiReview?.tool_choice).toMatchObject({ verdict: 'unavailable', reason: 'no_expectation' });
  });

  it('开关 on 且 key 在 ⇒ 装配 systemOne，初筛决断则不调生成式', async () => {
    vi.stubEnv('CODE_AGENT_DIMJUDGE_JEV_PRESCREEN', '1');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    systemOne.mockResolvedValueOnce({ task_fulfilled: { noul: 0.9 }, claims_grounded: { noul: 0.9 } });
    const target = unreviewed();
    try {
      await attachAiReview(config, testCase, target, false);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(quickTask).not.toHaveBeenCalled();
    expect(target.aiReview?.task_completed).toMatchObject({
      verdict: 'yes',
      judgeModel: JEV_JUDGE_MODEL,
      prescreen: 'jev_decided',
    });
  });
});
