// ============================================================================
// Search Verifier - 搜索/研究任务验证器
// ============================================================================
// 检查：sources_cited + factual_overlap + answer_completeness
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('SearchVerifier');

export class SearchVerifier implements TaskVerifier {
  id = 'search-verifier';
  taskType = 'search' as const;

  canVerify(taskAnalysis: TaskAnalysis): boolean {
    return (
      taskAnalysis.taskType === 'search' ||
      taskAnalysis.involvesNetwork
    );
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    // Check 1: Sources cited
    checks.push(this.checkSourcesCited(context));

    // Check 2: Answer completeness
    checks.push(this.checkAnswerCompleteness(context));

    // Check 3: Tool usage (web_search / web_fetch were used)
    checks.push(this.checkToolUsage(context));

    // Check 4: Non-empty structured output
    checks.push(this.checkStructuredOutput(context));

    const totalScore = checks.reduce((sum, c) => sum + c.score, 0);
    const score = checks.length > 0 ? totalScore / checks.length : 0;
    const passed = score >= 0.6;

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
      taskType: 'search',
      durationMs: 0,
    };
  }

  private checkSourcesCited(context: VerificationContext): VerificationCheck {
    const output = context.agentOutput;

    // Look for URL patterns, citations, or reference markers
    const urlPattern = /https?:\/\/[^\s)}\]]+/g;
    const urls = output.match(urlPattern) || [];

    // Look for citation patterns like [1], [source], etc.
    const citationPattern = /\[\d+\]|\[来源\]|\[source\]|参考|References?|Sources?:/gi;
    const citations = output.match(citationPattern) || [];

    const totalSources = urls.length + citations.length;
    const hasSources = totalSources > 0;

    return {
      name: 'sources_cited',
      passed: hasSources,
      score: hasSources ? Math.min(1, totalSources / 3) : 0,
      message: hasSources
        ? `Found ${totalSources} source references (${urls.length} URLs, ${citations.length} citations)`
        : 'No source references found',
      metadata: { urlCount: urls.length, citationCount: citations.length },
    };
  }

  private checkAnswerCompleteness(context: VerificationContext): VerificationCheck {
    const output = context.agentOutput;
    const question = context.taskDescription;

    // Basic length check
    if (output.length < 100) {
      return {
        name: 'answer_completeness',
        passed: false,
        score: 0.2,
        message: 'Output too short for a search result',
      };
    }

    // Check if output contains key terms from the question
    const questionWords = question
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3);

    const matchedWords = questionWords.filter(w =>
      output.toLowerCase().includes(w)
    );

    const coverage = questionWords.length > 0
      ? matchedWords.length / questionWords.length
      : 0.5;

    const passed = coverage >= 0.3 && output.length >= 200;

    return {
      name: 'answer_completeness',
      passed,
      score: Math.min(1, coverage + (output.length > 500 ? 0.3 : 0)),
      message: passed
        ? `Answer covers ${(coverage * 100).toFixed(0)}% of query terms`
        : `Answer may be incomplete (${(coverage * 100).toFixed(0)}% term coverage)`,
    };
  }

  private checkToolUsage(context: VerificationContext): VerificationCheck {
    if (!context.toolCalls || context.toolCalls.length === 0) {
      return {
        name: 'tool_usage',
        passed: false,
        score: 0,
        message: 'No tools were used for search',
      };
    }

    const searchTools = ['web_search', 'web_fetch', 'memory_search', 'grep', 'glob'];
    const usedSearchTools = context.toolCalls.filter(c =>
      searchTools.includes(c.name)
    );

    const successfulSearches = usedSearchTools.filter(c => c.result?.success);

    return {
      name: 'tool_usage',
      passed: successfulSearches.length > 0,
      score: successfulSearches.length > 0
        ? Math.min(1, successfulSearches.length / 2)
        : 0,
      message: successfulSearches.length > 0
        ? `${successfulSearches.length} successful search tool calls`
        : 'No successful search tool calls',
      metadata: {
        total: usedSearchTools.length,
        successful: successfulSearches.length,
      },
    };
  }

  private checkStructuredOutput(context: VerificationContext): VerificationCheck {
    const output = context.agentOutput;

    // Check for structured elements: headers, lists, sections
    const hasHeaders = /^#{1,3}\s/m.test(output);
    const hasLists = /^[-*]\s/m.test(output) || /^\d+\.\s/m.test(output);
    const hasSections = output.split('\n\n').length >= 3;

    const structureScore =
      (hasHeaders ? 0.4 : 0) +
      (hasLists ? 0.3 : 0) +
      (hasSections ? 0.3 : 0);

    return {
      name: 'structured_output',
      passed: structureScore >= 0.3,
      score: structureScore,
      message: `Structure: headers=${hasHeaders}, lists=${hasLists}, sections=${hasSections}`,
    };
  }
}
