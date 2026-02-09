// ============================================================================
// Generic Verifier - 通用任务验证器（兜底）
// ============================================================================
// 检查：non_empty_output + tool_success_rate + no_error_loops
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('GenericVerifier');

export class GenericVerifier implements TaskVerifier {
  id = 'generic-verifier';
  taskType = 'generic' as const;

  canVerify(_taskAnalysis: TaskAnalysis): boolean {
    return true; // Generic verifier can always verify
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    // Check 1: Non-empty output
    checks.push(this.checkNonEmptyOutput(context));

    // Check 2: Tool success rate
    checks.push(this.checkToolSuccessRate(context));

    // Check 3: No error loops
    checks.push(this.checkNoErrorLoops(context));

    const totalScore = checks.reduce((sum, c) => sum + c.score, 0);
    const score = checks.length > 0 ? totalScore / checks.length : 0;
    const passed = score >= 0.5;

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
      taskType: 'generic',
      durationMs: 0,
    };
  }

  private checkNonEmptyOutput(context: VerificationContext): VerificationCheck {
    const hasOutput = !!(context.agentOutput && context.agentOutput.trim().length > 20);
    return {
      name: 'non_empty_output',
      passed: hasOutput,
      score: hasOutput ? 1 : 0,
      message: hasOutput
        ? `Output length: ${context.agentOutput.trim().length} chars`
        : 'Output is empty or too short',
    };
  }

  private checkToolSuccessRate(context: VerificationContext): VerificationCheck {
    if (!context.toolCalls || context.toolCalls.length === 0) {
      return {
        name: 'tool_success_rate',
        passed: true,
        score: 0.7,
        message: 'No tool calls to check',
      };
    }

    const total = context.toolCalls.length;
    const successful = context.toolCalls.filter(c => c.result?.success).length;
    const rate = successful / total;
    const passed = rate >= 0.5;

    return {
      name: 'tool_success_rate',
      passed,
      score: rate,
      message: `Tool success rate: ${successful}/${total} (${(rate * 100).toFixed(0)}%)`,
      metadata: { total, successful, rate },
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

    // Detect consecutive failures with same tool
    let maxConsecutive = 0;
    let currentConsecutive = 0;
    let lastFailedTool = '';

    for (const call of context.toolCalls) {
      if (call.result && !call.result.success) {
        if (call.name === lastFailedTool) {
          currentConsecutive++;
          maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
        } else {
          currentConsecutive = 1;
          lastFailedTool = call.name;
        }
      } else {
        currentConsecutive = 0;
        lastFailedTool = '';
      }
    }

    const hasLoop = maxConsecutive >= 3;

    return {
      name: 'no_error_loops',
      passed: !hasLoop,
      score: hasLoop ? 0.1 : 1,
      message: hasLoop
        ? `Error loop detected: ${maxConsecutive} consecutive failures`
        : 'No error loops detected',
      metadata: { maxConsecutiveFailures: maxConsecutive },
    };
  }
}
