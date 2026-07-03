// ============================================================================
// Report Generator - Generate human-readable test reports
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { BaselineDelta, TestRunSummary, TestResult } from './types';
import { formatDuration } from '../../shared/utils/format';

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
 * Generate a self-contained HTML test report.
 */
export function generateHtmlReport(summary: TestRunSummary, baselineDelta?: BaselineDelta): string {
  const capabilityDenominator = getCapabilityDenominator(summary);
  const passRate = getHtmlPassRate(summary);

  const sections: string[] = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Agent Neo Eval Report ${escapeHtml(summary.runId)}</title>`,
    '<style>',
    HTML_REPORT_CSS,
    '</style>',
    '</head>',
    '<body>',
    '<main class="page">',
    '<header class="hero">',
    '<div>',
    '<p class="eyebrow">Agent Neo Eval Report</p>',
    `<h1>${escapeHtml(summary.runId)}</h1>`,
    `<p class="muted">生成时间 ${escapeHtml(formatDate(summary.endTime))} · 总耗时 ${escapeHtml(formatDuration(summary.duration))}</p>`,
    '</div>',
    '<div class="hero-metrics">',
    metricCard('bucket-pass', '通过', summary.passed, `${passRate} pass rate`),
    metricCard('bucket-partial', '部分通过', summary.partial, `${(summary.averageScore * 100).toFixed(1)}% avg score`),
    metricCard('bucket-fail', '失败', summary.failed, `${summary.performance.totalToolCalls} tool calls`),
    metricCard('bucket-infra', '基础设施排除', summary.infraExcluded ?? 0, '不进能力分母'),
    '</div>',
    '</header>',
    '<section class="panel summary-grid">',
    statItem('总用例', summary.total),
    statItem('能力分母', `<span data-testid="capability-denominator">${capabilityDenominator}</span>`, true),
    statItem('通过率', `<span data-testid="pass-rate">${passRate}</span>`, true),
    statItem('跳过', summary.skipped),
    statItem('基础设施排除', `<span data-testid="infra-excluded-count">${summary.infraExcluded ?? 0}</span>`, true),
    statItem('工作目录', summary.environment.workingDirectory),
    statItem('模型', summary.environment.model),
    statItem('提供商', summary.environment.provider),
    '</section>',
    renderScoreAuthorityHtml(summary.results),
    renderCaseDrilldown(summary.results),
    renderInfraSection(summary.results),
    baselineDelta ? renderBaselineDelta(baselineDelta) : '',
    '</main>',
    '</body>',
    '</html>',
  ];

  return sections.filter(Boolean).join('\n');
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

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/=/g, '&#61;');
}

export function escapeHtmlAttribute(value: unknown): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

const HTML_REPORT_CSS = `
:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --text: #172033;
  --muted: #667085;
  --line: #d8dee9;
  --panel: #ffffff;
  --pass: #16794c;
  --pass-bg: #e9f7ef;
  --partial: #936316;
  --partial-bg: #fff4d8;
  --fail: #b42318;
  --fail-bg: #ffe9e7;
  --infra: #455468;
  --infra-bg: #edf2f7;
  --accent: #2952cc;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.55;
}
.page {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 32px 0 48px;
}
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(420px, 0.85fr);
  gap: 24px;
  align-items: stretch;
  margin-bottom: 20px;
}
.hero h1 {
  margin: 0 0 8px;
  font-size: 28px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.eyebrow {
  margin: 0 0 6px;
  color: var(--accent);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0;
  text-transform: uppercase;
}
.muted { color: var(--muted); }
.hero-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.metric-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  background: var(--panel);
}
.metric-card strong {
  display: block;
  font-size: 28px;
  line-height: 1;
  margin: 4px 0 8px;
}
.bucket-pass { border-color: #a6d8be; background: var(--pass-bg); color: var(--pass); }
.bucket-partial { border-color: #f3cf75; background: var(--partial-bg); color: var(--partial); }
.bucket-fail { border-color: #ffb4ad; background: var(--fail-bg); color: var(--fail); }
.bucket-infra { border-color: #cbd5e1; background: var(--infra-bg); color: var(--infra); }
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-top: 16px;
  padding: 18px;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.stat {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcff;
}
.stat span:first-child,
.metric-card span:first-child {
  display: block;
  color: var(--muted);
  font-size: 12px;
}
.stat span:last-child {
  display: block;
  margin-top: 5px;
  font-weight: 700;
  overflow-wrap: anywhere;
}
h2 {
  margin: 0 0 14px;
  font-size: 20px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
th {
  color: var(--muted);
  font-weight: 700;
  font-size: 12px;
}
.case-list {
  display: grid;
  gap: 10px;
}
details {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}
summary {
  cursor: pointer;
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) 100px 100px;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
}
.case-title {
  font-weight: 700;
  overflow-wrap: anywhere;
}
.badge {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 12px;
  font-weight: 700;
}
.badge.passed { background: var(--pass-bg); color: var(--pass); }
.badge.partial { background: var(--partial-bg); color: var(--partial); }
.badge.failed { background: var(--fail-bg); color: var(--fail); }
.badge.skipped,
.badge.infra_excluded { background: var(--infra-bg); color: var(--infra); }
.case-body {
  border-top: 1px solid var(--line);
  padding: 14px;
  display: grid;
  gap: 12px;
}
.subgrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.block {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  background: #fbfcff;
}
.block h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.failure-diff {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.failure-diff .actual { border-left: 3px solid var(--fail); }
.failure-diff .expected { border-left: 3px solid var(--pass); }
.empty {
  color: var(--muted);
  font-style: italic;
}
@media (max-width: 860px) {
  .page { width: min(100vw - 20px, 1180px); padding-top: 18px; }
  .hero { grid-template-columns: 1fr; }
  .hero-metrics,
  .summary-grid,
  .subgrid,
  .failure-diff { grid-template-columns: 1fr; }
  summary { grid-template-columns: 1fr; }
}
`;

function metricCard(className: string, label: string, value: number, note: string): string {
  return [
    `<div class="metric-card ${escapeHtmlAttribute(className)}">`,
    `<span>${escapeHtml(label)}</span>`,
    `<strong>${escapeHtml(value)}</strong>`,
    `<span>${escapeHtml(note)}</span>`,
    '</div>',
  ].join('');
}

function statItem(label: string, value: unknown, alreadyHtml = false): string {
  const rendered = alreadyHtml ? String(value) : escapeHtml(value);
  return `<div class="stat"><span>${escapeHtml(label)}</span><span>${rendered}</span></div>`;
}

function getCapabilityDenominator(summary: TestRunSummary): number {
  return Math.max(0, summary.total - summary.skipped - (summary.infraExcluded ?? 0));
}

function getHtmlPassRate(summary: TestRunSummary): string {
  const denominator = getCapabilityDenominator(summary);
  if (denominator === 0) return '0.0%';
  return `${((summary.passed / denominator) * 100).toFixed(1)}%`;
}

function renderScoreAuthorityHtml(results: TestResult[]): string {
  const buckets: Array<{ key: string; label: string }> = [
    { key: 'deterministic_assertion', label: '确定性断言' },
    { key: 'llm_judge', label: 'LLM 评审' },
    { key: 'self_check', label: '无外部验证' },
    { key: 'unknown', label: '未标注' },
  ];
  const rows = buckets.map((bucket) => {
    const inBucket = results.filter(
      (r) =>
        (r.scoreAuthority ?? 'unknown') === bucket.key &&
        r.status !== 'skipped' &&
        r.status !== 'infra_excluded',
    );
    if (inBucket.length === 0) return '';
    const passed = inBucket.filter((r) => r.status === 'passed').length;
    const avgScore = inBucket.reduce((sum, r) => sum + r.score, 0) / inBucket.length;
    return [
      '<tr>',
      `<td>${escapeHtml(bucket.key)}（${escapeHtml(bucket.label)}）</td>`,
      `<td>${inBucket.length}</td>`,
      `<td>${passed}</td>`,
      `<td>${(avgScore * 100).toFixed(1)}%</td>`,
      '</tr>',
    ].join('');
  }).filter(Boolean).join('\n');

  if (!rows) return '';

  return [
    '<section class="panel">',
    '<h2>评分权威分桶</h2>',
    '<table>',
    '<thead><tr><th>权威桶</th><th>用例数</th><th>通过</th><th>平均分数</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</section>',
  ].join('\n');
}

function renderCaseDrilldown(results: TestResult[]): string {
  const cases = results.map(renderCaseDetail).join('\n');
  return [
    '<section class="panel">',
    '<h2>Case 下钻</h2>',
    `<div class="case-list">${cases}</div>`,
    '</section>',
  ].join('\n');
}

function renderCaseDetail(result: TestResult): string {
  const id = caseHtmlId(result.testId);
  const title = `${result.testId} · ${result.description}`;
  return [
    `<details id="${escapeHtmlAttribute(id)}" class="case ${escapeHtmlAttribute(result.status)}">`,
    '<summary>',
    `<span class="badge ${escapeHtmlAttribute(result.status)}">${escapeHtml(result.status)}</span>`,
    `<span class="case-title">${escapeHtml(title)}</span>`,
    `<span>${escapeHtml(formatDuration(result.duration))}</span>`,
    `<span>${escapeHtml((result.score * 100).toFixed(0))}%</span>`,
    '</summary>',
    '<div class="case-body">',
    '<div class="subgrid">',
    renderTextBlock('Prompt', result.prompt ?? ''),
    renderListBlock('Follow-up Prompts', result.followUpPrompts ?? []),
    renderListBlock('Responses', result.responses),
    renderListBlock('Errors', result.errors),
    '</div>',
    renderFailureBlock(result),
    renderToolBlock(result),
    '</div>',
    '</details>',
  ].join('\n');
}

function renderTextBlock(title: string, value: string): string {
  const body = value ? `<pre>${escapeHtml(value)}</pre>` : '<p class="empty">无</p>';
  return `<div class="block"><h3>${escapeHtml(title)}</h3>${body}</div>`;
}

function renderListBlock(title: string, values: string[]): string {
  if (values.length === 0) return `<div class="block"><h3>${escapeHtml(title)}</h3><p class="empty">无</p></div>`;
  const body = values
    .map((value, index) => `<pre>${index + 1}. ${escapeHtml(value)}</pre>`)
    .join('');
  return `<div class="block"><h3>${escapeHtml(title)}</h3>${body}</div>`;
}

function renderFailureBlock(result: TestResult): string {
  if (!result.failureReason && !result.failureDetails) return '';
  const details = result.failureDetails;
  const reason = result.failureReason ? `<p>${escapeHtml(result.failureReason)}</p>` : '';
  const diff = details
    ? [
        '<div class="failure-diff">',
        `<div class="block expected"><h3>Expected</h3><pre>${escapeHtml(formatUnknown(details.expected))}</pre></div>`,
        `<div class="block actual"><h3>Actual</h3><pre>${escapeHtml(formatUnknown(details.actual))}</pre></div>`,
        '</div>',
        `<div class="block"><h3>Assertion</h3><pre>${escapeHtml(details.assertion)}</pre></div>`,
      ].join('\n')
    : '';
  return `<div class="block"><h3>Failure</h3>${reason}${diff}</div>`;
}

function renderToolBlock(result: TestResult): string {
  if (result.toolExecutions.length === 0) {
    return '<div class="block"><h3>Tool Executions</h3><p class="empty">无</p></div>';
  }

  const rows = result.toolExecutions.map((tool) => [
    '<tr>',
    `<td>${escapeHtml(tool.success ? 'success' : 'failed')}</td>`,
    `<td>${escapeHtml(tool.tool)}</td>`,
    `<td>${escapeHtml(formatDuration(tool.duration))}</td>`,
    `<td><pre>${escapeHtml(formatUnknown(tool.input))}</pre></td>`,
    `<td><pre>${escapeHtml(tool.error ?? tool.output)}</pre></td>`,
    '</tr>',
  ].join('')).join('\n');

  return [
    '<div class="block">',
    '<h3>Tool Executions</h3>',
    '<table>',
    '<thead><tr><th>Status</th><th>Tool</th><th>Duration</th><th>Input</th><th>Output/Error</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</div>',
  ].join('\n');
}

function renderInfraSection(results: TestResult[]): string {
  const infraResults = results.filter((r) => r.status === 'infra_excluded');
  if (infraResults.length === 0) return '';
  const rows = infraResults.map((result) => [
    '<tr>',
    `<td>${escapeHtml(result.testId)}</td>`,
    `<td>${escapeHtml(result.description)}</td>`,
    `<td>${escapeHtml(result.failureReason ?? 'infra excluded')}</td>`,
    '</tr>',
  ].join('')).join('\n');

  return [
    '<section class="panel">',
    '<h2>基础设施排除</h2>',
    '<p class="muted">429、超时、5xx、网络故障单列，不计入能力通过率分母。</p>',
    '<table>',
    '<thead><tr><th>Case</th><th>Description</th><th>Reason</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</section>',
  ].join('\n');
}

function renderBaselineDelta(delta: BaselineDelta): string {
  const failureRows = delta.newFailures.length > 0
    ? delta.newFailures.map((failure) => [
        '<tr>',
        `<td>${escapeHtml(failure.testId)}</td>`,
        `<td>${escapeHtml(failure.previousStatus)}</td>`,
        `<td>${escapeHtml(failure.currentStatus)}</td>`,
        `<td>${escapeHtml(failure.reason ?? '')}</td>`,
        '</tr>',
      ].join('')).join('\n')
    : '<tr><td colspan="4" class="empty">无新增失败</td></tr>';
  const passRows = delta.newPasses.length > 0
    ? delta.newPasses.map((pass) => `<li>${escapeHtml(pass.testId)}</li>`).join('')
    : '<li class="empty">无新增通过</li>';
  const regressionDetails = delta.regressionDetails.length > 0
    ? delta.regressionDetails.map((detail) => `<li>${escapeHtml(detail)}</li>`).join('')
    : '<li class="empty">无</li>';

  return [
    '<section class="panel">',
    '<h2>Baseline Delta</h2>',
    '<div class="summary-grid">',
    statItem('First run', delta.isFirstRun ? 'yes' : 'no'),
    statItem('Pass rate delta', `${(delta.passRateDelta * 100).toFixed(1)}%`),
    statItem('Score delta', `${(delta.scoreDelta * 100).toFixed(1)}%`),
    statItem('Regression', delta.isRegression ? 'yes' : 'no'),
    '</div>',
    '<div class="subgrid">',
    '<div class="block"><h3>Regression Details</h3><ul>',
    regressionDetails,
    '</ul></div>',
    '<div class="block"><h3>New Passes</h3><ul>',
    passRows,
    '</ul></div>',
    '</div>',
    '<div class="block"><h3>New Failures</h3>',
    '<table>',
    '<thead><tr><th>Case</th><th>Previous</th><th>Current</th><th>Reason</th></tr></thead>',
    `<tbody>${failureRows}</tbody>`,
    '</table>',
    '</div>',
    '</section>',
  ].join('\n');
}

function caseHtmlId(testId: string): string {
  const slug = testId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `case-${slug || 'unknown'}`;
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}


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
