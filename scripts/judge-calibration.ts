#!/usr/bin/env npx tsx
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AnnotationRepository } from '../src/host/services/core/repositories/AnnotationRepository';
import { resolveHumanGoldLabels } from '../src/host/testing/calibration/humanGold';
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

type GoldSource = 'deterministic_shadow' | 'human_annotation';

function readFlag(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (inline !== undefined) return inline;
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(): { reportPath: string; dimension: CalibratableDimension; gold: GoldSource; dataDir: string } {
  const args = process.argv.slice(2);
  const flags = ['--dimension', '--gold', '--data-dir'];
  const reportPath = args.find((arg, index) => !arg.startsWith('--') && !flags.includes(args[index - 1] ?? ''));
  const dimension = readFlag(args, '--dimension');
  const gold = readFlag(args, '--gold') ?? 'deterministic_shadow';
  const dataDir = readFlag(args, '--data-dir') ?? process.env.CODE_AGENT_DATA_DIR?.trim() ?? path.join(homedir(), '.code-agent');
  if (!reportPath || (dimension !== 'task_completed' && dimension !== 'confirmed_before_acting')
    || (gold !== 'deterministic_shadow' && gold !== 'human_annotation')) {
    throw new Error('用法: npx tsx scripts/judge-calibration.ts <report.json> --dimension task_completed|confirmed_before_acting [--gold deterministic_shadow|human_annotation] [--data-dir <dir>]');
  }
  return { reportPath, dimension, gold, dataDir: path.resolve(dataDir) };
}

/**
 * 人标金标：从 app 库读这轮实验里勾了「进金标集」的人工评审（report.runId = experiments.id）。
 * 只读打开；每个 reviewer 取最新一条；多人分歧的题不进金标（课程口径：有争议的题不配进金标集）。
 */
function loadHumanGold(dataDir: string, runId: string, dimension: CalibratableDimension) {
  const db = new Database(path.join(dataDir, 'code-agent.db'), { readonly: true, fileMustExist: true });
  try {
    return resolveHumanGoldLabels(new AnnotationRepository(db).listForExperiment(runId), dimension);
  } finally {
    db.close();
  }
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
  const { reportPath, dimension, gold, dataDir } = parseArgs();
  const runtime = getQuickModelRuntimeInfo();
  if (!runtime) throw new Error('当前没有可用的 quick 模型配置');
  const judgeModel = `${runtime.provider}/${runtime.model}`;
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as {
    runId?: string;
    results?: ReportCase[];
    cases?: ReportCase[];
    environment?: { provider?: string };
    stamp?: { scorers?: { judgeSameSource?: boolean } };
  };
  const cases = report.results ?? report.cases ?? [];
  // 同源裁判（评审模型与被测模型同一 provider）不接受影子金标——自我偏好会让断言真值与 judge 一起偏
  // （docs/eval/annotation-guideline.md §5；ai-review #1823 Important①）。
  const sameSource = report.stamp?.scorers?.judgeSameSource === true
    || (typeof report.environment?.provider === 'string' && report.environment.provider === runtime.provider);
  if (sameSource && gold !== 'human_annotation') {
    throw new Error(`同源裁判（评审 ${judgeModel} 与被测 provider ${report.environment?.provider ?? runtime.provider} 同家）只接受人标金标：加 --gold human_annotation`);
  }
  const pairs: CalibrationPair[] = [];
  let abstained = 0;

  let humanGold: ReturnType<typeof resolveHumanGoldLabels> | null = null;
  if (gold === 'human_annotation') {
    if (!report.runId) throw new Error('报告没有 runId，找不到对应实验的人工评审');
    humanGold = loadHumanGold(dataDir, report.runId, dimension);
    console.log(`人标金标：${humanGold.labels.size} 题可用，${humanGold.contested.length} 题多人分歧跳过，${humanGold.unlabeled.length} 题没标本维`);
    if (humanGold.contested.length) console.log(`  分歧题：${humanGold.contested.join('、')}`);
  }

  for (const reportCase of cases) {
    const truth = humanGold ? humanGold.labels.get(reportCase.testId) ?? null : groundTruth(reportCase, dimension);
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
    if (verdict.verdict === 'abstain') {
      abstained += 1;
      console.log(`○ ${reportCase.testId}: judge=无法确定 金标=${truth}（弃权，不进 κ 配对）`);
      continue;
    }
    pairs.push({
      caseId: reportCase.testId,
      judgeLabel: verdict.verdict === 'yes' ? 'pass' : 'fail',
      groundTruthLabel: truth,
      groundTruthScore: reportCase.score,
    });
    console.log(`${verdict.verdict === (truth === 'pass' ? 'yes' : 'no') ? '✓' : '✗'} ${reportCase.testId}: judge=${verdict.verdict} 金标=${truth}`);
  }

  const calibration = computeCalibration(pairs);
  const judged = calibration.total + abstained;
  const abstainRate = judged > 0 ? abstained / judged : 0;
  const record = {
    standardVersion: 2 as const,
    dimension,
    judgeId: `${dimension}@${judgeModel}`,
    promptHash: getAiReviewPromptHash(dimension),
    endpoint: runtime.baseUrl,
    judgeModel,
    datasetFingerprint: datasetFingerprint(pairs.map((pair) => pair.caseId)),
    goldSource: gold,
    kappa: calibration.cohensKappa,
    agreementRate: calibration.agreementRate,
    pairs: calibration.total,
    falsePositiveRate: calibration.falsePositiveRate,
    abstainRate,
    computedAt: new Date().toISOString(),
  };
  const outputPath = path.join(path.dirname(reportPath), `calibration-${dimension}-${runtime.model}.json`);
  await fs.writeFile(outputPath, JSON.stringify({ dimension, endpoint: runtime.baseUrl, ...calibration }, null, 2), 'utf8');
  await saveCalibrationRecord(path.join(process.cwd(), CONFIG_DIR_NEW), record);

  console.log(`配对样本: ${calibration.total}`);
  console.log(`金标来源: ${gold}`);
  console.log(`弃权: ${abstained}/${judged}（弃权率 ${(abstainRate * 100).toFixed(1)}%，上限 ${(CALIBRATION_TRUST_THRESHOLDS.maxAbstainRate * 100).toFixed(0)}%）`);
  console.log(`Cohen Kappa: ${calibration.cohensKappa.toFixed(3)}`);
  console.log(`κ 95% CI 下界: ${calibration.kappaLowerBound95.toFixed(3)}`);
  console.log(isTrustedCalibration(record)
    ? '校准达标'
    : `校准未达标（κ≥${CALIBRATION_TRUST_THRESHOLDS.minKappa} 且 CI 下界≥${CALIBRATION_TRUST_THRESHOLDS.minKappaLowerBound}，或 n≥${CALIBRATION_TRUST_THRESHOLDS.pairsWaiver}；弃权率≤${(CALIBRATION_TRUST_THRESHOLDS.maxAbstainRate * 100).toFixed(0)}%）`);
  console.log(`报告已存: ${outputPath}`);
}

main().catch((error) => {
  console.error('calibration failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
