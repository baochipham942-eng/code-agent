// ============================================================================
// P4 Eval Critic — Self-Evolution Module
// Orchestrates assertion analysis + coverage detection → EvalFeedback
// ============================================================================

export { AssertionQualityAnalyzer } from './assertionAnalyzer';
export { CoverageGapDetector } from './coverageDetector';
export { EvalHistoryTracker } from './historyTracker';

import type {
  TestCase,
  TestResult,
  TestRunSummary,
  EvalFeedback,
  EvalSuggestion,
  AssertionQuality,
  CoverageGap,
} from '../types';
import { AssertionQualityAnalyzer } from './assertionAnalyzer';
import { CoverageGapDetector } from './coverageDetector';

export class EvalCritic {
  private readonly assertionAnalyzer: AssertionQualityAnalyzer;
  private readonly coverageDetector: CoverageGapDetector;

  constructor(_options?: { enableLLM?: boolean }) {
    // LLM integration is Phase 7 — currently pure rule-based
    this.assertionAnalyzer = new AssertionQualityAnalyzer();
    this.coverageDetector = new CoverageGapDetector();
  }

  /**
   * Run a full critique of a test run.
   * Orchestrates: AssertionQualityAnalyzer → CoverageGapDetector → EvalFeedback
   */
  async critique(
    summary: TestRunSummary,
    testCases: TestCase[],
  ): Promise<EvalFeedback> {
    const resultMap = new Map(summary.results.map((r) => [r.testId, r]));

    // 1. Analyze assertion quality per test case
    const assertionQualities: AssertionQuality[] = [];
    for (const tc of testCases) {
      const result = resultMap.get(tc.id);
      if (!result || result.status === 'skipped') continue;
      assertionQualities.push(...this.assertionAnalyzer.analyze(tc, result));
    }

    // 2. Detect coverage gaps across suite
    const coverageGaps = this.coverageDetector.detect(testCases, summary.results);

    // 3. Generate improvement suggestions
    const suggestions = this.generateSuggestions(assertionQualities, coverageGaps);

    // 4. Compute overall quality score
    const overallQualityScore = this.computeQualityScore(assertionQualities, coverageGaps);

    // 5. Compute stats
    const stats = this.computeStats(assertionQualities, coverageGaps);

    return {
      runId: summary.runId,
      timestamp: Date.now(),
      testSuiteVersion: summary.environment?.generation ?? 'unknown',
      overallQualityScore,
      assertionQualities,
      coverageGaps,
      suggestions,
      stats,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private generateSuggestions(
    qualities: AssertionQuality[],
    gaps: CoverageGap[],
  ): EvalSuggestion[] {
    const suggestions: EvalSuggestion[] = [];

    // Suggestions from weak/unverifiable assertions
    for (const q of qualities) {
      if (q.quality === 'unverifiable') {
        suggestions.push({
          type: 'add_assertion',
          targetTestId: q.testCaseId,
          description: q.suggestion ?? `Add assertions for test "${q.testCaseId}" — currently unverifiable`,
          priority: 'high',
        });
      } else if (q.quality === 'weak' && q.suggestion) {
        suggestions.push({
          type: 'strengthen_assertion',
          targetTestId: q.testCaseId,
          description: q.suggestion,
          priority: 'medium',
        });
      }
    }

    // Suggestions from coverage gaps
    for (const gap of gaps) {
      switch (gap.category) {
        case 'missing_negative_test':
          suggestions.push({
            type: 'add_negative_test',
            targetTestId: gap.testCaseId,
            description: gap.description,
            priority: gap.priority,
          });
          break;
        case 'missing_edge_case':
          suggestions.push({
            type: 'add_test_case',
            targetTestId: gap.testCaseId,
            description: gap.description,
            priority: gap.priority,
          });
          break;
        case 'missing_file_assertion':
        case 'missing_output_check':
          suggestions.push({
            type: 'add_assertion',
            targetTestId: gap.testCaseId,
            description: gap.description,
            priority: gap.priority,
          });
          break;
        case 'untested_tool':
          suggestions.push({
            type: 'add_assertion',
            targetTestId: gap.testCaseId,
            description: gap.description,
            priority: gap.priority,
          });
          break;
        default:
          suggestions.push({
            type: 'add_test_case',
            targetTestId: gap.testCaseId,
            description: gap.description,
            priority: gap.priority,
          });
      }
    }

    // Deduplicate by targetTestId + type (keep highest priority)
    const priorityRank = { high: 0, medium: 1, low: 2 };
    const seen = new Map<string, EvalSuggestion>();
    for (const s of suggestions) {
      const key = `${s.targetTestId}::${s.type}`;
      const existing = seen.get(key);
      if (!existing || priorityRank[s.priority] < priorityRank[existing.priority]) {
        seen.set(key, s);
      }
    }

    return [...seen.values()].sort(
      (a, b) => priorityRank[a.priority] - priorityRank[b.priority],
    );
  }

  private computeQualityScore(
    qualities: AssertionQuality[],
    gaps: CoverageGap[],
  ): number {
    if (qualities.length === 0) return 0;

    // Weighted average of discriminating power
    const avgDiscrimination =
      qualities.reduce((sum, q) => sum + q.discriminatingPower, 0) / qualities.length;

    // Coverage penalty: each high-priority gap deducts 0.05, medium 0.03, low 0.01
    const gapPenalty = gaps.reduce((penalty, g) => {
      switch (g.priority) {
        case 'high': return penalty + 0.05;
        case 'medium': return penalty + 0.03;
        case 'low': return penalty + 0.01;
      }
    }, 0);

    // Weak/unverifiable ratio penalty
    const weakCount = qualities.filter((q) => q.quality === 'weak' || q.quality === 'unverifiable').length;
    const weakRatio = weakCount / qualities.length;
    const weakPenalty = weakRatio * 0.2;

    return Math.max(0, Math.min(1, avgDiscrimination - gapPenalty - weakPenalty));
  }

  private computeStats(
    qualities: AssertionQuality[],
    gaps: CoverageGap[],
  ): EvalFeedback['stats'] {
    return {
      totalAssertions: qualities.length,
      strongAssertions: qualities.filter((q) => q.quality === 'strong').length,
      weakAssertions: qualities.filter((q) => q.quality === 'weak').length,
      unverifiableAssertions: qualities.filter((q) => q.quality === 'unverifiable').length,
      coverageGapCount: gaps.length,
    };
  }
}
