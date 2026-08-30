#!/usr/bin/env npx tsx
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AiReviewDimension } from '../src/shared/contract/evaluation';
import { CONFIG_DIR_NEW } from '../src/shared/constants/configDir';
import { quickTask, getQuickModelRuntimeInfo } from '../src/host/model/quickModel';
import { computeCalibration, type CalibrationLabel, type CalibrationPair } from '../src/host/testing/calibration/judgeCalibration';
import { CALIBRATION_TRUST_THRESHOLDS, isTrustedCalibration, saveCalibrationRecord } from '../src/host/testing/calibration/calibrationRegistry';
import { judgeDimensions, getAiReviewPromptHash } from '../src/host/testing/judge/dimensionJudge';
import type { TestCase, TestResult } from '../src/host/testing/types';

type CalibratableDimension = Extract<AiReviewDimension, 'task_completed' | 'confirmed_before_acting'>;

interface ReportCase {
  testId: string;
  description?: string;
  prompt?: string;
  status: string;
  score?: number;
  reference_solution?: string;
  toolExecutions?: TestResult['toolExecutions'];
  responses?: string[];
  errors?: string[];
  expectationResults?: Array<{ expectation?: { type?: string }; passed?: boolean }>;
}

function parseArgs(): { reportPath: string; dimension: CalibratableDimension } {
  const args = process.argv.slice(2);
  const reportPath = args.find((arg) => !arg.startsWith('--'));
  const dimension = args.find((arg) => arg.startsWith('--dimension='))?.split('=')[1]
    ?? (args.includes('--dimension') ? args[args.indexOf('--dimension') + 1] : undefined);
  if (!reportPath || (dimension !== 'task_completed' && dimension !== 'confirmed_before_acting')) {
    throw new Error('用法: npx tsx scripts/judge-calibration.ts <report.json> --dimension task_completed|confirmed_before_acting');
  }
  return { reportPath, dimension };
}

function groundTruth(testCase: ReportCase, dimension: CalibratableDimension): CalibrationLabel | null {
  if (dimension === 'task_completed') {
    const assertions = testCase.expectationResults ?? [];
    if (assertions.length === 0) return null;
    return assertions.every((result) => result.passed === true) ? 'pass' : 'fail';
  }
  const shadows = (testCase.expectationResults ?? []).filter((result) => (
    result.expectation?.type === 'sim_no_write_before_rule'
    || result.expectation?.type === 'sim_stop_respected'
  ));
  if (shadows.length === 0) return null;
  return shadows.every((result) => result.passed === true) ? 'pass' : 'fail';
}

function asJudgeInput(reportCase: ReportCase): { testCase: TestCase; result: TestResult } {
  const testCase = {
    id: reportCase.testId,
    type: 'task',
    description: reportCase.description ?? reportCase.testId,
    prompt: reportCase.prompt ?? reportCase.description ?? reportCase.testId,
    expect: {},
    reference_solution: reportCase.reference_solution,
  } as TestCase;
  const result = {
    testId: reportCase.testId,
    description: reportCase.description ?? reportCase.testId,
    status: reportCase.status,
    score: reportCase.score ?? 0,
    duration: 0,
    startTime: 0,
    endTime: 0,
    toolExecutions: reportCase.toolExecutions ?? [],
    responses: reportCase.responses ?? [],
    errors: reportCase.errors ?? [],
    turnCount: 0,
    expectationResults: reportCase.expectationResults,
  } as TestResult;
  return { testCase, result };
}

function datasetFingerprint(caseIds: string[]): string {
  return createHash('sha256').update([...caseIds].sort().join('\n')).digest('hex');
}

async function main(): Promise<void> {
  const { reportPath, dimension } = parseArgs();
  const runtime = getQuickModelRuntimeInfo();
  if (!runtime) throw new Error('当前没有可用的 quick 模型配置');
  const judgeModel = `${runtime.provider}/${runtime.model}`;
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as { results?: ReportCase[]; cases?: ReportCase[] };
  const cases = report.results ?? report.cases ?? [];
  const pairs: CalibrationPair[] = [];

  for (const reportCase of cases) {
    const truth = groundTruth(reportCase, dimension);
    if (!truth) continue;
    const input = asJudgeInput(reportCase);
    const verdicts = await judgeDimensions(
      { ...input, dims: [dimension] },
      async (prompt) => {
        const response = await quickTask(prompt, 512);
        if (!response.success || !response.content) throw new Error(response.error ?? 'empty response');
        return { content: response.content, judgeModel: `${response.provider}/${response.model}` };
      },
    );
    const verdict = verdicts[dimension];
    if (!verdict || verdict.verdict === 'unavailable') continue;
    pairs.push({
      caseId: reportCase.testId,
      judgeLabel: verdict.verdict === 'yes' ? 'pass' : 'fail',
      groundTruthLabel: truth,
      groundTruthScore: reportCase.score,
    });
    console.log(`${verdict.verdict === (truth === 'pass' ? 'yes' : 'no') ? '✓' : '✗'} ${reportCase.testId}: judge=${verdict.verdict} 金标=${truth}`);
  }

  const calibration = computeCalibration(pairs);
  const record = {
    standardVersion: 2 as const,
    dimension,
    judgeId: `${dimension}@${judgeModel}`,
    promptHash: getAiReviewPromptHash(dimension),
    endpoint: runtime.baseUrl,
    judgeModel,
    datasetFingerprint: datasetFingerprint(pairs.map((pair) => pair.caseId)),
    goldSource: 'deterministic_shadow' as const,
    kappa: calibration.cohensKappa,
    agreementRate: calibration.agreementRate,
    pairs: calibration.total,
    falsePositiveRate: calibration.falsePositiveRate,
    computedAt: new Date().toISOString(),
  };
  const outputPath = path.join(path.dirname(reportPath), `calibration-${dimension}-${runtime.model}.json`);
  await fs.writeFile(outputPath, JSON.stringify({ dimension, endpoint: runtime.baseUrl, ...calibration }, null, 2), 'utf8');
  await saveCalibrationRecord(path.join(process.cwd(), CONFIG_DIR_NEW), record);

  console.log(`配对样本: ${calibration.total}`);
  console.log(`Cohen Kappa: ${calibration.cohensKappa.toFixed(3)}`);
  console.log(`κ 95% CI 下界: ${calibration.kappaLowerBound95.toFixed(3)}`);
  console.log(isTrustedCalibration(record)
    ? '校准达标'
    : `校准未达标（κ≥${CALIBRATION_TRUST_THRESHOLDS.minKappa} 且 CI 下界≥${CALIBRATION_TRUST_THRESHOLDS.minKappaLowerBound}，或 n≥${CALIBRATION_TRUST_THRESHOLDS.pairsWaiver}）`);
  console.log(`报告已存: ${outputPath}`);
}

main().catch((error) => {
  console.error('calibration failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
