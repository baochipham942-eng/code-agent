#!/usr/bin/env npx tsx
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AnnotationRepository } from '../src/host/services/core/repositories/AnnotationRepository';
import { resolveHumanGoldLabels } from './lib/humanGold';
import type { AiReviewDimension, AiReviewVerdict } from '../src/shared/contract/evaluation';
import { CONFIG_DIR_NEW } from '../src/shared/constants/configDir';
import { quickTask, getQuickModelRuntimeInfo } from '../src/host/model/quickModel';
import { resolveProviderApiKey } from '../src/host/model/providers/providerResolution';
import { systemOne } from '../src/host/model/providers/typesafeProvider';
import { MODEL_API_ENDPOINTS } from '../src/shared/constants';
import { JEV_MODEL, JEV_JUDGE_MODEL } from '../src/shared/constants/jevQuestions';
import { computeCalibration, type CalibrationLabel, type CalibrationPair } from '../src/host/testing/calibration/judgeCalibration';
import { resolveCalibrationJudgeIdentity, summarizeRepeatVariance } from './lib/judgeCalibrationRepeat';
import { CALIBRATION_TRUST_THRESHOLDS, isTrustedCalibration, saveCalibrationRecord } from '../src/host/testing/calibration/calibrationRegistry';
import { judgeDimensions, getAiReviewPromptHash, type DimensionJudgePrescreen } from '../src/host/testing/judge/dimensionJudge';
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

function parseArgs(): { reportPath: string; dimension: CalibratableDimension; gold: GoldSource; dataDir: string; repeat: number; prescreen: boolean } {
  const args = process.argv.slice(2);
  const flags = ['--dimension', '--gold', '--data-dir', '--repeat'];
  const reportPath = args.find((arg, index) => !arg.startsWith('--') && !flags.includes(args[index - 1] ?? ''));
  const dimension = readFlag(args, '--dimension');
  const gold = readFlag(args, '--gold') ?? 'deterministic_shadow';
  const dataDir = readFlag(args, '--data-dir') ?? process.env.CODE_AGENT_DATA_DIR?.trim() ?? path.join(homedir(), '.code-agent');
  const repeatRaw = readFlag(args, '--repeat');
  const repeat = repeatRaw === undefined ? 1 : Number.parseInt(repeatRaw, 10);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat 必须是 ≥1 的整数');
  const prescreen = args.includes('--prescreen');
  if (!reportPath || (dimension !== 'task_completed' && dimension !== 'confirmed_before_acting')
    || (gold !== 'deterministic_shadow' && gold !== 'human_annotation')) {
    throw new Error('用法: npx tsx scripts/judge-calibration.ts <report.json> --dimension task_completed|confirmed_before_acting [--gold deterministic_shadow|human_annotation] [--data-dir <dir>] [--repeat N] [--prescreen]');
  }
  return { reportPath, dimension, gold, dataDir: path.resolve(dataDir), repeat, prescreen };
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
  const { reportPath, dimension, gold, dataDir, repeat, prescreen } = parseArgs();
  // quick 运行时惰性解析：--prescreen 全 Jev 决断时不应因为没有 quick 配置而失败（#2023 Important）。
  const runtime = getQuickModelRuntimeInfo();
  // --prescreen：Jev 初筛进校准跑量（N-JEV-EVAL-JUDGE 母单⑥的方差测量也走这条）。
  // 没配 key 直接 fail-loud，不静默回落生成式冒充 Jev 数据。
  let prescreenCall: DimensionJudgePrescreen | undefined;
  if (prescreen) {
    if (!resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL })) {
      throw new Error('--prescreen 需要 TYPESAFE_API_KEY（或 providerResolution 可解析的 typesafe key）');
    }
    prescreenCall = (state, questions) => systemOne(state, questions);
  }
  if (!prescreen && !runtime) throw new Error('当前没有可用的 quick 模型配置');
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
  // prescreen 时实际判官可能是 typesafe（Jev）：同是一种同源裁判，一并纳入比较（#2023 R3 Important）。
  const sameSource = report.stamp?.scorers?.judgeSameSource === true
    || (runtime !== null && typeof report.environment?.provider === 'string' && report.environment.provider === runtime.provider)
    || (prescreen && report.environment?.provider === 'typesafe');
  if (sameSource && gold !== 'human_annotation') {
    throw new Error(`同源裁判（评审 ${runtime ? `${runtime.provider}/${runtime.model}` : JEV_JUDGE_MODEL} 与被测 provider ${report.environment?.provider ?? 'unknown'} 同家）只接受人标金标：加 --gold human_annotation`);
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

  const repeats: Array<{ caseId: string; scores: Array<number | null> }> = [];
  const qualityByCase: Array<{ caseId: string; qualities: number[] }> = [];
  const judgedIdentities = new Set<string>();

  for (const reportCase of cases) {
    const truth = humanGold ? humanGold.labels.get(reportCase.testId) ?? null : groundTruth(reportCase, dimension);
    if (!truth) continue;
    const input = asJudgeInput(reportCase);
    const scores: Array<number | null> = [];
    const qualities: number[] = [];
    let verdict: AiReviewVerdict | undefined;
    for (let run = 0; run < repeat; run += 1) {
      const verdicts = await judgeDimensions(
        { ...input, dims: [dimension] },
        async (prompt) => {
          const response = await quickTask(prompt, 512);
          if (!response.success || !response.content) throw new Error(response.error ?? 'empty response');
          return { content: response.content, judgeModel: `${response.provider}/${response.model}` };
        },
        prescreenCall ? { prescreen: prescreenCall } : undefined,
      );
      verdict = verdicts[dimension];
      // 校准记录的身份必须是实际判决的判官——Jev 决断的 κ 写到 quick 名下会让
      // 未校准的 quick 评审误过校准门（ai-review #2023 Important）。
      if (verdict && verdict.verdict !== 'unavailable') {
        judgedIdentities.add(`${verdict.judgeModel}|${verdict.promptHash}`);
      }
      scores.push(!verdict || verdict.verdict === 'unavailable' || verdict.verdict === 'abstain' ? null : verdict.verdict === 'yes' ? 1 : 0);
      if (verdict?.quality) qualities.push(verdict.quality.score);
    }
    repeats.push({ caseId: reportCase.testId, scores });
    if (qualities.length > 0) qualityByCase.push({ caseId: reportCase.testId, qualities });
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

  if (repeat > 1) {
    const summary = summarizeRepeatVariance(repeats);
    console.log(`\n重复判 ${repeat} 次 × ${repeats.length} 题（冻结轨迹方差，N-JEV-EVAL-JUDGE ⑥）：`);
    console.log(`  翻转总数: ${summary.totalFlips}/${summary.totalRuns}（含弃权↔硬判的切换）`);
    console.log(`  分数方差均值: ${summary.meanVariance === null ? '无足够数值判决' : summary.meanVariance.toFixed(6)}（${summary.varianceCases} 题可计）`);
    for (const entry of summary.cases.filter((item) => item.flips > 0)) {
      console.log(`  ⚠ ${entry.caseId}: 翻转 ${entry.flips} 次，方差 ${entry.scoreVariance === null ? 'n/a' : entry.scoreVariance.toFixed(4)}`);
    }
  }
  if (qualityByCase.length > 0) {
    const all = qualityByCase.flatMap((entry) => entry.qualities);
    const mean = all.reduce((sum, score) => sum + score, 0) / all.length;
    const variance = all.length >= 2 ? all.reduce((sum, score) => sum + (score - mean) ** 2, 0) / all.length : 0;
    // quality 是 score 原语的信息列，不进 κ 配对也不进上岗线
    console.log(`\nquality（信息列，不作放行依据）：${qualityByCase.length} 题有读数，均值 ${mean.toFixed(3)}，总体方差 ${variance.toFixed(6)}`);
  }

  const calibration = computeCalibration(pairs);
  const judged = calibration.total + abstained;
  const abstainRate = judged > 0 ? abstained / judged : 0;

  // 身份解析：--prescreen 且全部判决出自 Jev ⇒ 以 Jev 身份落盘（endpoint/promptHash 都是 Jev 的）；
  // 有任何生成式判决混入 ⇒ 不写校准注册表（混合 κ 不能给任何一侧背书），原始报告仍落盘。
  const identity = resolveCalibrationJudgeIdentity({
    prescreen,
    dimension,
    quick: runtime
      ? { judgeModel: `${runtime.provider}/${runtime.model}`, promptHash: getAiReviewPromptHash(dimension), endpoint: runtime.baseUrl }
      : null,
    judged: [...judgedIdentities].map((entry) => {
      const [judgeModel, promptHash] = entry.split('|');
      return { judgeModel, promptHash };
    }),
    jev: { judgeModel: JEV_JUDGE_MODEL, endpoint: MODEL_API_ENDPOINTS.typesafeSystemOne },
  });
  if (prescreen && !identity) {
    console.warn(`校准身份混合（实际判官：${[...judgedIdentities].join('；') || '无有效判决'}），不写校准注册表——混合 κ 不给任何一侧背书`);
  }

  const outputPath = path.join(
    path.dirname(reportPath),
    `calibration-${dimension}-${identity ? (identity.judgeModel === JEV_JUDGE_MODEL ? JEV_MODEL : runtime!.model) : 'mixed'}.json`,
  );
  await fs.writeFile(
    outputPath,
    JSON.stringify({ dimension, endpoint: identity?.endpoint ?? 'mixed', judgeModel: identity?.judgeModel ?? 'mixed', ...calibration }, null, 2),
    'utf8',
  );
  if (identity) {
    const record = {
      standardVersion: 2 as const,
      dimension,
      judgeId: identity.judgeId,
      promptHash: identity.promptHash,
      endpoint: identity.endpoint,
      judgeModel: identity.judgeModel,
      datasetFingerprint: datasetFingerprint(pairs.map((pair) => pair.caseId)),
      goldSource: gold,
      kappa: calibration.cohensKappa,
      agreementRate: calibration.agreementRate,
      pairs: calibration.total,
      falsePositiveRate: calibration.falsePositiveRate,
      abstainRate,
      computedAt: new Date().toISOString(),
    };
    await saveCalibrationRecord(path.join(process.cwd(), CONFIG_DIR_NEW), record);
    console.log(isTrustedCalibration(record)
      ? '校准达标'
      : `校准未达标（κ≥${CALIBRATION_TRUST_THRESHOLDS.minKappa} 且 CI 下界≥${CALIBRATION_TRUST_THRESHOLDS.minKappaLowerBound}，或 n≥${CALIBRATION_TRUST_THRESHOLDS.pairsWaiver}；弃权率≤${(CALIBRATION_TRUST_THRESHOLDS.maxAbstainRate * 100).toFixed(0)}%）`);
  } else {
    console.log('校准记录未写入注册表（身份混合或非 prescreen 之外的异常路径）');
  }

  console.log(`配对样本: ${calibration.total}`);
  console.log(`金标来源: ${gold}`);
  console.log(`弃权: ${abstained}/${judged}（弃权率 ${(abstainRate * 100).toFixed(1)}%，上限 ${(CALIBRATION_TRUST_THRESHOLDS.maxAbstainRate * 100).toFixed(0)}%）`);
  console.log(`Cohen Kappa: ${calibration.cohensKappa.toFixed(3)}`);
  console.log(`κ 95% CI 下界: ${calibration.kappaLowerBound95.toFixed(3)}`);
  console.log(`判官身份: ${identity ? identity.judgeModel : 'mixed（未写注册表）'}`);
  console.log(`报告已存: ${outputPath}`);
}

main().catch((error) => {
  console.error('calibration failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
