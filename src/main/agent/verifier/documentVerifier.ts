// ============================================================================
// Document Verifier - 文档生成任务验证器
// ============================================================================
// 检查：output_not_empty + no_placeholder_text + has_structure + reasonable_length
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('DocumentVerifier');

/**
 * Document task verifier
 *
 * Performs deterministic checks on document generation outputs:
 * 1. output_not_empty — Output length > 100 characters
 * 2. no_placeholder_text — No [TODO], [待填写], lorem ipsum, [placeholder]
 * 3. has_structure — Contains heading hierarchy or paragraph separation
 * 4. reasonable_length — Output length matches task complexity
 */
export class DocumentVerifier implements TaskVerifier {
  id = 'document-verifier';
  taskType = 'document' as const;

  canVerify(taskAnalysis: TaskAnalysis): boolean {
    return taskAnalysis.taskType === 'document';
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    // Use agent output as the document content
    const content = context.agentOutput;

    // Check 1: Output not empty
    checks.push(this.checkOutputNotEmpty(content));

    // Check 2: No placeholder text
    checks.push(this.checkNoPlaceholderText(content));

    // Check 3: Has structure
    checks.push(this.checkHasStructure(content));

    // Check 4: Reasonable length
    checks.push(this.checkReasonableLength(content, context));

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
      taskType: 'document',
      durationMs: 0,
    };
  }

  private checkOutputNotEmpty(content: string): VerificationCheck {
    const trimmed = content.trim();
    const length = trimmed.length;
    const passed = length > 100;

    return {
      name: 'output_not_empty',
      passed,
      score: passed ? 1 : length > 0 ? 0.3 : 0,
      message: passed
        ? `Document output: ${length} characters`
        : `Document output too short: ${length} characters (minimum 100)`,
      metadata: { length },
    };
  }

  private checkNoPlaceholderText(content: string): VerificationCheck {
    const placeholderPatterns = [
      /\[TODO\]/gi,
      /\[待填写\]/g,
      /\[placeholder\]/gi,
      /\[待补充\]/g,
      /\[填写.*?\]/g,
      /lorem ipsum/gi,
      /\[TBD\]/gi,
      /\[INSERT\s/gi,
      /\[YOUR\s/gi,
      /xxx+/gi,
      /\[…\]/g,
      /\[此处\]/g,
    ];

    const foundPlaceholders: string[] = [];
    for (const pattern of placeholderPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        foundPlaceholders.push(...matches.slice(0, 3));
      }
    }

    const passed = foundPlaceholders.length === 0;

    return {
      name: 'no_placeholder_text',
      passed,
      score: passed ? 1 : Math.max(0, 1 - foundPlaceholders.length * 0.2),
      message: passed
        ? 'No placeholder text detected'
        : `Found ${foundPlaceholders.length} placeholder(s): ${foundPlaceholders.slice(0, 3).join(', ')}`,
      metadata: { placeholders: foundPlaceholders },
    };
  }

  private checkHasStructure(content: string): VerificationCheck {
    // Check for various structural elements
    const hasMarkdownHeaders = /^#{1,3}\s/m.test(content);
    const hasNumberedSections = /^\d+[.、]\s/m.test(content);
    const hasLists = /^[-*]\s/m.test(content) || /^\d+\.\s/m.test(content);
    const hasParagraphs = content.split('\n\n').filter(p => p.trim().length > 20).length >= 2;
    const hasHtmlHeaders = /<h[1-6]/i.test(content);

    const structureScore =
      (hasMarkdownHeaders ? 0.3 : 0) +
      (hasNumberedSections ? 0.2 : 0) +
      (hasLists ? 0.2 : 0) +
      (hasParagraphs ? 0.2 : 0) +
      (hasHtmlHeaders ? 0.1 : 0);

    const passed = structureScore >= 0.3;

    return {
      name: 'has_structure',
      passed,
      score: Math.min(1, structureScore + 0.2), // baseline 0.2 for having any content
      message: passed
        ? `Document has structure: headers=${hasMarkdownHeaders || hasHtmlHeaders}, lists=${hasLists}, paragraphs=${hasParagraphs}`
        : 'Document lacks structure (no headers, lists, or clear paragraphs)',
      metadata: { hasMarkdownHeaders, hasNumberedSections, hasLists, hasParagraphs },
    };
  }

  private checkReasonableLength(content: string, context: VerificationContext): VerificationCheck {
    const length = content.trim().length;
    const taskLength = context.taskDescription.length;

    // Heuristic: more complex tasks should produce longer outputs
    // Simple task (< 100 chars) → minimum 200 char output
    // Medium task (100-500 chars) → minimum 500 char output
    // Complex task (> 500 chars) → minimum 1000 char output
    let expectedMinLength: number;
    if (taskLength < 100) {
      expectedMinLength = 200;
    } else if (taskLength < 500) {
      expectedMinLength = 500;
    } else {
      expectedMinLength = 1000;
    }

    const passed = length >= expectedMinLength;
    const ratio = length / expectedMinLength;

    return {
      name: 'reasonable_length',
      passed,
      score: Math.min(1, ratio),
      message: passed
        ? `Document length (${length}) meets minimum (${expectedMinLength}) for task complexity`
        : `Document too short (${length}) for task complexity (expected ≥${expectedMinLength})`,
      metadata: { length, expectedMinLength, taskLength },
    };
  }
}
