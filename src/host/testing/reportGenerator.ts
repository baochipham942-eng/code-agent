// ============================================================================
// Report Generator - Generate human-readable test reports
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { BaselineDelta, TestRunSummary, TestResult } from './types';
import { formatDuration } from '../../shared/utils/format';
import { formatDate, generateHtmlReport } from './htmlReportGenerator';

export { escapeHtml, escapeHtmlAttribute, generateHtmlReport } from './htmlReportGenerator';

type ReportFormat = 'markdown' | 'json' | 'console' | 'html';

/**
 * Generate a Markdown test report
 */
export function generateMarkdownReport(summary: TestRunSummary): string {
  const lines: string[] = [];

  // Header
  lines.push('# Agent Neo 自动化测试报告');
  lines.push('');
  lines.push(`**生成时间**: ${formatDate(summary.endTime)}`);
  lines.push(`**运行 ID**: \`${summary.runId}\``);
  lines.push('');

  // Overview
  lines.push('## 概览');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 总用例数 | ${summary.total} |`);
  lines.push(`| 通过 | ${summary.passed} ✅ |`);
  lines.push(`| 部分通过 | ${summary.partial} 🟡 |`);
  lines.push(`| 失败 | ${summary.failed} ❌ |`);
  lines.push(`| 跳过 | ${summary.skipped} ⏭️ |`);
  if ((summary.infraExcluded ?? 0) > 0) {
    lines.push(`| 基础设施排除 | ${summary.infraExcluded} 🔌 |`);
  }
  lines.push(`| 通过率 | ${getPassRate(summary)}% |`);
  lines.push(`| 平均分数 | ${(summary.averageScore * 100).toFixed(1)}% |`);
  lines.push(`| 总耗时 | ${formatDuration(summary.duration)} |`);
  lines.push('');

  // Progress bar
  lines.push('### 进度');
  lines.push('');
  lines.push(generateProgressBar(summary));
  lines.push('');

  // Score authority buckets（WP1-1）：分数由什么背书，judge/自报分不冒充硬 pass
  lines.push('## 评分权威分桶');
  lines.push('');
  lines.push(generateScoreAuthoritySection(summary.results));
  lines.push('');

  // Environment
  lines.push('## 环境信息');
  lines.push('');
  lines.push('| 配置 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 模型 | ${summary.environment.model} |`);
  lines.push(`| 提供商 | ${summary.environment.provider} |`);
  lines.push(`| 工作目录 | \`${summary.environment.workingDirectory}\` |`);
  lines.push('');

  // Failed tests (if any)
  const failedTests = summary.results.filter((r) => r.status === 'failed');
  if (failedTests.length > 0) {
    lines.push('## 失败用例详情');
    lines.push('');

    for (const result of failedTests) {
      lines.push(`### ❌ ${result.testId}`);
      lines.push('');
      lines.push(`**描述**: ${result.description}`);
      lines.push('');
      lines.push(`**失败原因**: ${result.failureReason || '未知'}`);
      lines.push('');

      if (result.failureDetails) {
        lines.push('**断言详情**:');
        lines.push('```json');
        lines.push(JSON.stringify(result.failureDetails, null, 2));
        lines.push('```');
        lines.push('');
      }

      // Tool executions
      if (result.toolExecutions.length > 0) {
        lines.push('**工具调用**:');
        lines.push('');
        for (const te of result.toolExecutions) {
          const status = te.success ? '✅' : '❌';
          lines.push(`- ${status} \`${te.tool}\` (${te.duration}ms)`);
          if (te.error) {
            lines.push(`  - Error: ${te.error}`);
          }
        }
        lines.push('');
      }

      // Errors
      if (result.errors.length > 0) {
        lines.push('**错误日志**:');
        lines.push('```');
        for (const error of result.errors) {
          lines.push(error);
        }
        lines.push('```');
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }
  }

  // Partial pass tests
  const partialTests = summary.results.filter((r) => r.status === 'partial');
  if (partialTests.length > 0) {
    lines.push('## 部分通过用例');
    lines.push('');
    lines.push('| 用例 ID | 描述 | 分数 | 失败原因 |');
    lines.push('|---------|------|------|----------|');

    for (const result of partialTests) {
      const scoreStr = `${(result.score * 100).toFixed(0)}%`;
      const reason = result.failureReason?.substring(0, 80) || '—';
      lines.push(
        `| 🟡 ${result.testId} | ${result.description} | ${scoreStr} | ${reason} |`
      );
    }
    lines.push('');

    // Show reference solutions for partial tests
    for (const result of partialTests) {
      if (result.reference_solution) {
        lines.push(`> **${result.testId} 参考解**: ${result.reference_solution}`);
        lines.push('');
      }
    }
  }

  // Show reference solutions for failed tests
  const failedWithRef = failedTests.filter((r) => r.reference_solution);
  if (failedWithRef.length > 0) {
    lines.push('### 失败用例参考解');
    lines.push('');
    for (const result of failedWithRef) {
      lines.push(`> **${result.testId}**: ${result.reference_solution}`);
      lines.push('');
    }
  }

  // Passed tests summary
  const passedTests = summary.results.filter((r) => r.status === 'passed');
  if (passedTests.length > 0) {
    lines.push('## 通过用例');
    lines.push('');
    lines.push('| 用例 ID | 描述 | 耗时 | 工具调用数 |');
    lines.push('|---------|------|------|-----------|');

    for (const result of passedTests) {
      lines.push(
        `| ✅ ${result.testId} | ${result.description} | ${formatDuration(result.duration)} | ${result.toolExecutions.length} |`
      );
    }
    lines.push('');
  }

  // 基础设施排除用例（WP1-2）：单列，不进能力分母；这些是环境噪声，
  // 数量高说明该修限流/超时配置而不是 agent。
  const infraTests = summary.results.filter((r) => r.status === 'infra_excluded');
  if (infraTests.length > 0) {
    lines.push('## 基础设施排除用例');
    lines.push('');
    lines.push('> 429/超时/5xx/网络故障，不计入能力通过率分母。');
    lines.push('');
    for (const result of infraTests) {
      lines.push(`- 🔌 **${result.testId}**: ${result.failureReason || result.description}`);
    }
    lines.push('');
  }

  // Skipped tests
  const skippedTests = summary.results.filter((r) => r.status === 'skipped');
  if (skippedTests.length > 0) {
    lines.push('## 跳过用例');
    lines.push('');
    for (const result of skippedTests) {
      lines.push(`- ⏭️ **${result.testId}**: ${result.failureReason || result.description}`);
    }
    lines.push('');
  }

  // Expectation evidence (P1)
  const resultsWithExpectations = summary.results.filter((r) => r.expectationResults && r.expectationResults.length > 0);
  if (resultsWithExpectations.length > 0) {
    lines.push('## 期望断言详情');
    lines.push('');
    for (const result of resultsWithExpectations) {
      lines.push(`### ${result.testId}`);
      lines.push('');
      lines.push('| 状态 | 描述 | 证据 |');
      lines.push('|------|------|------|');
      for (const er of result.expectationResults!) {
        const status = er.passed ? '✅' : '❌';
        const desc = er.expectation.type.replace(/\|/g, '\\|');
        const evidence = (er.evidence.details ?? '—').replace(/\|/g, '\\|').substring(0, 100);
        lines.push(`| ${status} | ${desc} | ${evidence} |`);
      }
      lines.push('');
    }
  }

  // Trajectory summary (P3)
  const resultsWithTrajectory = summary.results.filter((r) => r.trajectory);
  if (resultsWithTrajectory.length > 0) {
    lines.push('## 轨迹分析');
    lines.push('');
    lines.push('| 用例 ID | 步骤数 | 效率 | 偏差数 | 恢复次数 |');
    lines.push('|---------|--------|------|--------|----------|');
    for (const result of resultsWithTrajectory) {
      const t = result.trajectory!;
      const steps = t.steps.length;
      const efficiency = t.efficiency ? `${(t.efficiency.efficiency * 100).toFixed(0)}%` : '—';
      const deviations = t.deviations.length;
      const recoveries = t.recoveryPatterns.length;
      lines.push(`| ${result.testId} | ${steps} | ${efficiency} | ${deviations} | ${recoveries} |`);
    }
    lines.push('');
  }

  // Eval quality feedback (P4)
  if (summary.evalFeedback) {
    const ef = summary.evalFeedback;
    lines.push('## 评测质量');
    lines.push('');
    lines.push(`**质量分数**: ${(ef.overallQualityScore * 100).toFixed(1)}%`);
    lines.push('');
    if (ef.assertionQualities.filter((q) => q.quality === 'weak').length > 0) {
      lines.push('### 弱断言');
      lines.push('');
      for (const aq of ef.assertionQualities.filter((q) => q.quality === 'weak')) {
        lines.push(`- **${aq.testCaseId}** (${aq.assertionKey}): ${aq.suggestion ?? '无建议'}`);
      }
      lines.push('');
    }
    if (ef.coverageGaps.length > 0) {
      lines.push('### 覆盖缺口');
      lines.push('');
      for (const gap of ef.coverageGaps) {
        lines.push(`- [${gap.priority}] ${gap.description}`);
      }
      lines.push('');
    }
  }

  // Performance stats
  lines.push('## 性能统计');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 平均响应时间 | ${formatDuration(summary.performance.avgResponseTime)} |`);
  lines.push(`| 最长响应时间 | ${formatDuration(summary.performance.maxResponseTime)} |`);
  lines.push(`| 总工具调用数 | ${summary.performance.totalToolCalls} |`);
  lines.push(`| 总对话轮数 | ${summary.performance.totalTurns} |`);
  lines.push('');

  // Top slowest tests
  const sortedByDuration = [...summary.results]
    .filter((r) => r.status !== 'skipped')
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  if (sortedByDuration.length > 0) {
    lines.push('### 最慢用例 (Top 5)');
    lines.push('');
    lines.push('| 排名 | 用例 ID | 耗时 |');
    lines.push('|------|---------|------|');
    sortedByDuration.forEach((result, index) => {
      lines.push(`| ${index + 1} | ${result.testId} | ${formatDuration(result.duration)} |`);
    });
    lines.push('');
  }

  // Recommendations
  const recommendations = generateRecommendations(summary);
  if (recommendations.length > 0) {
    lines.push('## 建议');
    lines.push('');
    recommendations.forEach((rec, index) => {
      lines.push(`${index + 1}. ${rec}`);
    });
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('*此报告由 Agent Neo 自动化测试框架生成*');

  return lines.join('\n');
}

/**
 * Generate a JSON report
 */
export function generateJsonReport(summary: TestRunSummary): string {
  return JSON.stringify(summary, null, 2);
}

/**
 * Generate a compact console report
 */
export function generateConsoleReport(summary: TestRunSummary): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('              Agent Neo Test Results                   ');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  // Results by status
  for (const result of summary.results) {
    const icon = result.status === 'passed' ? '✅' :
                 result.status === 'partial' ? '🟡' :
                 result.status === 'failed' ? '❌' :
                 result.status === 'infra_excluded' ? '🔌' : '⏭️';
    const duration = formatDuration(result.duration);
    const scoreStr = result.status === 'partial' ? ` (${(result.score * 100).toFixed(0)}%)` : '';
    lines.push(`  ${icon} ${result.testId.padEnd(30)} ${duration}${scoreStr}`);

    if ((result.status === 'failed' || result.status === 'partial') && result.failureReason) {
      lines.push(`     └─ ${result.failureReason}`);
    }
  }

  lines.push('');
  lines.push('───────────────────────────────────────────────────────');
  const infraSegment = (summary.infraExcluded ?? 0) > 0 ? `  |  🔌 ${summary.infraExcluded}` : '';
  lines.push(`  Total: ${summary.total}  |  ✅ ${summary.passed}  |  🟡 ${summary.partial}  |  ❌ ${summary.failed}  |  ⏭️ ${summary.skipped}${infraSegment}`);
  lines.push(`  Duration: ${formatDuration(summary.duration)}  |  Pass rate: ${getPassRate(summary)}%  |  Avg score: ${(summary.averageScore * 100).toFixed(1)}%`);
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

/**
 * Save report to file
 */
export async function saveReport(
  summary: TestRunSummary,
  outputDir: string,
  formats: ReportFormat[] = ['markdown', 'json'],
  baselineDelta?: BaselineDelta,
): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
  const savedFiles: string[] = [];

  if (formats.includes('markdown')) {
    const mdPath = path.join(outputDir, `report-${timestamp}.md`);
    await fs.writeFile(mdPath, generateMarkdownReport(summary));
    savedFiles.push(mdPath);
  }

  if (formats.includes('json')) {
    const jsonPath = path.join(outputDir, `report-${timestamp}.json`);
    await fs.writeFile(jsonPath, generateJsonReport(summary));
    savedFiles.push(jsonPath);
  }

  if (formats.includes('html')) {
    const htmlPath = path.join(outputDir, `report-${timestamp}.html`);
    await fs.writeFile(htmlPath, generateHtmlReport(summary, baselineDelta));
    savedFiles.push(htmlPath);
  }

  // Also update "latest" symlinks
  if (formats.includes('markdown')) {
    const latestMd = path.join(outputDir, 'latest-report.md');
    await fs.writeFile(latestMd, generateMarkdownReport(summary));
  }

  if (formats.includes('json')) {
    const latestJson = path.join(outputDir, 'latest-report.json');
    await fs.writeFile(latestJson, generateJsonReport(summary));
  }

  if (formats.includes('html')) {
    const latestHtml = path.join(outputDir, 'latest-report.html');
    await fs.writeFile(latestHtml, generateHtmlReport(summary, baselineDelta));
  }

  return savedFiles;
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * 评分权威分桶表（WP1-1）：deterministic_assertion / llm_judge / self_check，
 * 无标注的历史结果归 unknown 行，不冒充 deterministic。
 * L3 实验提案只准引用前两桶；self_check/unknown 分数不作能力证据。
 */
function generateScoreAuthoritySection(results: TestResult[]): string {
  const buckets: Array<{ key: string; label: string }> = [
    { key: 'deterministic_assertion', label: '确定性断言' },
    { key: 'llm_judge', label: 'LLM 评审' },
    { key: 'self_check', label: '无外部验证' },
    { key: 'unknown', label: '未标注（历史遗留）' },
  ];

  const lines: string[] = [];
  lines.push('| 权威桶 | 用例数 | 通过 | 平均分数 |');
  lines.push('|--------|--------|------|----------|');
  for (const bucket of buckets) {
    const inBucket = results.filter(
      (r) =>
        (r.scoreAuthority ?? 'unknown') === bucket.key &&
        r.status !== 'skipped' &&
        r.status !== 'infra_excluded',
    );
    if (inBucket.length === 0) continue;
    const passed = inBucket.filter((r) => r.status === 'passed').length;
    const avgScore = inBucket.reduce((sum, r) => sum + r.score, 0) / inBucket.length;
    lines.push(
      `| ${bucket.key}（${bucket.label}） | ${inBucket.length} | ${passed} | ${(avgScore * 100).toFixed(1)}% |`,
    );
  }
  lines.push('');
  lines.push('> self_check / 未标注分数不作能力证据；L3 实验提案只准引用 deterministic_assertion 与（校准后的）llm_judge 两桶。');

  return lines.join('\n');
}

function getPassRate(summary: TestRunSummary): string {
  if (summary.total === 0) return '0';
  // 能力分母排除 skipped 与 infra_excluded（WP1-2）
  const runTests = summary.total - summary.skipped - (summary.infraExcluded ?? 0);
  if (runTests === 0) return '0';
  return ((summary.passed / runTests) * 100).toFixed(1);
}

function generateProgressBar(summary: TestRunSummary): string {
  const total = summary.total;
  if (total === 0) return '';

  const width = 40;
  const passedWidth = Math.round((summary.passed / total) * width);
  const partialWidth = Math.round((summary.partial / total) * width);
  const failedWidth = Math.round((summary.failed / total) * width);
  const skippedWidth = Math.max(0, width - passedWidth - partialWidth - failedWidth);

  const bar =
    '█'.repeat(passedWidth) +
    '▒'.repeat(partialWidth) +
    '▓'.repeat(failedWidth) +
    '░'.repeat(skippedWidth);

  return `\`[${bar}]\` ${getPassRate(summary)}%`;
}

function generateRecommendations(summary: TestRunSummary): string[] {
  const recommendations: string[] = [];

  // Check for common failure patterns
  const failedTests = summary.results.filter((r) => r.status === 'failed');

  // Tool-related failures
  const toolFailures = failedTests.filter(
    (r) => r.failureDetails?.assertion?.includes('tool')
  );
  if (toolFailures.length > 0) {
    recommendations.push(
      `检查工具实现：${toolFailures.map((t) => t.testId).join(', ')} 测试中工具执行失败`
    );
  }

  // File-related failures
  const fileFailures = failedTests.filter(
    (r) => r.failureDetails?.assertion?.includes('file')
  );
  if (fileFailures.length > 0) {
    recommendations.push(
      `检查文件操作：${fileFailures.map((t) => t.testId).join(', ')} 测试中文件断言失败`
    );
  }

  // Timeout failures
  const timeoutFailures = failedTests.filter(
    (r) => r.failureReason?.includes('timeout')
  );
  if (timeoutFailures.length > 0) {
    recommendations.push(
      `考虑增加超时时间或优化响应速度：${timeoutFailures.length} 个测试超时`
    );
  }

  // High tool call count
  const highToolCalls = summary.results.filter(
    (r) => r.toolExecutions.length > 10
  );
  if (highToolCalls.length > 0) {
    recommendations.push(
      `优化工具使用效率：某些测试调用了超过 10 次工具`
    );
  }

  // Slow tests
  const slowTests = summary.results.filter(
    (r) => r.duration > 30000
  );
  if (slowTests.length > 0) {
    recommendations.push(
      `优化响应时间：${slowTests.length} 个测试耗时超过 30 秒`
    );
  }

  return recommendations;
}
