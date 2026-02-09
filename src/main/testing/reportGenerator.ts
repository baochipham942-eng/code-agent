// ============================================================================
// Report Generator - Generate human-readable test reports
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { TestRunSummary, TestResult } from './types';
import { formatDuration } from '../../shared/utils/format';

/**
 * Generate a Markdown test report
 */
export function generateMarkdownReport(summary: TestRunSummary): string {
  const lines: string[] = [];

  // Header
  lines.push('# Code Agent 自动化测试报告');
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
  lines.push(`| 失败 | ${summary.failed} ❌ |`);
  lines.push(`| 跳过 | ${summary.skipped} ⏭️ |`);
  lines.push(`| 通过率 | ${getPassRate(summary)}% |`);
  lines.push(`| 总耗时 | ${formatDuration(summary.duration)} |`);
  lines.push('');

  // Progress bar
  lines.push('### 进度');
  lines.push('');
  lines.push(generateProgressBar(summary));
  lines.push('');

  // Environment
  lines.push('## 环境信息');
  lines.push('');
  lines.push('| 配置 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 代际 | ${summary.environment.generation} |`);
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
  lines.push('*此报告由 Code Agent 自动化测试框架生成*');

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
  lines.push('              Code Agent Test Results                  ');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  // Results by status
  for (const result of summary.results) {
    const icon = result.status === 'passed' ? '✅' :
                 result.status === 'failed' ? '❌' : '⏭️';
    const duration = formatDuration(result.duration);
    lines.push(`  ${icon} ${result.testId.padEnd(30)} ${duration}`);

    if (result.status === 'failed' && result.failureReason) {
      lines.push(`     └─ ${result.failureReason}`);
    }
  }

  lines.push('');
  lines.push('───────────────────────────────────────────────────────');
  lines.push(`  Total: ${summary.total}  |  ✅ ${summary.passed}  |  ❌ ${summary.failed}  |  ⏭️ ${summary.skipped}`);
  lines.push(`  Duration: ${formatDuration(summary.duration)}  |  Pass rate: ${getPassRate(summary)}%`);
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
  formats: ('markdown' | 'json' | 'console')[] = ['markdown', 'json']
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

  // Also update "latest" symlinks
  if (formats.includes('markdown')) {
    const latestMd = path.join(outputDir, 'latest-report.md');
    await fs.writeFile(latestMd, generateMarkdownReport(summary));
  }

  if (formats.includes('json')) {
    const latestJson = path.join(outputDir, 'latest-report.json');
    await fs.writeFile(latestJson, generateJsonReport(summary));
  }

  return savedFiles;
}

// ============================================================================
// Helper functions
// ============================================================================

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}


function getPassRate(summary: TestRunSummary): string {
  if (summary.total === 0) return '0';
  const runTests = summary.total - summary.skipped;
  if (runTests === 0) return '0';
  return ((summary.passed / runTests) * 100).toFixed(1);
}

function generateProgressBar(summary: TestRunSummary): string {
  const total = summary.total;
  if (total === 0) return '';

  const width = 40;
  const passedWidth = Math.round((summary.passed / total) * width);
  const failedWidth = Math.round((summary.failed / total) * width);
  const skippedWidth = width - passedWidth - failedWidth;

  const bar =
    '█'.repeat(passedWidth) +
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
