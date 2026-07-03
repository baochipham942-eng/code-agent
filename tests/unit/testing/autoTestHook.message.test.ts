// ---------------------------------------------------------------------------
// autoTestHook 完成消息的通过率口径（Codex 审计 R1 MED）：
// 与 markdown/HTML 报告一致——能力分母 = total - skipped - infraExcluded（WP1-2），
// 分母为 0（全 skipped / 全 infra）时输出 0.0% 而非 NaN/Infinity。
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { formatAutoTestCompletionMessage } from '../../../src/host/testing/autoTestHook';
import type { TestRunSummary } from '../../../src/host/testing/types';

function makeSummary(overrides: Partial<TestRunSummary>): TestRunSummary {
  return {
    runId: 'run-1',
    startTime: 0,
    endTime: 1,
    duration: 1,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    partial: 0,
    infraExcluded: 0,
    averageScore: 0,
    results: [],
    environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 0, maxResponseTime: 0, totalToolCalls: 0, totalTurns: 0 },
    ...overrides,
  };
}

describe('formatAutoTestCompletionMessage', () => {
  it('infra_excluded 不进能力分母（与 WP1-2 口径一致）', () => {
    const msg = formatAutoTestCompletionMessage(makeSummary({ total: 2, passed: 1, infraExcluded: 1 }));
    expect(msg).toContain('(100.0%)');
    expect(msg).toContain('1/2 passed');
  });

  it('skipped 不进能力分母', () => {
    const msg = formatAutoTestCompletionMessage(makeSummary({ total: 2, passed: 1, skipped: 1 }));
    expect(msg).toContain('(100.0%)');
  });

  it('全 skipped 时输出 0.0% 而非 NaN/Infinity', () => {
    const msg = formatAutoTestCompletionMessage(makeSummary({ total: 1, skipped: 1 }));
    expect(msg).toContain('(0.0%)');
    expect(msg).not.toMatch(/NaN|Infinity/);
  });
});
