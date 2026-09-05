// A/B Comparator - Run blind comparisons between baseline and candidate configurations
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  TestCase,
  TestResult,
  CompareConfiguration,
  CaseComparison,
  ComparisonResult,
  DualRubricScore,
} from '../types';
import { ABGrader } from './abGrader';
import { signTestPValue } from './signTest';
import { decideCaseWinner } from './assertionWinner';
import { isRedlineCase } from '../testCaseClassification';
import {
  decideShipVerdict,
  type HardGateItem,
  type ShipGateCalibre,
} from './shipGate';

/**
 * WP1-3b：判定一侧是否「没跑成」——infra_excluded（429/超时/5xx/网络）
 * 或零产出带错误（如 key 失效 401）。这类 run 没有能力数据，评它的分
 * 会把「无数据」冒充成「势均力敌」（MiMo 401 冒烟实锤：双侧空输出被
 * heuristic 评成 2.0:2.0 平局）。能力性失败（有产出但做错）不算。
 */
function invalidRunReason(result: TestResult): string | null {
  if (result.invalid) {
    return `无效题（没调真模型：${result.invalid.reason}）`;
  }
  if (result.status === 'infra_excluded') {
    return `infra_excluded（${result.failureReason ?? 'infra error'}）`;
  }
  if (result.status === 'cost_exceeded') {
    return `cost_exceeded（${result.failureReason ?? 'case cost limit exceeded'}）`;
  }
  if (result.status === 'not_run') {
    return `not_run（${result.failureReason ?? 'case did not run'}）`;
  }
  if (
    result.responses.length === 0 &&
    result.toolExecutions.length === 0 &&
    result.errors.length > 0
  ) {
    return `零产出（${result.errors[0]}）`;
  }
  return null;
}

const ZERO_RUBRIC: DualRubricScore = {
  content: { correctness: 0, completeness: 0, accuracy: 0, total: 0 },
  structure: { organization: 0, formatting: 0, usability: 0, total: 0 },
  combined: 0,
};

function activationTotal(activations: Record<string, number> | undefined): number {
  return Object.values(activations ?? {}).reduce((sum, count) => sum + count, 0);
}

function addActivations(
  total: Record<string, number>,
  activations: Record<string, number>,
): void {
  for (const [name, count] of Object.entries(activations)) {
    total[name] = (total[name] ?? 0) + count;
  }
}

/**
 * Runs A/B comparisons between a baseline and candidate configuration.
 * For each test case, randomly assigns baseline/candidate to A/B,
 * runs both blind, grades them, then unblinds to determine the real winner.
 */
export class ABComparator {
  private grader: ABGrader;

  constructor(
    private baseline: CompareConfiguration,
    private candidate: CompareConfiguration,
    private calibre: ShipGateCalibre,
    private runId?: string,
  ) {
    this.grader = new ABGrader();
  }

  /**
   * Run comparison across all test cases.
   * @param testCases - Test cases to compare on
   * @param runSingleTest - Callback that executes a single test with a given config
   * @param llmCall - Optional LLM callback for grading (falls back to heuristic rules)
   */
  async runComparison(
    testCases: TestCase[],
    runSingleTest: (testCase: TestCase, config: CompareConfiguration) => Promise<TestResult>,
    llmCall?: (prompt: string) => Promise<string>,
  ): Promise<ComparisonResult> {
    const runId = this.runId ?? uuidv4();
    const startTime = Date.now();
    const cases: CaseComparison[] = [];

    for (const testCase of testCases) {
      if (testCase.skip) continue;

      const comparison = await this.runSingleComparison(testCase, runSingleTest, llmCall);
      cases.push(comparison);
    }

    const duration = Date.now() - startTime;
    const summary = this.computeSummary(cases, testCases);

    return {
      runId,
      timestamp: startTime,
      baseline: this.baseline,
      candidate: this.candidate,
      cases,
      summary,
      duration,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async runSingleComparison(
    testCase: TestCase,
    runSingleTest: (testCase: TestCase, config: CompareConfiguration) => Promise<TestResult>,
    llmCall?: (prompt: string) => Promise<string>,
  ): Promise<CaseComparison> {
    // Step 1: Randomly assign baseline/candidate to A/B
    const baselineIsA = crypto.randomInt(2) === 0;
    const configA = baselineIsA ? this.baseline : this.candidate;
    const configB = baselineIsA ? this.candidate : this.baseline;

    const assignment: CaseComparison['assignment'] = {
      A: baselineIsA ? 'baseline' : 'candidate',
      B: baselineIsA ? 'candidate' : 'baseline',
    };

    // Step 2: Run A then B
    const startA = Date.now();
    const resultA = await runSingleTest(testCase, configA);
    const durationA = Date.now() - startA;

    const startB = Date.now();
    const resultB = await runSingleTest(testCase, configB);
    const durationB = Date.now() - startB;

    const baselineResult = assignment.A === 'baseline' ? resultA : resultB;
    const candidateResult = assignment.A === 'candidate' ? resultA : resultB;
    const assertionDecision = decideCaseWinner(baselineResult, candidateResult);
    const passRateA = assignment.A === 'baseline'
      ? assertionDecision.passRateA
      : assertionDecision.passRateB;
    const passRateB = assignment.B === 'baseline'
      ? assertionDecision.passRateA
      : assertionDecision.passRateB;
    const skillActivationsA = { ...(resultA.skillActivations ?? {}) };
    const skillActivationsB = { ...(resultB.skillActivations ?? {}) };
    // N-EVAL-MEMORY：「挂了≠用了」——记忆注入次数按臂进 pair，候选臂为 0 时结果页提示未出场。
    const memoryInjectionsA = resultA.memoryRecall?.injections ?? 0;
    const memoryInjectionsB = resultB.memoryRecall?.injections ?? 0;
    const subagentSpawnsA = resultA.subagentSpawns ?? 0;
    const subagentSpawnsB = resultB.subagentSpawns ?? 0;

    // Step 2.5（WP1-3b）：任一侧没跑成 → 本 pair 不进胜负统计，只标注
    const invalidA = invalidRunReason(resultA);
    const invalidB = invalidRunReason(resultB);
    if (invalidA || invalidB) {
      const reasons = [
        invalidA ? `${assignment.A}: ${invalidA}` : null,
        invalidB ? `${assignment.B}: ${invalidB}` : null,
      ].filter(Boolean).join('; ');
      return {
        testId: testCase.id,
        description: testCase.description,
        layer: testCase.layer,
        assignment,
        scoreA: ZERO_RUBRIC,
        scoreB: ZERO_RUBRIC,
        referenceWinner: 'tie',
        referenceKind: llmCall ? 'llm_judge' : 'heuristic',
        assertionWinner: 'tie',
        passRateA,
        passRateB,
        assertionCount: assertionDecision.assertionCount,
        realWinner: 'tie',
        reasoning: `pair 排除（未计入胜负）：${reasons}`,
        statusA: resultA.status,
        statusB: resultB.status,
        failureA: resultA.failure,
        failureB: resultB.failure,
        durationA,
        durationB,
        skillActivationsA,
        skillActivationsB,
        memoryInjectionsA,
        memoryInjectionsB,
        subagentSpawnsA,
        subagentSpawnsB,
        excludedReason: reasons,
      };
    }

    if ((this.candidate.skills?.length ?? 0) > 0 && activationTotal(candidateResult.skillActivations) === 0) {
      return {
        testId: testCase.id,
        description: testCase.description,
        layer: testCase.layer,
        assignment,
        scoreA: ZERO_RUBRIC,
        scoreB: ZERO_RUBRIC,
        referenceWinner: 'tie',
        referenceKind: llmCall ? 'llm_judge' : 'heuristic',
        assertionWinner: 'tie',
        passRateA,
        passRateB,
        assertionCount: assertionDecision.assertionCount,
        realWinner: 'tie',
        reasoning: 'pair 排除（未计入胜负）：skill 未出场，结论不说明 skill 效果',
        statusA: resultA.status,
        statusB: resultB.status,
        failureA: resultA.failure,
        failureB: resultB.failure,
        durationA,
        durationB,
        skillActivationsA,
        skillActivationsB,
        memoryInjectionsA,
        memoryInjectionsB,
        subagentSpawnsA,
        subagentSpawnsB,
        excludedReason: 'skill_not_activated',
      };
    }

    // Step 3: Grade blind
    const gradeResult = await this.grader.grade(
      testCase,
      {
        responses: resultA.responses,
        toolCalls: resultA.toolExecutions.map((t) => t.tool),
      },
      {
        responses: resultB.responses,
        toolCalls: resultB.toolExecutions.map((t) => t.tool),
      },
      llmCall,
    );

    return {
      testId: testCase.id,
      description: testCase.description,
      layer: testCase.layer,
      assignment,
      scoreA: gradeResult.scoreA,
      scoreB: gradeResult.scoreB,
      referenceWinner: gradeResult.winner,
      referenceKind: llmCall ? 'llm_judge' : 'heuristic',
      assertionWinner: assertionDecision.winner,
      passRateA,
      passRateB,
      assertionCount: assertionDecision.assertionCount,
      realWinner: assertionDecision.winner,
      reasoning: gradeResult.reasoning,
      statusA: resultA.status,
      statusB: resultB.status,
      failureA: resultA.failure,
      failureB: resultB.failure,
      durationA,
      durationB,
      skillActivationsA,
      skillActivationsB,
      memoryInjectionsA,
      memoryInjectionsB,
      subagentSpawnsA,
      subagentSpawnsB,
    };
  }

  private computeSummary(
    allCases: CaseComparison[],
    testCases: TestCase[],
  ): ComparisonResult['summary'] {
    // WP1-3b：排除的 pair 不进胜负/均分统计
    const excludedPairs = allCases.filter((c) => c.excludedReason).length;
    const skillNotActivatedPairs = allCases.filter((c) => c.excludedReason === 'skill_not_activated').length;
    const cases = allCases.filter((c) => !c.excludedReason);
    const totalCases = cases.length;
    const baselineWins = cases.filter((c) => c.realWinner === 'baseline').length;
    const candidateWins = cases.filter((c) => c.realWinner === 'candidate').length;
    const ties = cases.filter((c) => c.realWinner === 'tie').length;

    // Average scores: need to map back from A/B to baseline/candidate
    let baselineTotalScore = 0;
    let candidateTotalScore = 0;
    for (const c of cases) {
      if (c.assignment.A === 'baseline') {
        baselineTotalScore += c.scoreA.combined;
        candidateTotalScore += c.scoreB.combined;
      } else {
        baselineTotalScore += c.scoreB.combined;
        candidateTotalScore += c.scoreA.combined;
      }
    }
    const baselineAvgScore = totalCases > 0 ? baselineTotalScore / totalCases : 0;
    const candidateAvgScore = totalCases > 0 ? candidateTotalScore / totalCases : 0;

    // Determine overall winner
    let winner: 'baseline' | 'candidate' | 'tie';
    if (baselineWins > candidateWins) {
      winner = 'baseline';
    } else if (candidateWins > baselineWins) {
      winner = 'candidate';
    } else {
      winner = 'tie';
    }

    // Simple confidence: ratio of decisive cases
    const decisiveCases = baselineWins + candidateWins;
    const confidence =
      totalCases > 0 && decisiveCases > 0
        ? Math.max(baselineWins, candidateWins) / decisiveCases
        : 0;

    // 配对 sign test：confidence 只是多数比例，2:0 和 25:15 看不出可信度差异
    const pValue = signTestPValue(baselineWins, candidateWins);

    const testCaseById = new Map(testCases.map((testCase) => [testCase.id, testCase]));
    const statusForRole = (
      comparison: CaseComparison,
      role: 'baseline' | 'candidate',
    ) => comparison.assignment.A === role ? comparison.statusA : comparison.statusB;
    const candidateOnlyPass = cases.filter((comparison) => (
      statusForRole(comparison, 'candidate') === 'passed'
      && statusForRole(comparison, 'baseline') !== 'passed'
    )).length;
    const baselineOnlyPass = cases.filter((comparison) => (
      statusForRole(comparison, 'baseline') === 'passed'
      && statusForRole(comparison, 'candidate') !== 'passed'
    )).length;
    // 硬门①只看有效 pair（invalidRunReason / skill_not_activated 两种排除都不进）；
    // 有效对里一道红线题都没有 ⇒ 没测量，不许写成 0/pass（安全集没跑到 ≠ 安全）。
    const redlineCases = cases.filter((comparison) => {
      const testCase = testCaseById.get(comparison.testId);
      return testCase !== undefined && isRedlineCase(testCase);
    });
    const falseAllowCaseIds = redlineCases.filter(
      (comparison) => statusForRole(comparison, 'candidate') !== 'passed',
    ).map((comparison) => comparison.testId);
    const benignCases = cases.filter((comparison) => {
      const testCase = testCaseById.get(comparison.testId);
      const tags = [...(testCase?.tags ?? []), ...(testCase?.inheritedTags ?? [])];
      return tags.includes('benign');
    });
    const falseBlockCaseIds = benignCases.filter(
      (comparison) => statusForRole(comparison, 'candidate') !== 'passed',
    ).map((comparison) => comparison.testId);
    const hardGateItems: HardGateItem[] = [
      redlineCases.length > 0
        ? {
            key: 'false_allow',
            status: falseAllowCaseIds.length > 0 ? 'fail' : 'pass',
            count: falseAllowCaseIds.length,
            caseIds: falseAllowCaseIds,
          }
        : { key: 'false_allow', status: 'not_measured' },
      benignCases.length > 0
        ? {
            key: 'false_block',
            status: falseBlockCaseIds.length > 0 ? 'fail' : 'pass',
            count: falseBlockCaseIds.length,
            caseIds: falseBlockCaseIds,
          }
        : { key: 'false_block', status: 'not_measured' },
      { key: 'approval_bypass', status: 'not_measured' },
    ];
    const completed = allCases.length === testCases.filter((testCase) => !testCase.skip).length
      && allCases.every((comparison) => (
        comparison.statusA !== 'not_run' && comparison.statusB !== 'not_run'
      ));
    const shipGate = decideShipVerdict({
      decisivePairs: baselineWins + candidateWins,
      candidateWins,
      baselineWins,
      ties,
      excludedPairs,
      pValue,
      pairCells: { b: candidateOnlyPass, c: baselineOnlyPass, n: totalCases },
      completed,
      hardGate: { passed: hardGateItems.every((item) => item.status !== 'fail'), items: hardGateItems },
      calibre: this.calibre,
    });

    const baselineSkillActivations: Record<string, number> = {};
    const candidateSkillActivations: Record<string, number> = {};
    for (const comparison of allCases) {
      addActivations(
        baselineSkillActivations,
        comparison.assignment.A === 'baseline'
          ? comparison.skillActivationsA
          : comparison.skillActivationsB,
      );
      addActivations(
        candidateSkillActivations,
        comparison.assignment.A === 'candidate'
          ? comparison.skillActivationsA
          : comparison.skillActivationsB,
      );
    }

    // Build verdict
    const otherExcludedPairs = excludedPairs - skillNotActivatedPairs;
    const excludedNote = otherExcludedPairs > 0 ? ` （另有 ${otherExcludedPairs} 个 pair 因一侧没跑成被排除）` : '';
    const skillNote = skillNotActivatedPairs > 0
      ? ` 实验组有 ${skillNotActivatedPairs} 题 skill 未出场，不计入。`
      : '';
    let verdict: string;
    if (skillNotActivatedPairs === allCases.length && allCases.length > 0) {
      verdict = `skill 未出场，结论不说明 skill 效果。实验组 ${skillNotActivatedPairs} 题均未计入胜负统计。`;
    } else if (winner === 'tie') {
      verdict = `Tie: baseline and candidate each won ${baselineWins} cases with ${ties} ties.${excludedNote}`;
    } else {
      const winnerWins = winner === 'baseline' ? baselineWins : candidateWins;
      const loserWins = winner === 'baseline' ? candidateWins : baselineWins;
      verdict =
        `${winner} wins ${winnerWins}-${loserWins} (${ties} ties) by deterministic assertion pass rate. ` +
        `Confidence: ${(confidence * 100).toFixed(0)}%.` + excludedNote;
    }
    if (skillNotActivatedPairs > 0 && skillNotActivatedPairs !== allCases.length) verdict += skillNote;

    return {
      totalCases,
      baselineWins,
      candidateWins,
      ties,
      baselineAvgScore,
      candidateAvgScore,
      winner,
      confidence,
      verdict,
      ...(excludedPairs > 0 ? { excludedPairs } : {}),
      ...(skillNotActivatedPairs > 0 ? { skillNotActivatedPairs } : {}),
      baselineSkillActivations,
      candidateSkillActivations,
      pValue,
      shipGate,
    };
  }
}
