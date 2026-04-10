// ============================================================================
// batchShadowEvaluator tests — V3-γ Multi-Eval Parallelism
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { evaluateBatch } from '../../../../src/main/evaluation/proposals/batchShadowEvaluator';
import type { Proposal } from '../../../../src/main/evaluation/proposals/proposalTypes';
import type { ShadowEvaluatorDeps } from '../../../../src/main/evaluation/proposals/shadowEvaluator';

function makeProposal(id: string, tags: string[] = ['loop', 'bash']): Proposal {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    createdAt: '2026-04-09T10:00:00Z',
    status: 'pending',
    source: 'synthesize',
    type: 'new_l3_experiment',
    hypothesis: `test hypothesis for ${id}`,
    targetMetric: 'metric',
    rollbackCondition: 'condition',
    tags,
    ruleContent: 'some rule',
  };
}

function makeDeps(overrides: Partial<ShadowEvaluatorDeps> = {}): ShadowEvaluatorDeps {
  return {
    scanConflicts: vi.fn().mockResolvedValue([]),
    readAttributionCategories: vi.fn().mockResolvedValue(new Map([['loop', 5]])),
    runRegressionGate: vi.fn().mockResolvedValue('pass' as const),
    ...overrides,
  };
}

describe('evaluateBatch', () => {
  it('returns empty array for empty proposals list', async () => {
    const deps = makeDeps();
    const results = await evaluateBatch([], deps);
    expect(results).toEqual([]);
    // 全局信号不应被调用（空列表直接返回）
    expect(deps.runRegressionGate).not.toHaveBeenCalled();
    expect(deps.readAttributionCategories).not.toHaveBeenCalled();
  });

  it('evaluates multiple proposals and returns results for each', async () => {
    const deps = makeDeps();
    const proposals = [
      makeProposal('prop-001'),
      makeProposal('prop-002'),
      makeProposal('prop-003'),
    ];

    const results = await evaluateBatch(proposals, deps, { concurrency: 2 });

    expect(results).toHaveLength(3);
    expect(results[0].proposal.id).toBe('prop-001');
    expect(results[1].proposal.id).toBe('prop-002');
    expect(results[2].proposal.id).toBe('prop-003');

    // 每个 result 都应有有效的 score
    for (const { result } of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.evaluatedAt).toBeTruthy();
    }
  });

  it('runs regression gate only ONCE for all proposals (shared)', async () => {
    const gateCall = vi.fn().mockResolvedValue('pass' as const);
    const deps = makeDeps({ runRegressionGate: gateCall });
    const proposals = [makeProposal('p1'), makeProposal('p2'), makeProposal('p3')];

    await evaluateBatch(proposals, deps);

    // 全局 regression gate 只调用一次
    expect(gateCall).toHaveBeenCalledTimes(1);
  });

  it('reads attribution categories only ONCE for all proposals (shared)', async () => {
    const attrCall = vi.fn().mockResolvedValue(new Map([['loop', 3]]));
    const deps = makeDeps({ readAttributionCategories: attrCall });
    const proposals = [makeProposal('p1'), makeProposal('p2')];

    await evaluateBatch(proposals, deps);

    // attribution 只读一次
    expect(attrCall).toHaveBeenCalledTimes(1);
  });

  it('runs conflict scan independently per proposal', async () => {
    const scanCall = vi.fn().mockResolvedValue([]);
    const deps = makeDeps({ scanConflicts: scanCall });
    const proposals = [makeProposal('p1'), makeProposal('p2'), makeProposal('p3')];

    await evaluateBatch(proposals, deps);

    // conflict scan 每个 proposal 各调一次
    expect(scanCall).toHaveBeenCalledTimes(3);
    expect(scanCall).toHaveBeenCalledWith(proposals[0]);
    expect(scanCall).toHaveBeenCalledWith(proposals[1]);
    expect(scanCall).toHaveBeenCalledWith(proposals[2]);
  });

  it('propagates gate=block to all proposals', async () => {
    const deps = makeDeps({
      runRegressionGate: vi.fn().mockResolvedValue('block' as const),
    });
    const proposals = [makeProposal('p1'), makeProposal('p2')];

    const results = await evaluateBatch(proposals, deps);

    for (const { result } of results) {
      expect(result.regressionGateDecision).toBe('block');
      expect(result.recommendation).toBe('reject');
    }
  });

  it('handles per-proposal conflicts independently', async () => {
    // p1 有冲突，p2 没有
    const scanCall = vi
      .fn()
      .mockResolvedValueOnce(['/rules/conflict.md'])
      .mockResolvedValueOnce([]);

    const deps = makeDeps({ scanConflicts: scanCall });
    const proposals = [
      makeProposal('p1', ['loop']),
      makeProposal('p2', ['loop']),
    ];

    const results = await evaluateBatch(proposals, deps);

    expect(results[0].result.conflictsWith).toEqual(['/rules/conflict.md']);
    expect(results[0].result.recommendation).toBe('needs_human');
    expect(results[1].result.conflictsWith).toEqual([]);
    expect(results[1].result.recommendation).toBe('apply');
  });
});
