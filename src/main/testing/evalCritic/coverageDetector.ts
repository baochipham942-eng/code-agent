// ============================================================================
// P4 Eval Critic — Coverage Gap Detector
// Identifies missing test coverage based on agent behavior vs assertions
// ============================================================================

import type { TestCase, TestResult, CoverageGap } from '../types';

export class CoverageGapDetector {
  /**
   * Detect gaps in test coverage by analyzing what the agent actually did
   * versus what the test assertions check for.
   */
  detect(testCases: TestCase[], results: TestResult[]): CoverageGap[] {
    const gaps: CoverageGap[] = [];
    const resultMap = new Map(results.map((r) => [r.testId, r]));

    // Per-case analysis
    for (const tc of testCases) {
      const result = resultMap.get(tc.id);
      if (!result || result.status === 'skipped') continue;

      gaps.push(...this.detectUntestedTools(tc, result));
      gaps.push(...this.detectMissingFileAssertions(tc, result));
      gaps.push(...this.detectMissingOutputCheck(tc, result));
    }

    // Suite-level analysis
    gaps.push(...this.detectMissingNegativeTests(testCases));
    gaps.push(...this.detectMissingEdgeCases(testCases));

    return gaps;
  }

  // ---------------------------------------------------------------------------
  // Per-case detectors
  // ---------------------------------------------------------------------------

  /**
   * untested_tool: Agent used tools frequently but no assertion checks for them.
   * Look at toolExecutions and compare against expect.tool / expect.tools_any_of.
   */
  private detectUntestedTools(tc: TestCase, result: TestResult): CoverageGap[] {
    const gaps: CoverageGap[] = [];
    const expect = tc.expect;

    // Collect tools that are asserted
    const assertedTools = new Set<string>();
    if (expect.tool) assertedTools.add(expect.tool);
    if (expect.tools_any_of) {
      for (const t of expect.tools_any_of) assertedTools.add(t);
    }

    // Count tool usage in actual execution
    const toolUsage = new Map<string, number>();
    for (const exec of result.toolExecutions) {
      toolUsage.set(exec.tool, (toolUsage.get(exec.tool) ?? 0) + 1);
    }

    // Flag tools used 2+ times without any assertion
    for (const [tool, count] of toolUsage) {
      if (count >= 2 && !this.matchesAnyPattern(tool, assertedTools)) {
        gaps.push({
          testCaseId: tc.id,
          category: 'untested_tool',
          description: `Agent called "${tool}" ${count} times but no assertion verifies it`,
          priority: count >= 4 ? 'high' : 'medium',
        });
      }
    }

    return gaps;
  }

  /**
   * missing_file_assertion: Agent created/modified files but no file_exists / file_contains.
   */
  private detectMissingFileAssertions(tc: TestCase, result: TestResult): CoverageGap[] {
    const gaps: CoverageGap[] = [];
    const expect = tc.expect;

    // Collect files that are asserted
    const assertedFiles = new Set<string>();
    if (expect.file_exists) expect.file_exists.forEach((f) => assertedFiles.add(f));
    if (expect.files_created) expect.files_created.forEach((f) => assertedFiles.add(f));
    if (expect.files_modified) expect.files_modified.forEach((f) => assertedFiles.add(f));
    if (expect.file_contains) Object.keys(expect.file_contains).forEach((f) => assertedFiles.add(f));

    // Look for file-writing tool calls without corresponding assertions
    const fileWriteTools = ['write_file', 'create_file', 'edit_file', 'Write', 'Edit'];
    const writtenFiles = new Set<string>();

    for (const exec of result.toolExecutions) {
      if (fileWriteTools.some((t) => exec.tool.includes(t))) {
        // Try to extract file path from input
        const filePath = this.extractFilePath(exec.input);
        if (filePath) writtenFiles.add(filePath);
      }
    }

    for (const file of writtenFiles) {
      if (!this.fileMatchesAny(file, assertedFiles)) {
        gaps.push({
          testCaseId: tc.id,
          category: 'missing_file_assertion',
          description: `Agent wrote to "${file}" but no file_exists/file_contains assertion checks it`,
          priority: 'high',
        });
      }
    }

    return gaps;
  }

  /**
   * missing_output_check: Agent responded but no response_contains assertion.
   */
  private detectMissingOutputCheck(tc: TestCase, result: TestResult): CoverageGap[] {
    const expect = tc.expect;
    const hasResponseCheck =
      (expect.response_contains?.length ?? 0) > 0 ||
      (expect.response_not_contains?.length ?? 0) > 0;

    if (!hasResponseCheck && result.responses.length > 0) {
      // Only flag if there are no other strong assertions either
      const hasStrongAlternative = !!expect.test_pass || !!expect.file_contains;
      if (!hasStrongAlternative) {
        return [{
          testCaseId: tc.id,
          category: 'missing_output_check',
          description: 'Agent produced responses but no response_contains or test_pass assertion verifies the output',
          priority: 'medium',
        }];
      }
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Suite-level detectors
  // ---------------------------------------------------------------------------

  /**
   * missing_negative_test: No test cases with error_handling type.
   */
  private detectMissingNegativeTests(testCases: TestCase[]): CoverageGap[] {
    const hasErrorHandlingTest = testCases.some((tc) => tc.type === 'error_handling');
    if (!hasErrorHandlingTest && testCases.length > 0) {
      return [{
        testCaseId: '*',
        category: 'missing_negative_test',
        description: 'No test cases with type "error_handling" — agent error recovery is untested',
        priority: 'high',
      }];
    }
    return [];
  }

  /**
   * missing_edge_case: Only 1 test per category.
   */
  private detectMissingEdgeCases(testCases: TestCase[]): CoverageGap[] {
    const gaps: CoverageGap[] = [];

    // Group by category
    const byCategory = new Map<string, TestCase[]>();
    for (const tc of testCases) {
      const cat = tc.category ?? tc.type;
      const list = byCategory.get(cat) ?? [];
      list.push(tc);
      byCategory.set(cat, list);
    }

    for (const [category, cases] of byCategory) {
      if (cases.length === 1) {
        gaps.push({
          testCaseId: cases[0].id,
          category: 'missing_edge_case',
          description: `Category "${category}" has only 1 test case — consider adding edge cases`,
          priority: 'low',
        });
      }
    }

    return gaps;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Check if a tool name matches any pattern (exact or regex) */
  private matchesAnyPattern(toolName: string, patterns: Set<string>): boolean {
    for (const pattern of patterns) {
      if (pattern === toolName) return true;
      try {
        if (new RegExp(pattern).test(toolName)) return true;
      } catch {
        // Not a valid regex, skip
      }
    }
    return false;
  }

  /** Check if a file path matches any asserted file (by suffix) */
  private fileMatchesAny(filePath: string, assertedFiles: Set<string>): boolean {
    for (const asserted of assertedFiles) {
      if (filePath === asserted) return true;
      if (filePath.endsWith(asserted) || asserted.endsWith(filePath)) return true;
    }
    return false;
  }

  /** Try to extract a file path from tool input */
  private extractFilePath(input: Record<string, unknown>): string | null {
    // Common parameter names for file paths
    for (const key of ['file_path', 'filePath', 'path', 'filename', 'file']) {
      const val = input[key];
      if (typeof val === 'string' && val.length > 0) return val;
    }
    return null;
  }
}
