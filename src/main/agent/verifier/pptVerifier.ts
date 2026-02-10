// ============================================================================
// PPT Verifier - PPT 生成任务验证器
// ============================================================================
// 检查：file_created + slide_count_match + content_populated + theme_applied
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('PPTVerifier');

export class PPTVerifier implements TaskVerifier {
  id = 'ppt-verifier';
  taskType = 'ppt' as const;

  canVerify(taskAnalysis: TaskAnalysis): boolean {
    return taskAnalysis.taskType === 'ppt';
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    // Check 1: PPT file was created
    checks.push(this.checkFileCreated(context));

    // Check 2: Slide count matches expectation
    checks.push(this.checkSlideCount(context));

    // Check 3: Content was populated (output describes slides)
    checks.push(this.checkContentPopulated(context));

    // Check 4: Theme was applied
    checks.push(this.checkThemeApplied(context));

    // Calculate overall score
    const totalScore = checks.reduce((sum, c) => sum + c.score, 0);
    const score = checks.length > 0 ? totalScore / checks.length : 0;
    const passed = checks.every(c => c.passed) || score >= 0.7;

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
      taskType: 'ppt',
      durationMs: 0,
    };
  }

  private checkFileCreated(context: VerificationContext): VerificationCheck {
    // Look for .pptx file in tool call results or modified files
    const pptxFile = this.findPptxFile(context);

    if (pptxFile && fs.existsSync(pptxFile)) {
      const stats = fs.statSync(pptxFile);
      const isReasonableSize = stats.size > 10000; // > 10KB

      return {
        name: 'file_created',
        passed: isReasonableSize,
        score: isReasonableSize ? 1 : 0.5,
        message: isReasonableSize
          ? `PPT file created: ${path.basename(pptxFile)} (${(stats.size / 1024).toFixed(1)} KB)`
          : `PPT file too small: ${stats.size} bytes`,
        metadata: { path: pptxFile, size: stats.size },
      };
    }

    return {
      name: 'file_created',
      passed: false,
      score: 0,
      message: 'No .pptx file found',
    };
  }

  private checkSlideCount(context: VerificationContext): VerificationCheck {
    // Extract expected slide count from task description
    const countMatch = context.taskDescription.match(/(\d+)\s*(页|张|slide)/i);
    const expectedCount = countMatch ? parseInt(countMatch[1]) : undefined;

    // Extract actual slide count from output
    const actualMatch = context.agentOutput.match(/幻灯片:\s*(\d+)\s*页/);
    const actualCount = actualMatch ? parseInt(actualMatch[1]) : undefined;

    if (!expectedCount || !actualCount) {
      return {
        name: 'slide_count_match',
        passed: true,
        score: 0.7,
        message: 'Could not verify slide count',
        metadata: { expected: expectedCount, actual: actualCount },
      };
    }

    const tolerance = Math.max(1, Math.floor(expectedCount * 0.2));
    const match = Math.abs(actualCount - expectedCount) <= tolerance;

    return {
      name: 'slide_count_match',
      passed: match,
      score: match ? 1 : 0.3,
      message: match
        ? `Slide count matches: ${actualCount} (expected ~${expectedCount})`
        : `Slide count mismatch: got ${actualCount}, expected ~${expectedCount}`,
      metadata: { expected: expectedCount, actual: actualCount, tolerance },
    };
  }

  private checkContentPopulated(context: VerificationContext): VerificationCheck {
    // Check that the output indicates content was populated
    const indicators = [
      /PPT 已生成/,
      /幻灯片.*页/,
      /主题.*:/,
      /presentation.*\.pptx/i,
    ];

    const matchCount = indicators.filter(re => re.test(context.agentOutput)).length;
    const score = matchCount / indicators.length;
    const passed = score >= 0.5;

    return {
      name: 'content_populated',
      passed,
      score,
      message: passed
        ? `Content populated (${matchCount}/${indicators.length} indicators)`
        : `Content may be incomplete (${matchCount}/${indicators.length} indicators)`,
    };
  }

  private checkThemeApplied(context: VerificationContext): VerificationCheck {
    const themeNames = [
      'neon-green', 'neon-blue', 'neon-purple', 'neon-orange',
      'glass-light', 'glass-dark', 'minimal-mono', 'corporate', 'apple-dark',
    ];

    const themeApplied = themeNames.some(t => context.agentOutput.includes(t));

    return {
      name: 'theme_applied',
      passed: themeApplied,
      score: themeApplied ? 1 : 0.5,
      message: themeApplied ? 'Theme applied' : 'Could not verify theme application',
    };
  }

  private findPptxFile(context: VerificationContext): string | null {
    // Check tool call results for file path
    if (context.toolCalls) {
      for (const call of context.toolCalls) {
        if (call.name === 'ppt_generate' && call.result?.success) {
          const output = call.result.output || '';
          const pathMatch = output.match(/文件:\s*(.+\.pptx)/);
          if (pathMatch) return pathMatch[1].trim();
        }
      }
    }

    // Check modified files
    if (context.modifiedFiles) {
      const pptxFile = context.modifiedFiles.find(f => f.endsWith('.pptx'));
      if (pptxFile) return pptxFile;
    }

    // Check output for file path
    const outputMatch = context.agentOutput.match(/([^\s]+\.pptx)/);
    if (outputMatch) {
      const candidate = outputMatch[1];
      if (path.isAbsolute(candidate)) return candidate;
      return path.join(context.workingDirectory, candidate);
    }

    return null;
  }
}
