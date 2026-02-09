// ============================================================================
// Code Verifier - 代码任务验证器
// ============================================================================
// 检查：typecheck + test_pass + file_exists + diff_coherence
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('CodeVerifier');

/**
 * Code task verifier
 *
 * Performs deterministic checks on code-related task outputs:
 * 1. file_exists - All referenced files exist
 * 2. typecheck - TypeScript compilation succeeds (if tsconfig present)
 * 3. test_pass - Tests pass (if test files detected in modified files)
 * 4. diff_coherence - Output mentions files that were actually modified
 */
export class CodeVerifier implements TaskVerifier {
  id = 'code-verifier';
  taskType = 'code' as const;

  canVerify(taskAnalysis: TaskAnalysis): boolean {
    return (
      taskAnalysis.taskType === 'code' ||
      taskAnalysis.taskType === 'test' ||
      taskAnalysis.involvesFiles
    );
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    // Check 1: Non-empty output
    checks.push(this.checkNonEmptyOutput(context));

    // Check 2: Modified files exist
    checks.push(this.checkFilesExist(context));

    // Check 3: TypeScript typecheck (conditional)
    const typecheckResult = await this.checkTypecheck(context);
    if (typecheckResult) {
      checks.push(typecheckResult);
    }

    // Check 4: Tests pass (conditional)
    const testResult = await this.checkTests(context);
    if (testResult) {
      checks.push(testResult);
    }

    // Check 5: Diff coherence
    checks.push(this.checkDiffCoherence(context));

    // Check 6: No error loops in tool calls
    checks.push(this.checkNoErrorLoops(context));

    // Calculate overall score
    const passedChecks = checks.filter(c => c.passed);
    const totalWeight = checks.reduce((sum, c) => sum + c.score, 0);
    const maxWeight = checks.length;
    const score = maxWeight > 0 ? totalWeight / maxWeight : 0;
    const passed = passedChecks.length >= Math.ceil(checks.length * 0.7);

    const suggestions: string[] = [];
    for (const check of checks) {
      if (!check.passed) {
        suggestions.push(`Fix: ${check.name} — ${check.message}`);
      }
    }

    return {
      passed,
      score,
      checks,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      taskType: 'code',
      durationMs: 0, // Will be set by registry
    };
  }

  private checkNonEmptyOutput(context: VerificationContext): VerificationCheck {
    const hasOutput = !!(context.agentOutput && context.agentOutput.trim().length > 10);
    return {
      name: 'non_empty_output',
      passed: hasOutput,
      score: hasOutput ? 1 : 0,
      message: hasOutput ? 'Agent produced non-empty output' : 'Agent output is empty or too short',
    };
  }

  private checkFilesExist(context: VerificationContext): VerificationCheck {
    if (!context.modifiedFiles || context.modifiedFiles.length === 0) {
      return {
        name: 'files_exist',
        passed: true,
        score: 0.8,
        message: 'No modified files to check',
      };
    }

    const missing: string[] = [];
    for (const file of context.modifiedFiles) {
      const fullPath = path.isAbsolute(file) ? file : path.join(context.workingDirectory, file);
      if (!fs.existsSync(fullPath)) {
        missing.push(file);
      }
    }

    const allExist = missing.length === 0;
    return {
      name: 'files_exist',
      passed: allExist,
      score: allExist ? 1 : 1 - (missing.length / context.modifiedFiles.length),
      message: allExist
        ? `All ${context.modifiedFiles.length} files exist`
        : `Missing files: ${missing.join(', ')}`,
      metadata: { missing, total: context.modifiedFiles.length },
    };
  }

  private async checkTypecheck(context: VerificationContext): Promise<VerificationCheck | null> {
    const tsconfigPath = path.join(context.workingDirectory, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) {
      return null; // Skip if no TypeScript project
    }

    try {
      execSync('npx tsc --noEmit 2>&1', {
        cwd: context.workingDirectory,
        timeout: 60000,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      return {
        name: 'typecheck',
        passed: true,
        score: 1,
        message: 'TypeScript compilation succeeded',
      };
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error
        ? String((error as any).stderr || (error as any).stdout || '').slice(0, 500)
        : 'Unknown error';

      // Count error lines
      const errorCount = (stderr.match(/error TS\d+/g) || []).length;

      return {
        name: 'typecheck',
        passed: false,
        score: Math.max(0, 1 - errorCount * 0.1),
        message: `TypeScript errors: ${errorCount} error(s)`,
        metadata: { errorCount, snippet: stderr.slice(0, 200) },
      };
    }
  }

  private async checkTests(context: VerificationContext): Promise<VerificationCheck | null> {
    // Only run tests if modified files include test files
    const hasTestFiles = context.modifiedFiles?.some(
      f => f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__')
    );

    if (!hasTestFiles) {
      return null; // Skip if no test files involved
    }

    const packageJsonPath = path.join(context.workingDirectory, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    try {
      execSync('npm test -- --passWithNoTests 2>&1', {
        cwd: context.workingDirectory,
        timeout: 120000,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      return {
        name: 'test_pass',
        passed: true,
        score: 1,
        message: 'Tests passed',
      };
    } catch (error) {
      const output = error instanceof Error && 'stdout' in error
        ? String((error as any).stdout || '').slice(0, 500)
        : 'Test execution failed';

      return {
        name: 'test_pass',
        passed: false,
        score: 0.2,
        message: `Tests failed: ${output.slice(0, 100)}`,
        metadata: { snippet: output.slice(0, 200) },
      };
    }
  }

  private checkDiffCoherence(context: VerificationContext): VerificationCheck {
    if (!context.modifiedFiles || context.modifiedFiles.length === 0) {
      return {
        name: 'diff_coherence',
        passed: true,
        score: 0.8,
        message: 'No modified files to check coherence',
      };
    }

    // Check if output mentions the files that were actually modified
    const mentionedFiles = context.modifiedFiles.filter(f => {
      const basename = path.basename(f);
      return context.agentOutput.includes(basename);
    });

    const ratio = mentionedFiles.length / context.modifiedFiles.length;
    const passed = ratio >= 0.5;

    return {
      name: 'diff_coherence',
      passed,
      score: ratio,
      message: passed
        ? `Output references ${mentionedFiles.length}/${context.modifiedFiles.length} modified files`
        : `Output only mentions ${mentionedFiles.length}/${context.modifiedFiles.length} modified files`,
    };
  }

  private checkNoErrorLoops(context: VerificationContext): VerificationCheck {
    if (!context.toolCalls || context.toolCalls.length === 0) {
      return {
        name: 'no_error_loops',
        passed: true,
        score: 1,
        message: 'No tool calls to check',
      };
    }

    // Detect repeated failed tool calls with same args
    const failedCalls = new Map<string, number>();
    for (const call of context.toolCalls) {
      if (call.result && !call.result.success) {
        const key = `${call.name}:${JSON.stringify(call.args || {}).slice(0, 100)}`;
        failedCalls.set(key, (failedCalls.get(key) || 0) + 1);
      }
    }

    const maxRepeats = Math.max(0, ...failedCalls.values());
    const hasLoop = maxRepeats >= 3;

    const successRate = context.toolCalls.filter(c => c.result?.success).length / context.toolCalls.length;

    return {
      name: 'no_error_loops',
      passed: !hasLoop && successRate >= 0.5,
      score: hasLoop ? 0.2 : successRate,
      message: hasLoop
        ? `Error loop detected: same tool failed ${maxRepeats} times`
        : `Tool success rate: ${(successRate * 100).toFixed(0)}%`,
      metadata: { maxRepeats, successRate, totalCalls: context.toolCalls.length },
    };
  }
}
