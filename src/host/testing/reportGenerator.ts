// ============================================================================
// Report Generator - Generate human-readable test reports
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { BaselineDelta, TestRunSummary, TestResult } from './types';
import { formatDuration } from '../../shared/utils/format';
import { getRunStampReportRows } from './runStampReport';
import { failureCodeLabel, loadProjectFailureCodebook } from './failureCodes';
import { AI_REVIEW_DIMENSIONS } from './judge/dimensions';
import type { AiReviewDimension } from '../../shared/contract/evaluation';

type ReportFormat = 'markdown' | 'json' | 'console';

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

/**
 * Generate a Markdown test report
 */
export function generateMarkdownReport(
  summary: TestRunSummary,
  baselineDelta?: BaselineDelta,
): string {
  const lines: string[] = [];
  const repeated = summary.aggregationRule === 'pass_caret_k';
  const mainMetricLabel = repeated
    ? `k 次全过率（k=${summary.stamp.k}）`
    : '通过率';

  // Header
  lines.push('# Agent Neo 自动化测试报告');
  lines.push('');
  lines.push(`**生成时间**: ${formatDate(summary.endTime)}`);
  lines.push(`**运行 ID**: \`${summary.runId}\``);
  const failureCodebookLabel = summary.failureCodebookSource === 'project'
    ? '项目'
    : summary.failureCodebookSource === 'bundled' ? '内置' : '未记录';
  lines.push(`**失败原因码本：${failureCodebookLabel}**`);
  lines.push('');

  // Overview
  lines.push('## 概览');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 总用例数 | ${summary.total} |`);
  lines.push(`| 计划题数 | ${summary.plannedCaseIds.length} |`);
  lines.push(`| 是否跑满 | ${summary.completed ? '是' : '否'} |`);
  lines.push(`| 通过 | ${summary.passed} ✅ |`);
  lines.push(`| 部分通过 | ${summary.partial} 🟡 |`);
  lines.push(`| 失败 | ${summary.failed} ❌ |`);
  lines.push(`| 跳过 | ${summary.skipped} ⏭️ |`);
  if ((summary.mockExcluded ?? 0) > 0) {
    lines.push(`| Mock 不适用 | ${summary.mockExcluded} 🧪 |`);
  }
  if ((summary.infraExcluded ?? 0) > 0) {
    lines.push(`| 不计入${repeated ? '主指标' : '通过率'}（环境故障） | ${summary.infraExcluded} 🔌 |`);
  }
  if ((summary.costExceeded ?? 0) > 0) {
    lines.push(`| 成本超限 | ${summary.costExceeded} 💸 |`);
  }
  if (summary.notRun > 0) {
    lines.push(`| 未跑 | ${summary.notRun} ⏸️ |`);
  }
  if (summary.invalidCases > 0) {
    lines.push(`| 无效题（没调真模型） | ${summary.invalidCases} ⚠️ |`);
  }
  lines.push(`| ${mainMetricLabel} | ${getPassRate(summary)}% |`);
  lines.push(`| 平均分数 | ${(summary.averageScore * 100).toFixed(1)}% |`);
  lines.push(`| 总耗时 | ${formatDuration(summary.duration)} |`);
  lines.push('');

  lines.push('## 稳定性');
  lines.push('');
  lines.push('| 用例 ID | 试次数 n | 通过次数 c | 至少一次通过 passAtK | 全部通过 passCaretK | σ（修正后） |');
  lines.push('|---------|-----------:|-------------:|----------------------:|------------------------:|-------------:|');
  for (const result of summary.results) {
    const aggregate = result.trialAggregate;
    const n = aggregate?.n ?? (result.status === 'infra_excluded' ? 0 : 1);
    const c = aggregate?.c ?? (result.status === 'passed' && !result.invalid ? 1 : 0);
    const passAtK = aggregate?.passAtK ?? c;
    const passCaretK = aggregate?.passCaretK ?? c;
    lines.push(
      `| ${result.testId} | ${n} | ${c} | ${passAtK.toFixed(4)} | ${passCaretK.toFixed(4)} | ${result.stdDev === undefined ? 'n/a' : result.stdDev.toFixed(4)} |`,
    );
  }
  lines.push('');

  lines.push('## 成本与用量');
  lines.push('');
  lines.push('> Token 与 USD 均来自 provider response usage；缺失或混入本地估算时标为 `usage_unavailable`，不以 0 代替。USD 按 `MODEL_PRICING_PER_1M` 折算。');
  lines.push('');
  lines.push('| 用例 ID | Prompt tokens | Completion tokens | Total tokens | 折算 USD |');
  lines.push('|---------|---------------|-------------------|--------------|----------|');
  for (const result of summary.results) {
    if (result.usageStatus !== 'available' || !result.usage || result.costUsd === undefined) {
      lines.push(`| ${result.testId} | usage_unavailable | usage_unavailable | usage_unavailable | usage_unavailable |`);
      continue;
    }
    lines.push(
      `| ${result.testId} | ${formatTokenCount(result.usage.promptTokens)} | ${formatTokenCount(result.usage.completionTokens)} | ${formatTokenCount(result.usage.totalTokens)} | $${result.costUsd.toFixed(6)} |`,
    );
  }
  const costSummary = summarizeCostUsage(summary.results);
  lines.push(
    `| **汇总（${costSummary.availableCases}/${summary.results.length} 个 case 有 provider usage）** | **${formatTokenCount(costSummary.promptTokens)}** | **${formatTokenCount(costSummary.completionTokens)}** | **${formatTokenCount(costSummary.totalTokens)}** | **$${costSummary.costUsd.toFixed(6)}** |`,
  );
  if (costSummary.unavailableCases > 0) {
    lines.push(`| usage_unavailable case | ${costSummary.unavailableCases} | — | — | — |`);
  }
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

  const aiReviewSection = generateAiReviewSection(summary.results);
  if (aiReviewSection) {
    lines.push('## AI 评审（并列 · 不进通过率）');
    lines.push('');
    lines.push(aiReviewSection);
  }
  lines.push('');

  // Environment
  lines.push('## 环境信息');
  lines.push('');
  lines.push('| 配置 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 模型 | ${summary.environment.model} |`);
  lines.push(`| 提供商 | ${summary.environment.provider} |`);
  lines.push(`| 代码版本 | ${summary.gitCommit ?? 'unknown'} |`);
  for (const [label, value] of getRunStampReportRows(summary.stamp)) {
    lines.push(`| ${label} | ${value} |`);
  }
  lines.push(`| 工作目录 | \`${summary.environment.workingDirectory}\` |`);
  lines.push('');

  lines.push('## 失败原因分布');
  lines.push('');
  lines.push(...generateFailureDistributionRows(summary));
  lines.push('');

  // Failed tests (if any)
  const failedTests = summary.results.filter((r) => r.status === 'failed');
  if (failedTests.length > 0) {
    lines.push('## 失败用例详情');
    lines.push('');
    lines.push('| 用例 ID | 失败原因（码） | 失败详情 |');
    lines.push('|---------|----------------|----------|');
    for (const result of failedTests) {
      const reason = (result.failureReason || '未知').replace(/\|/g, '\\|').substring(0, 120);
      lines.push(`| ${result.testId} | ${formatFailureCode(result.failure?.code ?? 'unknown')} | ${reason} |`);
    }
    lines.push('');

    for (const result of failedTests) {
      lines.push(`### ❌ ${result.testId}`);
      lines.push('');
      lines.push(`**描述**: ${result.description}`);
      lines.push('');
      lines.push(`**失败原因**: ${result.failureReason || '未知'}`);
      lines.push('');
      lines.push(`**失败原因（码）**: ${formatFailureCode(result.failure?.code ?? 'unknown')}`);
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
    lines.push('| 用例 ID | 描述 | 分数 | 失败原因（码） | 失败详情 |');
    lines.push('|---------|------|------|----------------|----------|');

    for (const result of partialTests) {
      const scoreStr = `${(result.score * 100).toFixed(0)}%`;
      const reason = result.failureReason?.substring(0, 80) || '—';
      lines.push(
        `| 🟡 ${result.testId} | ${result.description} | ${scoreStr} | ${formatFailureCode(result.failure?.code ?? 'unknown')} | ${reason} |`
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
  const passedTests = summary.results.filter((r) => r.status === 'passed' && !r.invalid);
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

  const invalidTests = summary.results.filter((result) => result.invalid);
  if (invalidTests.length > 0) {
    lines.push('## 无效题（没调真模型）');
    lines.push('');
    lines.push('> 这些题不计为通过，也不能用于设置对比基准。');
    lines.push('');
    for (const result of invalidTests) {
      lines.push(`- ⚠️ **${result.testId}**: ${result.invalid?.reason ?? '未说明'}`);
    }
    lines.push('');
  }

  const notRunTests = summary.results.filter((result) => result.status === 'not_run');
  if (notRunTests.length > 0) {
    lines.push('## 未跑题目');
    lines.push('');
    lines.push(`> 本轮未跑满；未跑题仍计入${repeated ? '主指标' : '通过率'}，且本轮不能与基准比较。`);
    lines.push('');
    for (const result of notRunTests) {
      lines.push(`- ⏸️ **${result.testId}**: ${result.failureReason ?? '轮次中断'}`);
    }
    lines.push('');
  }

  // 环境故障用例（WP1-2）：单列，不计入通过率。
  // 数量高说明该修限流/超时配置而不是 agent。
  const infraTests = summary.results.filter((r) => r.status === 'infra_excluded');
  if (infraTests.length > 0) {
    lines.push(`## 不计入${repeated ? '主指标' : '通过率'}（环境故障）`);
    lines.push('');
    lines.push(`> 429、5xx 或网络故障不计入${repeated ? '主指标' : '通过率'}。题目总时限超限仍按能力失败处理。`);
    lines.push('');
    for (const result of infraTests) {
      lines.push(`- 🔌 **${result.testId}**: ${result.failureReason || result.description}`);
    }
    lines.push('');
  }

  const costExceededTests = summary.results.filter((result) => result.status === 'cost_exceeded');
  if (costExceededTests.length > 0) {
    lines.push('## 成本超限用例');
    lines.push('');
    lines.push(`> 单题实际模型成本超过声明上限，执行已停止；该结果不计入${repeated ? '主指标' : '通过率'}（成本超限）。`);
    lines.push('');
    for (const result of costExceededTests) {
      lines.push(
        `- 💸 **${result.testId}**: ${result.failureReason || result.description}`
        + `（实际 ${result.costUsd === undefined ? 'usage_unavailable' : `$${result.costUsd.toFixed(6)}`} / 上限 $${(result.costLimitUsd ?? 0).toFixed(6)}）`,
      );
    }
    lines.push('');
  }

  const mockExcludedTests = summary.results.filter((result) => result.mockExcluded);
  if (mockExcludedTests.length > 0) {
    lines.push('## Mock 不适用用例');
    lines.push('');
    lines.push(`> 这些 case 依赖真实 agent 语义或产物能力，mock 运行中不计入${repeated ? '主指标' : '通过率'}；不代表通过。`);
    lines.push('');
    for (const result of mockExcludedTests) {
      lines.push(`- 🧪 **${result.testId}**: ${result.mockExcluded?.reason ?? ''}`);
    }
    lines.push('');
  }

  // Skipped tests（mock 不适用已单列，避免重复）
  const skippedTests = summary.results.filter((r) => r.status === 'skipped' && !r.mockExcluded);
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

  if (baselineDelta) {
    lines.push('## Baseline Delta');
    lines.push('');
    if (!baselineDelta.comparable) {
      lines.push(`> ${baselineDelta.reason}`);
      lines.push('');
    } else {
      lines.push('| 指标 | 值 |');
      lines.push('|------|-----|');
      lines.push(`| 首次运行 | ${baselineDelta.isFirstRun ? '是' : '否'} |`);
      lines.push(`| ${mainMetricLabel}变化 | ${(baselineDelta.passRateDelta * 100).toFixed(1)}% |`);
      lines.push(`| 平均分变化 | ${(baselineDelta.scoreDelta * 100).toFixed(1)}% |`);
      lines.push(`| 回归 | ${baselineDelta.isRegression ? '是' : '否'} |`);
      lines.push('');

      if (baselineDelta.regressionDetails.length > 0) {
        lines.push('### 回归详情');
        lines.push('');
        baselineDelta.regressionDetails.forEach((detail) => lines.push(`- ${detail}`));
        lines.push('');
      }

      if (baselineDelta.newFailures.length > 0) {
        lines.push('### 新增失败');
        lines.push('');
        lines.push('| 用例 | 原状态 | 当前状态 | 原因 |');
        lines.push('|------|--------|----------|------|');
        baselineDelta.newFailures.forEach((failure) => {
          lines.push(`| ${failure.testId} | ${failure.previousStatus} | ${failure.currentStatus} | ${failure.reason ?? '—'} |`);
        });
        lines.push('');
      }

      if (baselineDelta.newPasses.length > 0) {
        lines.push('### 新增通过');
        lines.push('');
        baselineDelta.newPasses.forEach((result) => lines.push(`- ${result.testId}`));
        lines.push('');
      }
    }
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

function reportFailureCodebook() {
  try {
    return loadProjectFailureCodebook();
  } catch {
    return undefined;
  }
}

function formatFailureCode(code: string): string {
  const codebook = reportFailureCodebook();
  const label = codebook ? failureCodeLabel(codebook, code) : code === 'unknown' ? '未归类' : code;
  return `${label} <span style="color:#888"><code>${code}</code></span>`;
}

function formatDisposition(disposition: string): string {
  if (disposition === 'retryable') return '可以重试';
  if (disposition === 'not_in_denominator') return '不计入通过率';
  if (disposition === 'needs_human') return '需要人工确认';
  if (disposition.startsWith('known_issue:')) return `已知问题 ${disposition.slice('known_issue:'.length)}`;
  return disposition;
}

function generateFailureDistributionRows(summary: TestRunSummary): string[] {
  const distribution = { unknown: 0, ...summary.failureDistribution };
  const codeRows = Object.entries(distribution)
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => (
      rightCount - leftCount || leftCode.localeCompare(rightCode)
    ));
  const dispositions = summary.results.reduce<Record<string, number>>((counts, result) => {
    for (const disposition of result.failure?.dispositions ?? []) {
      counts[disposition] = (counts[disposition] ?? 0) + 1;
    }
    return counts;
  }, {});
  const lines = [
    '| 失败原因 | 数量 |',
    '|----------|------|',
    ...codeRows.map(([code, count]) => `| ${formatFailureCode(code)} | ${count} |`),
    '',
    '### 处置标签',
    '',
    '| 处置 | 数量 |',
    '|------|------|',
  ];
  const dispositionRows = Object.entries(dispositions)
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right))
    .map(([disposition, count]) => `| ${formatDisposition(disposition)} | ${count} |`);
  lines.push(...(dispositionRows.length > 0 ? dispositionRows : ['| 暂无 | 0 |']));
  return lines;
}

/**
 * Generate a compact console report
 */
export function generateConsoleReport(summary: TestRunSummary): string {
  const lines: string[] = [];
  const mainMetricLabel = summary.aggregationRule === 'pass_caret_k'
    ? `k=${summary.stamp.k} all-pass rate`
    : 'Pass rate';

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('              Agent Neo Test Results                   ');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  // Results by status
  for (const result of summary.results) {
    const icon = result.invalid ? '⚠️' :
                 result.mockExcluded ? '🧪' :
                 result.status === 'passed' ? '✅' :
                 result.status === 'partial' ? '🟡' :
                 result.status === 'failed' ? '❌' :
                 result.status === 'infra_excluded' ? '🔌' :
                 result.status === 'cost_exceeded' ? '💸' :
                 result.status === 'not_run' ? '⏸️' : '⏭️';
    const duration = formatDuration(result.duration);
    const scoreStr = result.status === 'partial' ? ` (${(result.score * 100).toFixed(0)}%)` : '';
    lines.push(`  ${icon} ${result.testId.padEnd(30)} ${duration}${scoreStr}`);

    if ((result.status === 'failed' || result.status === 'partial' || result.mockExcluded || result.invalid || result.status === 'not_run') && result.failureReason) {
      lines.push(`     └─ ${result.failureReason}`);
    }
  }

  lines.push('');
  lines.push('───────────────────────────────────────────────────────');
  const infraSegment = (summary.infraExcluded ?? 0) > 0 ? `  |  🔌 ${summary.infraExcluded}` : '';
  const costSegment = (summary.costExceeded ?? 0) > 0 ? `  |  💸 ${summary.costExceeded}` : '';
  const mockSegment = (summary.mockExcluded ?? 0) > 0 ? `  |  🧪 mock-excluded ${summary.mockExcluded}` : '';
  const notRunSegment = summary.notRun > 0 ? `  |  ⏸️ 未跑 ${summary.notRun}` : '';
  const invalidSegment = summary.invalidCases > 0 ? `  |  ⚠️ 无效题 ${summary.invalidCases}` : '';
  const costSummary = summarizeCostUsage(summary.results);
  lines.push(`  Total: ${summary.total}  |  ✅ ${summary.passed}  |  🟡 ${summary.partial}  |  ❌ ${summary.failed}  |  ⏭️ ${summary.skipped}${mockSegment}${infraSegment}${costSegment}${notRunSegment}${invalidSegment}`);
  lines.push(`  Duration: ${formatDuration(summary.duration)}  |  ${mainMetricLabel}: ${getPassRate(summary)}%  |  Avg score: ${(summary.averageScore * 100).toFixed(1)}%`);
  lines.push(`  Cost: $${costSummary.costUsd.toFixed(6)}  |  Provider usage: ${costSummary.availableCases}/${summary.results.length} cases${costSummary.unavailableCases > 0 ? `  |  usage_unavailable ${costSummary.unavailableCases}` : ''}`);
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
    await fs.writeFile(mdPath, generateMarkdownReport(summary, baselineDelta));
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
    await fs.writeFile(latestMd, generateMarkdownReport(summary, baselineDelta));
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

/**
 * 评分权威分桶表（WP1-1）：deterministic_assertion / llm_judge / self_check，
 * 无标注的历史结果归 unknown 行，不冒充 deterministic。
 * L3 实验提案只准引用前两桶；self_check/unknown 分数不作能力证据。
 *
 * scoreAuthority 第二步：llm_judge 桶必须绑定达标的校准记录
 * （calibrationRegistry.isTrustedCalibration）才进可信列；未绑定/不达标
 * 的 judge 分强制标注，不作能力证据。
 */
function generateScoreAuthoritySection(results: TestResult[]): string {
  const buckets: Array<{ key: string; label: string }> = [
    { key: 'deterministic_assertion', label: '确定性断言' },
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
        r.status !== 'infra_excluded' &&
        r.status !== 'cost_exceeded',
    );
    if (inBucket.length === 0) continue;
    const passed = inBucket.filter((r) => r.status === 'passed' && !r.invalid).length;
    const avgScore = inBucket.reduce((sum, r) => sum + (r.invalid ? 0 : r.score), 0) / inBucket.length;
    lines.push(
      `| ${bucket.key}（${bucket.label}） | ${inBucket.length} | ${passed} | ${(avgScore * 100).toFixed(1)}% |`,
    );
  }
  lines.push('');
  lines.push('> 通过率只读取确定性断言；AI 评审在下方并列展示，不属于分数权威桶。');

  return lines.join('\n');
}

const AI_REVIEW_LABELS: Record<AiReviewDimension, string> = {
  task_completed: '任务完成',
  tool_choice: '工具选择',
  confirmed_before_acting: '先确认后执行',
  no_extra_changes: '改动克制',
  self_tested: '完成自测',
};

function generateAiReviewSection(results: TestResult[]): string {
  if (!results.some((result) => result.aiReview)) return '';
  const lines = [
    '| 维度 | 是 | 否 | 不可用 |',
    '|------|---:|---:|-------:|',
  ];
  for (const dimension of AI_REVIEW_DIMENSIONS) {
    const verdicts = results.map((result) => result.aiReview?.[dimension]?.verdict).filter(Boolean);
    lines.push(`| ${AI_REVIEW_LABELS[dimension]} | ${verdicts.filter((v) => v === 'yes').length} | ${verdicts.filter((v) => v === 'no').length} | ${verdicts.filter((v) => v === 'unavailable').length} |`);
  }
  lines.push('', `| 用例 ID | ${AI_REVIEW_DIMENSIONS.map((dimension) => AI_REVIEW_LABELS[dimension]).join(' | ')} |`);
  lines.push(`|---------|${AI_REVIEW_DIMENSIONS.map(() => '---').join('|')}|`);
  for (const result of results) {
    const cells = AI_REVIEW_DIMENSIONS.map((dimension) => {
      const verdict = result.aiReview?.[dimension]?.verdict;
      return verdict === 'yes' ? '是' : verdict === 'no' ? '否' : verdict === 'unavailable' ? '不可用' : '—';
    });
    lines.push(`| ${result.testId} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function getPassRate(summary: TestRunSummary): string {
  if (summary.total === 0) return '0';
  // not_run 留在计划题数内；仅跳过、环境故障、成本超限不计入通过率。
  const runTests =
    summary.total
    - summary.skipped
    - (summary.infraExcluded ?? 0)
    - (summary.costExceeded ?? 0);
  if (runTests === 0) return '0';
  return ((summary.passed / runTests) * 100).toFixed(1);
}

function formatTokenCount(value: number): string {
  return value.toLocaleString('en-US');
}

function summarizeCostUsage(results: TestResult[]): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  availableCases: number;
  unavailableCases: number;
} {
  return results.reduce((summary, result) => {
    if (result.usageStatus !== 'available' || !result.usage || result.costUsd === undefined) {
      summary.unavailableCases++;
      return summary;
    }
    summary.promptTokens += result.usage.promptTokens;
    summary.completionTokens += result.usage.completionTokens;
    summary.totalTokens += result.usage.totalTokens;
    summary.costUsd += result.costUsd;
    summary.availableCases++;
    return summary;
  }, {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    availableCases: 0,
    unavailableCases: 0,
  });
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
