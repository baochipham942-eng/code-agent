// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalExperimentDetail, EvalRunPanelProbe, EvalShipGateVerdict } from '../../../src/shared/contract/evaluation';
import { EvalExperimentResult } from '@internal-evaluation/renderer/evalCenter/EvalExperimentResult';
import { EvalExperimentWizard } from '@internal-evaluation/renderer/evalCenter/EvalExperimentWizard';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

afterEach(cleanup);

function verdict(state: EvalShipGateVerdict['state'], hardGatePassed = true): EvalShipGateVerdict {
  return {
    state, delta: 3, nMin: 30, decisivePairs: 18, pValue: 0.04, passRateDiff: 0.1, ciLowerBound: -0.01,
    hardGate: { passed: hardGatePassed, items: [
      { key: 'false_allow', status: hardGatePassed ? 'pass' : 'fail', count: hardGatePassed ? 0 : 2 },
      { key: 'false_block', status: 'not_measured' },
    ] },
    calibre: { k: 1, aggregationRuleVersion: 4, promptVersion: 'sys-v45' }, reasons: ['fixture'],
  };
}

function detail(state: EvalShipGateVerdict['state'], hardGatePassed = true): EvalExperimentDetail {
  return {
    experiment: {
      id: `exp-${state}`, name: 'candidate-v3', timestamp: 1, model: 'm', provider: 'p', scope: 'full', source: 'compare', gitCommit: 'abc',
      config: { ...UNKNOWN_EVAL_RUN_STAMP, compare: {
        baseline: { name: 'production', model: 'm', provider: 'p' }, candidate: { name: 'candidate-v3', model: 'm', provider: 'p', systemPrompt: 'new' },
        diff: ['systemPrompt: sys-v45 → candidate-v3'],
      } },
      summary: { completed: true, compare: {
        totalCases: 20, baselineWins: 7, candidateWins: 11, ties: 2, excludedPairs: 1,
        skillNotActivatedPairs: 1, pValue: 0.04, shipGate: verdict(state, hardGatePassed),
      } },
    },
    cases: [{
      caseId: 'case-1', status: 'passed', score: 100, durationMs: 10,
      data: { assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed', winner: 'candidate', referenceWinner: 'A', skillActivations: { baseline: 0, candidate: 2 } },
    }],
  };
}

function probe(): EvalRunPanelProbe {
  return {
    environment: { available: true, message: 'ready', packaged: false, platform: 'darwin', osJail: { enabled: true, available: true, active: true } },
    model: 'm', provider: 'p', priceTableVersion: 1, estimatedCostPerCaseUsd: 0.01,
    judge: { model: 'judge', provider: 'p', estimatedCostPerCaseUsd: 0.01 }, aiReview: [],
    splitCounts: { 'held-in': 2, 'held-out': 1, safety: 1 }, quickCheck: { tags: [], maxCases: 1 },
    productionArm: { name: 'production@sys-v45', model: 'm', provider: 'p', harness: { name: 'production', contextCompression: true }, memory: { longTerm: true }, skills: ['xlsx'] },
    skills: ['xlsx', 'docx'],
  };
}

describe('实验页四态与新建守卫', () => {
  it.each([
    ['candidate_better', '实验组更好'], ['non_inferior', '非劣'], ['candidate_worse', '实验组更差'], ['insufficient', '样本不足'],
  ] as const)('T4：%s 只渲染 host 给出的对应徽标', (state, copy) => {
    render(<EvalExperimentResult detail={detail(state)} onBack={vi.fn()} />);
    expect(screen.getByTestId(`experiment-verdict-${state}`).textContent).toContain(copy);
    if (state === 'insufficient') expect(screen.getByText('这不是势均力敌，是数据还不够')).toBeTruthy();
  });

  it('硬门失败显示红行，技术详情保留统计与未测量项', () => {
    render(<EvalExperimentResult detail={detail('candidate_worse', false)} onBack={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('安全项出现 2 次，不能上线');
    fireEvent.click(screen.getByText('技术详情'));
    const technical = screen.getByTestId('experiment-technical-details').textContent ?? '';
    expect(technical).toContain('pValue');
    expect(technical).toContain('分出胜负的题');
    expect(technical).toContain('false_block');
  });

  it('T6：两组签名相同时主按钮置灰，改 systemPrompt 后可进入二次确认', () => {
    render(<EvalExperimentWizard open probe={probe()} starting={false} onClose={vi.fn()} onStart={vi.fn()} />);
    const button = screen.getByTestId('experiment-run-confirm') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('experiment-same-reason').textContent).toContain('两组一样，没法比');
    fireEvent.change(screen.getByPlaceholderText('production@sys-v45'), { target: { value: 'candidate prompt' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(button.textContent).toContain('再点一次确认发车');
  });
});
