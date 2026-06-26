// A/B Comparator - Run blind comparisons between baseline and candidate configurations
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  TestCase,
  TestResult,
  CompareConfiguration,
  CaseComparison,
  ComparisonResult,
} from '../types';
import { ABGrader } from './abGrader';

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

  private computeSummary(cases: CaseComparison[]): ComparisonResult['summary'] {
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
    let verdict: string;
    if (winner === 'tie') {
      verdict = `Tie: baseline and candidate each won ${baselineWins} cases with ${ties} ties.`;
    } else {
      const winnerWins = winner === 'baseline' ? baselineWins : candidateWins;
      const loserWins = winner === 'baseline' ? candidateWins : baselineWins;
      verdict =
        `${winner} wins ${winnerWins}-${loserWins} (${ties} ties). ` +
        `Avg scores: baseline=${baselineAvgScore.toFixed(2)}, candidate=${candidateAvgScore.toFixed(2)}. ` +
        `Confidence: ${(confidence * 100).toFixed(0)}%.`;
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
    };
  }
}
