// ============================================================================
// Judge 校准：量化 LLM judge 与金标（确定性断言 / 人工抽检）的一致性
// ============================================================================
// 背景：SwissCheese 的 LLM 打分此前从未被校准，无法区分"agent 真变强"与
// "judge 被讨好"。本模块把 judge 判定与金标判定配对，算混淆矩阵 + Cohen's
// Kappa（去除随机一致后的真实一致度）+ 分歧清单。金标可以是确定性断言结果
// （零人力，本期默认），也可以是人工抽检（最高可信度，后续接入）—— 同一套
// 数学，换数据源即可。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { computeCalibration, type CalibrationPair } from '../../../src/host/testing/calibration/judgeCalibration';

// 构造一组 judge 与金标的配对，命中已知的混淆矩阵：TP=4, TN=3, FP=2, FN=1
function fixedPairs(): CalibrationPair[] {
  const pairs: CalibrationPair[] = [];
  const push = (n: number, judge: 'pass' | 'fail', truth: 'pass' | 'fail') => {
    for (let i = 0; i < n; i++) {
      pairs.push({ caseId: `${judge}-${truth}-${i}`, judgeLabel: judge, groundTruthLabel: truth });
    }
  };
  push(4, 'pass', 'pass'); // TP
  push(3, 'fail', 'fail'); // TN
  push(2, 'pass', 'fail'); // FP — judge 虚高/被讨好
  push(1, 'fail', 'pass'); // FN — judge 误杀
  return pairs;
}

describe('computeCalibration', () => {
  it('混淆矩阵与一致率正确', () => {
    const r = computeCalibration(fixedPairs());
    expect(r.total).toBe(10);
    expect(r.confusion).toEqual({ truePositive: 4, trueNegative: 3, falsePositive: 2, falseNegative: 1 });
    expect(r.agreementRate).toBeCloseTo(0.7);
  });

  it('Cohen Kappa 去除随机一致（手算应为 0.4）', () => {
    // po=0.7; pe=0.6*0.5+0.4*0.5=0.5; kappa=(0.7-0.5)/(1-0.5)=0.4
    const r = computeCalibration(fixedPairs());
    expect(r.cohensKappa).toBeCloseTo(0.4);
    expect(r.kappaInterpretation).toMatch(/fair/i);
  });

  it('虚高率(FP)与误杀率(FN)正确', () => {
    const r = computeCalibration(fixedPairs());
    expect(r.falsePositiveRate).toBeCloseTo(2 / 5); // FP/(FP+TN)
    expect(r.falseNegativeRate).toBeCloseTo(1 / 5); // FN/(FN+TP)
  });

  it('完全一致 → kappa=1, agreement=1', () => {
    const pairs: CalibrationPair[] = [
      { caseId: 'a', judgeLabel: 'pass', groundTruthLabel: 'pass' },
      { caseId: 'b', judgeLabel: 'fail', groundTruthLabel: 'fail' },
      { caseId: 'c', judgeLabel: 'pass', groundTruthLabel: 'pass' },
    ];
    const r = computeCalibration(pairs);
    expect(r.agreementRate).toBe(1);
    expect(r.cohensKappa).toBe(1);
    expect(r.kappaInterpretation).toMatch(/almost perfect/i);
  });

  it('列出所有分歧 case', () => {
    const r = computeCalibration(fixedPairs());
    expect(r.disagreements).toHaveLength(3); // 2 FP + 1 FN
    expect(r.disagreements.every((d) => d.judgeLabel !== d.groundTruthLabel)).toBe(true);
  });

  it('提供分数时计算 Pearson 相关', () => {
    const pairs: CalibrationPair[] = [
      { caseId: 'a', judgeLabel: 'pass', groundTruthLabel: 'pass', judgeScore: 0.9, groundTruthScore: 1.0 },
      { caseId: 'b', judgeLabel: 'fail', groundTruthLabel: 'fail', judgeScore: 0.2, groundTruthScore: 0.0 },
      { caseId: 'c', judgeLabel: 'pass', groundTruthLabel: 'pass', judgeScore: 0.7, groundTruthScore: 0.6 },
    ];
    const r = computeCalibration(pairs);
    expect(r.scoreCorrelation).toBeGreaterThan(0.9); // 强正相关
  });

  it('空输入安全降级', () => {
    const r = computeCalibration([]);
    expect(r.total).toBe(0);
    expect(r.cohensKappa).toBe(0);
    expect(r.disagreements).toEqual([]);
  });
});
