import { describe, expect, it } from 'vitest';
import {
  aggregateTrials,
  correctedSampleStats,
} from '../../../src/host/testing/trialAggregation';

function trial(status: 'passed' | 'failed' | 'infra_excluded') {
  return { status, score: status === 'passed' ? 1 : 0 };
}

describe('aggregateTrials', () => {
  it('k=3 with two passes fails the all-pass rule even though at least one pass is guaranteed', () => {
    const aggregate = aggregateTrials([
      trial('passed'),
      trial('passed'),
      trial('failed'),
    ], 3);

    expect(aggregate).toMatchObject({
      status: 'failed',
      passCount: 2,
      trialCount: 3,
      passAtK: 1,
      passCaretK: 0,
      unstable: true,
    });
  });

  it('uses the combination estimators for n=5, c=3, k=2', () => {
    const aggregate = aggregateTrials([
      trial('passed'),
      trial('passed'),
      trial('passed'),
      trial('failed'),
      trial('failed'),
    ], 2);

    expect(aggregate.passCaretK).toBeCloseTo(0.3, 12);
    expect(aggregate.passAtK).toBeCloseTo(0.9, 12);
  });

  it('throws when observed trials are fewer than k', () => {
    expect(() => aggregateTrials([trial('passed')], 2)).toThrow(/k=2.*n=1/);
  });

  it('keeps an all-infrastructure case outside the capability observations', () => {
    expect(aggregateTrials([
      trial('infra_excluded'),
      trial('infra_excluded'),
    ], 2)).toMatchObject({ status: 'infra_excluded', trialCount: 0, passCount: 0 });
  });

  it('does not count an invalid passing trial in c', () => {
    expect(aggregateTrials([
      trial('passed'),
      { ...trial('passed'), invalid: { reason: 'usage_unavailable' as const } },
    ], 2)).toMatchObject({
      status: 'failed',
      trialCount: 2,
      passCount: 1,
      passCaretK: 0,
    });
  });

  it('reports c=0 when every passing trial is invalid', () => {
    expect(aggregateTrials([
      { ...trial('passed'), invalid: { reason: 'usage_unavailable' as const } },
      { ...trial('passed'), invalid: { reason: 'usage_unavailable' as const } },
    ], 2)).toMatchObject({
      status: 'failed',
      trialCount: 2,
      passCount: 0,
      passCaretK: 0,
    });
  });
  // 2026-08-30 监工代笔（Grok 变异席抓出的盲区）：isPassingTrial 的第三条件此前没有任何夹具，
  // 删掉 telemetryGate 判断 4 文件 41/41 仍绿。真实路径里 attachTelemetryReplay 会先把门失败
  // 试次改成 failed，这里钉的是纯函数自身的不变量：status='passed' 但门失败的试次不进 c。
  it('does not count a passing trial whose telemetry gate failed in c', () => {
    const gateFailed = { name: 'real-agent-run' as const, passed: false, failures: ['missing_turns'] };
    expect(aggregateTrials([
      trial('passed'),
      { ...trial('passed'), telemetryGate: gateFailed },
    ], 2)).toMatchObject({
      status: 'failed',
      trialCount: 2,
      passCount: 1,
      passCaretK: 0,
    });
  });

  it('reports c=0 when every passing trial failed its telemetry gate', () => {
    const gateFailed = { name: 'real-agent-run' as const, passed: false, failures: ['missing_turns'] };
    expect(aggregateTrials([
      { ...trial('passed'), telemetryGate: gateFailed },
      { ...trial('passed'), telemetryGate: gateFailed },
    ], 2)).toMatchObject({
      status: 'failed',
      trialCount: 2,
      passCount: 0,
      passCaretK: 0,
    });
  });
});

describe('correctedSampleStats', () => {
  it('applies the K-1 correction for K=2', () => {
    const corrected = correctedSampleStats([0, 1]);
    expect(corrected?.variance).toBeCloseTo(0.5, 12);
    expect(corrected?.variance).not.toBeCloseTo(0.25, 12);
    expect(corrected?.stdDev).toBeCloseTo(Math.sqrt(0.5), 12);
  });

  it('does not emit a numeric sigma for K=1', () => {
    expect(correctedSampleStats([1])).toBeUndefined();
  });
});
