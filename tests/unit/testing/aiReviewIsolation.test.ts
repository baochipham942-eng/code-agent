import { describe, expect, it } from 'vitest';
import type { AiReviewVerdict } from '../../../src/shared/contract/evaluation';
import type { TestResult } from '../../../src/host/testing/types';

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

describe('AI 评审隔离', () => {
  it('T3：五维全否与全是的 score/status/scoreAuthority 完全相同', () => {
    const yes = reviewed('yes');
    const no = reviewed('no');
    expect({ score: no.score, status: no.status, scoreAuthority: no.scoreAuthority }).toEqual({
      score: yes.score, status: yes.status, scoreAuthority: yes.scoreAuthority,
    });
  });
});
