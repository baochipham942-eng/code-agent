// ============================================================================
// P4 Eval Critic — Assertion Quality Analyzer
// Rule-based analysis of assertion discriminating power (zero LLM cost)
// ============================================================================

import type { TestCase, TestResult, TestExpectations, AssertionQuality } from '../types';

/** Words that are too generic to be discriminating in response_contains */
const GENERIC_WORDS = new Set([
  'ok', 'done', 'yes', 'no', 'success', 'error', 'fail', 'true', 'false',
  'complete', 'finished', 'ready', 'result',
  // Chinese equivalents
  '成功', '失败', '完成', '是', '否', '好的', '确认', '错误', '结果',
]);

export class AssertionQualityAnalyzer {
  /**
   * Analyze assertion quality for a single test case + result pair.
   * Returns one AssertionQuality entry per detected assertion pattern.
   */
  analyze(testCase: TestCase, _result: TestResult): AssertionQuality[] {
    const qualities: AssertionQuality[] = [];
    const expect = testCase.expect;

    // Rule: empty expectations
    if (this.isEmptyExpectations(expect)) {
      qualities.push({
        assertionKey: 'expect.*',
        testCaseId: testCase.id,
        quality: 'unverifiable',
        discriminatingPower: 0,
        reason: 'No assertions defined — test result cannot be verified',
        suggestion: 'Add at least one assertion (response_contains, file_exists, or test_pass)',
      });
      return qualities;
    }

    // Analyze response_contains
    if (expect.response_contains) {
      qualities.push(...this.analyzeResponseContains(testCase.id, expect.response_contains));
    }

    // Analyze file_exists without matching file_contains
    if (expect.file_exists) {
      qualities.push(...this.analyzeFileExists(testCase.id, expect));
    }

    // Analyze file_contains
    if (expect.file_contains) {
      qualities.push(...this.analyzeFileContains(testCase.id, expect.file_contains));
    }

    // Analyze max_turns
    if (expect.max_turns !== undefined) {
      qualities.push(this.analyzeMaxTurns(testCase.id, expect.max_turns));
    }

    // Analyze tools_any_of
    if (expect.tools_any_of) {
      qualities.push(this.analyzeToolsAnyOf(testCase.id, expect.tools_any_of));
    }

    // Analyze test_pass
    if (expect.test_pass) {
      qualities.push({
        assertionKey: 'expect.test_pass',
        testCaseId: testCase.id,
        quality: 'strong',
        discriminatingPower: 0.9,
        reason: 'Runs an actual command and checks exit code — high confidence',
      });
    }

    return qualities;
  }

  // ---------------------------------------------------------------------------
  // Private analysis helpers
  // ---------------------------------------------------------------------------

  private isEmptyExpectations(expect: TestExpectations): boolean {
    // Check if every field in expectations is undefined/null/empty
    const hasResponseContains = (expect.response_contains?.length ?? 0) > 0;
    const hasResponseNotContains = (expect.response_not_contains?.length ?? 0) > 0;
    const hasFileExists = (expect.file_exists?.length ?? 0) > 0;
    const hasFilesCreated = (expect.files_created?.length ?? 0) > 0;
    const hasFilesModified = (expect.files_modified?.length ?? 0) > 0;
    const hasFileContains = expect.file_contains && Object.keys(expect.file_contains).length > 0;
    const hasFileNotContains = expect.file_not_contains && Object.keys(expect.file_not_contains).length > 0;
    const hasFilesNotExist = (expect.files_not_exist?.length ?? 0) > 0;
    const hasToolsAnyOf = (expect.tools_any_of?.length ?? 0) > 0;
    const hasTestPass = !!expect.test_pass;
    const hasMaxTurns = expect.max_turns !== undefined;
    const hasMinToolCalls = expect.min_tool_calls !== undefined;
    const hasMaxToolCalls = expect.max_tool_calls !== undefined;
    const hasTool = !!expect.tool;
    const hasOutputContains = (expect.output_contains?.length ?? 0) > 0;
    const hasErrorHandling = expect.error_handled !== undefined || expect.no_crash !== undefined;

    return !(
      hasResponseContains || hasResponseNotContains ||
      hasFileExists || hasFilesCreated || hasFilesModified ||
      hasFileContains || hasFileNotContains || hasFilesNotExist ||
      hasToolsAnyOf || hasTestPass ||
      hasMaxTurns || hasMinToolCalls || hasMaxToolCalls ||
      hasTool || hasOutputContains || hasErrorHandling
    );
  }

  private analyzeResponseContains(testCaseId: string, patterns: string[]): AssertionQuality[] {
    return patterns.map((pattern) => {
      const words = pattern.trim().split(/\s+/);
      const wordCount = words.length;

      // Single-word match
      if (wordCount === 1) {
        const isGeneric = GENERIC_WORDS.has(pattern.toLowerCase());
        return {
          assertionKey: `expect.response_contains["${pattern}"]`,
          testCaseId,
          quality: 'weak' as const,
          discriminatingPower: isGeneric ? 0.05 : 0.2,
          reason: isGeneric
            ? `Generic word "${pattern}" matches too broadly — non-discriminating`
            : `Single-word match "${pattern}" is too broad — could match by accident`,
          suggestion: 'Use a more specific multi-word phrase that uniquely identifies correct output',
        };
      }

      // Two words — borderline
      if (wordCount === 2) {
        const anyGeneric = words.some((w) => GENERIC_WORDS.has(w.toLowerCase()));
        return {
          assertionKey: `expect.response_contains["${pattern}"]`,
          testCaseId,
          quality: (anyGeneric ? 'weak' : 'adequate') as 'weak' | 'adequate',
          discriminatingPower: anyGeneric ? 0.25 : 0.5,
          reason: anyGeneric
            ? `Two-word pattern includes generic word — still fairly broad`
            : `Two-word pattern has moderate discriminating power`,
          suggestion: anyGeneric ? 'Replace generic word with a domain-specific term' : undefined,
        };
      }

      // 3+ specific words — strong
      return {
        assertionKey: `expect.response_contains["${pattern}"]`,
        testCaseId,
        quality: 'strong' as const,
        discriminatingPower: Math.min(0.6 + wordCount * 0.05, 0.95),
        reason: `Multi-word pattern (${wordCount} words) has good discriminating power`,
      };
    });
  }

  private analyzeFileExists(testCaseId: string, expect: TestExpectations): AssertionQuality[] {
    const fileContainsPaths = expect.file_contains ? new Set(Object.keys(expect.file_contains)) : new Set<string>();

    return (expect.file_exists ?? []).map((filePath) => {
      const hasContentCheck = fileContainsPaths.has(filePath);
      if (hasContentCheck) {
        return {
          assertionKey: `expect.file_exists["${filePath}"]`,
          testCaseId,
          quality: 'strong' as const,
          discriminatingPower: 0.8,
          reason: 'File existence paired with content assertion — strong verification',
        };
      }
      return {
        assertionKey: `expect.file_exists["${filePath}"]`,
        testCaseId,
        quality: 'adequate' as const,
        discriminatingPower: 0.4,
        reason: 'Checks file existence but not content — agent may create empty or wrong file',
        suggestion: `Add file_contains for "${filePath}" to verify correct content`,
      };
    });
  }

  private analyzeFileContains(
    testCaseId: string,
    fileContains: Record<string, string | string[]>,
  ): AssertionQuality[] {
    return Object.entries(fileContains).map(([filePath, content]) => {
      const patterns = Array.isArray(content) ? content : [content];
      const hasMultiLine = patterns.some((p) => p.includes('\n'));
      const totalLength = patterns.reduce((sum, p) => sum + p.length, 0);

      if (hasMultiLine) {
        return {
          assertionKey: `expect.file_contains["${filePath}"]`,
          testCaseId,
          quality: 'strong' as const,
          discriminatingPower: 0.9,
          reason: 'Multi-line content assertion — precise content verification',
        };
      }

      if (totalLength > 20) {
        return {
          assertionKey: `expect.file_contains["${filePath}"]`,
          testCaseId,
          quality: 'strong' as const,
          discriminatingPower: 0.8,
          reason: 'Substantial content check with good specificity',
        };
      }

      return {
        assertionKey: `expect.file_contains["${filePath}"]`,
        testCaseId,
        quality: 'adequate' as const,
        discriminatingPower: 0.5,
        reason: 'Short content snippet — moderately discriminating',
        suggestion: 'Consider adding multi-line content or additional content checks',
      };
    });
  }

  private analyzeMaxTurns(testCaseId: string, maxTurns: number): AssertionQuality {
    if (maxTurns > 20) {
      return {
        assertionKey: 'expect.max_turns',
        testCaseId,
        quality: 'weak',
        discriminatingPower: 0.1,
        reason: `max_turns=${maxTurns} is too permissive — agent could spin in loops and still "pass"`,
        suggestion: 'Lower max_turns to a realistic upper bound for this task',
      };
    }

    if (maxTurns > 10) {
      return {
        assertionKey: 'expect.max_turns',
        testCaseId,
        quality: 'adequate',
        discriminatingPower: 0.3,
        reason: `max_turns=${maxTurns} is somewhat permissive`,
      };
    }

    return {
      assertionKey: 'expect.max_turns',
      testCaseId,
      quality: 'strong',
      discriminatingPower: 0.6,
      reason: `max_turns=${maxTurns} is a tight constraint — good guardrail`,
    };
  }

  private analyzeToolsAnyOf(testCaseId: string, tools: string[]): AssertionQuality {
    if (tools.length > 5) {
      return {
        assertionKey: 'expect.tools_any_of',
        testCaseId,
        quality: 'weak',
        discriminatingPower: Math.max(0.1, 0.6 - tools.length * 0.08),
        reason: `tools_any_of has ${tools.length} entries — too permissive, almost any tool would match`,
        suggestion: 'Narrow to 2-3 tools that are actually correct for this task',
      };
    }

    if (tools.length > 3) {
      return {
        assertionKey: 'expect.tools_any_of',
        testCaseId,
        quality: 'adequate',
        discriminatingPower: 0.4,
        reason: `tools_any_of has ${tools.length} entries — moderately constrained`,
      };
    }

    return {
      assertionKey: 'expect.tools_any_of',
      testCaseId,
      quality: 'strong',
      discriminatingPower: 0.7,
      reason: `tools_any_of has ${tools.length} entries — well-constrained`,
    };
  }
}
