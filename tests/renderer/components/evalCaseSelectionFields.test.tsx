// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalRunPanelProbe } from '../../../src/shared/contract/evaluation';
import { EvalCaseSelectionFields } from '@internal-evaluation/renderer/evalCenter/EvalCaseSelectionFields';
import { evalRunPanelZh } from '@internal-evaluation/renderer/i18n/evalRunPanel';

function probe(unhardenedCount: number): EvalRunPanelProbe {
  return {
    environment: {
      available: true,
      message: 'ready',
      packaged: false,
      platform: 'darwin',
      osJail: { enabled: true, available: true, active: true },
    },
    model: 'model',
    provider: 'provider',
    priceTableVersion: 1,
    estimatedCostPerCaseUsd: 0.01,
    judge: { model: 'judge', provider: 'provider', estimatedCostPerCaseUsd: 0.01 },
    aiReview: [],
    splitCounts: { 'held-in': 2, 'held-out': 1, safety: 1 },
    unhardenedCount,
    quickCheck: { tags: ['core-path'], maxCases: 2 },
    productionArm: {
      name: 'production',
      model: 'model',
      provider: 'provider',
      harness: {
        name: 'production',
        contextCompression: true,
        compressionPipeline: true,
        scaffoldProfile: false,
        thinkingInjection: true,
        hooksEnabled: true,
        toolMode: 'deferred',
      },
      memory: { longTerm: true },
      skills: [],
    },
    skills: [],
  };
}

afterEach(cleanup);

describe('EvalCaseSelectionFields', () => {
  it('T7：有不会跑的题时明示数量，0 题时节点不存在', () => {
    const props = {
      split: 'held-in' as const,
      tags: [],
      maxCases: 2,
      labels: evalRunPanelZh.runPanel,
      onSplit: vi.fn(),
      onToggleTag: vi.fn(),
      onMaxCases: vi.fn(),
    };
    const { rerender } = render(<EvalCaseSelectionFields {...props} probe={probe(2)} />);
    expect(screen.getByText('另有 2 题还没有判定标准，不会跑')).toBeTruthy();

    rerender(<EvalCaseSelectionFields {...props} probe={probe(0)} />);
    expect(screen.queryByText(/另有 .* 题还没有判定标准/)).toBeNull();
  });
});
