// ============================================================================
// WP judge 校准接线 — llm_judge 桶必须绑定 calibration 结果才进可信列
// ============================================================================
// scoreAuthority 第二步：llm_judge 分数只有在绑定了达标的校准记录
// （κ≥0.6 substantial 且配对样本≥20）时才可作能力证据；报告层对未校准/
// 不达标的 judge 分强制标注，不让"未经校准的 LLM 打分"冒充可信数字。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  CALIBRATION_TRUST_THRESHOLDS,
  isTrustedCalibration,
  saveCalibrationRecord,
  loadCalibrationRecord,
  type JudgeCalibrationRecord,
} from '../../../src/host/testing/calibration/calibrationRegistry';
import { generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import { approximateKappaLowerBound95 } from '../../../src/host/testing/calibration/judgeCalibration';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';

function record(overrides: Partial<JudgeCalibrationRecord> = {}): JudgeCalibrationRecord {
  return {
    standardVersion: 2,
    dimension: 'task_completed',
    judgeId: 'task_completed@zhipu/glm-4.7',
    promptHash: 'abc',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    judgeModel: 'zhipu/glm-4.7',
    datasetFingerprint: 'def',
    goldSource: 'deterministic_shadow',
    kappa: 0.72,
    agreementRate: 0.9,
    pairs: 40,
    falsePositiveRate: 0.05,
    computedAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

function makeResult(overrides: Partial<TestResult>): TestResult {
  return {
    testId: 'case-x',
    description: 'desc',
    status: 'passed',
    duration: 100,
    startTime: 0,
    endTime: 100,
    toolExecutions: [],
    responses: [],
    errors: [],
    turnCount: 1,
    score: 1,
    ...overrides,
  };
}

function makeSummary(results: TestResult[], extra: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    runId: 'run-1',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: results.length,
    plannedCaseIds: results.map((result) => result.testId),
    completed: true,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: 0,
    partial: 0,
    infraExcluded: 0,
    notRun: 0,
    invalidCases: results.filter((result) => result.invalid).length,
    averageScore: 1,
    results,
    stamp: UNKNOWN_EVAL_RUN_STAMP,
    environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
    ...extra,
  };
}

describe('isTrustedCalibration 阈值门', () => {
  it('κ 与样本数都达标 → 可信', () => {
    expect(isTrustedCalibration(record())).toBe(true);
  });

  it('κ 低于 substantial 档 → 不可信', () => {
    expect(isTrustedCalibration(record({ kappa: 0.45 }))).toBe(false);
  });

  it('配对样本不足 → 不可信（小样本 κ 不稳）', () => {
    expect(isTrustedCalibration(record({ pairs: CALIBRATION_TRUST_THRESHOLDS.minPairs - 1 }))).toBe(false);
  });

  it('T8：20 对且 κ=0.65 但 CI 下界不足 0.4 → 不可信；50 对 κ=0.62 → 可信', () => {
    expect(isTrustedCalibration(record({ pairs: 20, kappa: 0.65 }))).toBe(false);
    expect(isTrustedCalibration(record({ pairs: 50, kappa: 0.62 }))).toBe(true);
  });

  it('50 对豁免独立生效：κ=0.6 的 CI 下界不足 0.4 仍可信', () => {
    expect(approximateKappaLowerBound95(0.6, 50)).toBeLessThan(0.4);
    expect(isTrustedCalibration(record({ pairs: 50, kappa: 0.6 }))).toBe(true);
  });
});

describe('calibrationRegistry 落盘', () => {
  it('save → load 按 judgeId 取回记录；未知 judgeId 返回 null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'calib-registry-'));
    await saveCalibrationRecord(dir, record());
    await saveCalibrationRecord(dir, record({ judgeId: 'task_completed@zhipu/glm-5', kappa: 0.5 }));

    const loaded = await loadCalibrationRecord(dir, 'task_completed@zhipu/glm-4.7');
    expect(loaded?.kappa).toBe(0.72);
    expect(await loadCalibrationRecord(dir, 'nope/none')).toBeNull();
  });

  it('同 judgeId 重复 save 覆盖旧记录', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'calib-registry-'));
    await saveCalibrationRecord(dir, record({ kappa: 0.3 }));
    await saveCalibrationRecord(dir, record({ kappa: 0.8 }));
    expect((await loadCalibrationRecord(dir, 'task_completed@zhipu/glm-4.7'))?.kappa).toBe(0.8);
  });

  it('T8：旧记录无 standardVersion 时读为 superseded 且永不可信', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'calib-registry-'));
    await writeFile(path.join(dir, 'judge-calibration.json'), JSON.stringify({
      'legacy/model': { judgeId: 'legacy/model', kappa: 0.9, agreementRate: 0.95, pairs: 100, falsePositiveRate: 0, computedAt: '2026-01-01' },
    }));
    const loaded = await loadCalibrationRecord(dir, 'legacy/model');
    expect(loaded?.standardVersion).toBe('superseded');
    expect(loaded && isTrustedCalibration(loaded)).toBe(false);
  });
});

describe('AI 评审报告并列展示', () => {
  const aiReviewed = [
    makeResult({ testId: 'j1', scoreAuthority: 'deterministic_assertion', aiReview: { task_completed: { verdict: 'yes', reasoning: '完成', judgeModel: 'zhipu/glm', promptHash: 'abc' } } }),
    makeResult({ testId: 'j2', scoreAuthority: 'deterministic_assertion', status: 'failed', score: 0, aiReview: { task_completed: { verdict: 'no', reasoning: '未完成', judgeModel: 'zhipu/glm', promptHash: 'abc' } } }),
  ];

  it('按维统计是/否，并明确不进通过率', () => {
    const md = generateMarkdownReport(makeSummary(aiReviewed));
    expect(md).toContain('AI 评审（并列 · 不进通过率）');
    expect(md).toContain('| 任务完成 | 1 | 1 | 0 |');
  });

  it('没有 AI 评审结果时不渲染并列表', () => {
    const md = generateMarkdownReport(makeSummary([makeResult({ scoreAuthority: 'deterministic_assertion' })]));
    expect(md).not.toContain('AI 评审（并列 · 不进通过率）');
  });

  it('T3：同一批题的 AI 评审全是或全否，通过率行逐字相同', () => {
    const withVerdict = (verdict: 'yes' | 'no') => aiReviewed.map((result) => ({
      ...result,
      aiReview: {
        task_completed: {
          verdict,
          reasoning: verdict,
          judgeModel: 'zhipu/glm',
          promptHash: 'abc',
        },
      },
    }));
    const passRateLine = (results: TestResult[]) => generateMarkdownReport(makeSummary(results))
      .split('\n')
      .find((line) => line.startsWith('| 通过率 |'));

    expect(passRateLine(withVerdict('yes'))).toBe('| 通过率 | 50.0% |');
    expect(passRateLine(withVerdict('no'))).toBe(passRateLine(withVerdict('yes')));
  });
});
