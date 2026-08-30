// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPECTATION_TYPE_CATALOG } from '../../../src/host/testing/expectationCatalog';

vi.mock('@internal-evaluation/renderer/evaluationRunIpc', () => ({
  invokeEvaluation: vi.fn(async () => ({
    assertions: EXPECTATION_TYPE_CATALOG,
    judge: { model: 'glm-4.7', provider: 'zhipu', estimatedCostPerCaseUsd: 0.01 },
    aiReview: [
      { dim: 'task_completed', requiresExpectation: false, calibration: { state: 'calibrated', kappa: 0.71, pairs: 34, goldSource: 'deterministic_shadow' } },
      { dim: 'tool_choice', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'no_record' } },
      { dim: 'confirmed_before_acting', requiresExpectation: false, calibration: { state: 'uncalibrated', reason: 'not_enough_pairs', pairs: 12 } },
      { dim: 'no_extra_changes', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'prompt_changed' } },
      { dim: 'self_tested', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'superseded' } },
    ],
  })),
}));

import { EvalScorersTab } from '@internal-evaluation/renderer/evalCenter/EvalScorersTab';

afterEach(cleanup);

describe('EvalScorersTab', () => {
  it('T7：三分区渲染，断言目录 DOM 数量与生产 catalog 完全相等', async () => {
    render(<EvalScorersTab />);
    expect(await screen.findByText('确定性断言')).toBeTruthy();
    expect(document.querySelectorAll('[data-expectation-type]')).toHaveLength(EXPECTATION_TYPE_CATALOG.length);
    expect(screen.getByText(`其余 ${EXPECTATION_TYPE_CATALOG.length - 7} 种已折叠`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /其余/ }));
    expect(screen.getByText('收起')).toBeTruthy();
    expect(screen.getByText('AI 评审 5 问')).toBeTruthy();
    expect(screen.getByText('人工评审')).toBeTruthy();
  });

  it('展示按维校准理由、影子金标与当前评审模型', async () => {
    render(<EvalScorersTab />);
    expect(await screen.findByText(/已校准 κ=0.71 · 金标 34 条/)).toBeTruthy();
    expect(screen.getByText(/影子金标/)).toBeTruthy();
    expect(screen.getByText(/金标不足 N<20/)).toBeTruthy();
    expect(screen.getByText(/按旧标准，需重跑/)).toBeTruthy();
    expect(screen.getByText(/当前评审模型：zhipu\/glm-4.7/)).toBeTruthy();
  });
});
