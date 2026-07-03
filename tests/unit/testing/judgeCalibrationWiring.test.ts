// ============================================================================
// WP judge 校准接线 — llm_judge 桶必须绑定 calibration 结果才进可信列
// ============================================================================
// scoreAuthority 第二步：llm_judge 分数只有在绑定了达标的校准记录
// （κ≥0.6 substantial 且配对样本≥20）时才可作能力证据；报告层对未校准/
// 不达标的 judge 分强制标注，不让"未经校准的 LLM 打分"冒充可信数字。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'fs/promises';
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
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';

function record(overrides: Partial<JudgeCalibrationRecord> = {}): JudgeCalibrationRecord {
  return {
    judgeId: 'zhipu/glm-4.7',
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
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: 0,
    partial: 0,
    infraExcluded: 0,
    averageScore: 1,
    results,
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
});

describe('calibrationRegistry 落盘', () => {
  it('save → load 按 judgeId 取回记录；未知 judgeId 返回 null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'calib-registry-'));
    await saveCalibrationRecord(dir, record());
    await saveCalibrationRecord(dir, record({ judgeId: 'zhipu/glm-5', kappa: 0.5 }));

    const loaded = await loadCalibrationRecord(dir, 'zhipu/glm-4.7');
    expect(loaded?.kappa).toBe(0.72);
    expect(await loadCalibrationRecord(dir, 'nope/none')).toBeNull();
  });

  it('同 judgeId 重复 save 覆盖旧记录', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'calib-registry-'));
    await saveCalibrationRecord(dir, record({ kappa: 0.3 }));
    await saveCalibrationRecord(dir, record({ kappa: 0.8 }));
    expect((await loadCalibrationRecord(dir, 'zhipu/glm-4.7'))?.kappa).toBe(0.8);
  });
});

describe('报告层强制标注', () => {
  const llmJudged = [
    makeResult({ testId: 'j1', scoreAuthority: 'llm_judge' }),
    makeResult({ testId: 'j2', scoreAuthority: 'llm_judge', status: 'failed', score: 0 }),
  ];

  it('llm_judge 分未绑定校准记录 → 报告强制标注未校准、不作能力证据', () => {
    const md = generateMarkdownReport(makeSummary(llmJudged));
    expect(md).toContain('未校准');
  });

  it('绑定达标校准记录 → 报告展示 κ 与样本数，进可信列', () => {
    const md = generateMarkdownReport(makeSummary(llmJudged, { judgeCalibration: record() }));
    expect(md).toContain('0.72');
    expect(md).toContain('已校准');
    expect(md).not.toContain('未校准');
  });

  it('绑定不达标校准记录（κ 低）→ 仍标注不可信', () => {
    const md = generateMarkdownReport(makeSummary(llmJudged, { judgeCalibration: record({ kappa: 0.4 }) }));
    expect(md).toContain('未达标');
  });

  it('没有 llm_judge 结果时不出现校准告警（不误伤纯断言 run）', () => {
    const md = generateMarkdownReport(makeSummary([makeResult({ scoreAuthority: 'deterministic_assertion' })]));
    expect(md).not.toContain('未校准');
  });
});
