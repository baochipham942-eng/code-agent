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

/**
 * WP1-3b：判定一侧是否「没跑成」——infra_excluded（429/超时/5xx/网络）
 * 或零产出带错误（如 key 失效 401）。这类 run 没有能力数据，评它的分
 * 会把「无数据」冒充成「势均力敌」（MiMo 401 冒烟实锤：双侧空输出被
 * heuristic 评成 2.0:2.0 平局）。能力性失败（有产出但做错）不算。
 */
function invalidRunReason(result: TestResult): string | null {
  if (result.status === 'infra_excluded') {
    return `infra_excluded（${result.failureReason ?? 'infra error'}）`;
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
    const runId = uuidv4();
    const startTime = Date.now();
    const cases: CaseComparison[] = [];

    for (const testCase of testCases) {
      if (testCase.skip) continue;

      const comparison = await this.runSingleComparison(testCase, runSingleTest, llmCall);
      cases.push(comparison);
    }

    const duration = Date.now() - startTime;
    const summary = this.computeSummary(cases);

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
        assignment,
        scoreA: ZERO_RUBRIC,
        scoreB: ZERO_RUBRIC,
        winner: 'tie',
        realWinner: 'tie',
        reasoning: `pair 排除（未计入胜负）：${reasons}`,
        durationA,
        durationB,
        excludedReason: reasons,
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

    // Step 4: Unblind - determine real winner
    let realWinner: 'baseline' | 'candidate' | 'tie';
    if (gradeResult.winner === 'tie') {
      realWinner = 'tie';
    } else if (gradeResult.winner === 'A') {
      realWinner = assignment.A;
    } else {
      realWinner = assignment.B;
    }

    return {
      testId: testCase.id,
      description: testCase.description,
      assignment,
      scoreA: gradeResult.scoreA,
      scoreB: gradeResult.scoreB,
      winner: gradeResult.winner,
      realWinner,
      reasoning: gradeResult.reasoning,
      durationA,
      durationB,
    };
  }

  private computeSummary(allCases: CaseComparison[]): ComparisonResult['summary'] {
    // WP1-3b：排除的 pair 不进胜负/均分统计
    const excludedPairs = allCases.filter((c) => c.excludedReason).length;
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

    // Build verdict
    const excludedNote = excludedPairs > 0 ? ` （另有 ${excludedPairs} 个 pair 因一侧没跑成被排除）` : '';
    let verdict: string;
    if (winner === 'tie') {
      verdict = `Tie: baseline and candidate each won ${baselineWins} cases with ${ties} ties.${excludedNote}`;
    } else {
      const winnerWins = winner === 'baseline' ? baselineWins : candidateWins;
      const loserWins = winner === 'baseline' ? candidateWins : baselineWins;
      verdict =
        `${winner} wins ${winnerWins}-${loserWins} (${ties} ties). ` +
        `Avg scores: baseline=${baselineAvgScore.toFixed(2)}, candidate=${candidateAvgScore.toFixed(2)}. ` +
        `Confidence: ${(confidence * 100).toFixed(0)}%.` + excludedNote;
    }

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
    };
  }
}
