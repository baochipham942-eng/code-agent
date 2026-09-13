import { describe, expect, it } from 'vitest';
import { getRunStampReportRows } from '../../../src/host/testing/runStampReport';
import type { EvalRunStamp } from '../../../src/shared/contract/evaluation';

function stampWith(knobs: Record<string, number> | undefined): EvalRunStamp {
  return {
    caseBankSha: 'a', answerSideSha: 'b',
    evalSet: { split: 'all', splitsFileSha: 'c', tags: [], ids: [] },
    scorers: { deterministic: true, judge: 'rules', judgeModel: 'm', judgeCalibrationId: 'k', aiReview: [], aiReviewCalibration: {} },
    k: 1, aggregationRuleVersion: 1, promptVersion: 'sys-v49',
    shape: { skills: [], plugins: [], memory: false, swarm: false, harness: { name: 'arm', knobs } },
    divergesFromProduction: [], keySource: 'none', priceTableVersion: 1, estimatedCostUsd: 0,
  } as EvalRunStamp;
}

describe('run stamp report · knobs 行', () => {
  const shapeRow = (stamp: EvalRunStamp) => getRunStampReportRows(stamp).map(([, v]) => v).join('\n');
  it('全默认不占行；偏离默认的旋钮列出并带默认值', () => {
    expect(shapeRow(stampWith(undefined))).not.toContain('旋钮');
    expect(shapeRow(stampWith({ 'subagent.compactionThreshold': 0.8 }))).not.toContain('旋钮');
    expect(shapeRow(stampWith({ 'subagent.compactionThreshold': 0.7, 'context.persistentSystemContextTokens': 1200 })))
      .toContain('旋钮：subagent.compactionThreshold=0.7（默认 0.8）');
  });
});
