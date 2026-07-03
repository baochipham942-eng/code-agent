// ============================================================================
// HTML Report Generator - Generate self-contained eval reports
// ============================================================================

import type { BaselineDelta, TestRunSummary, TestResult } from './types';
import { formatDuration } from '../../shared/utils/format';

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

export function formatDate(timestamp: number): string {
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
  grid-template-columns: 120px minmax(0, 1fr) 100px 100px minmax(150px, 0.55fr);
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
.efficiency-triage {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
}
.efficiency-triage strong {
  display: block;
  color: var(--text);
  font-size: 13px;
}
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
    renderEfficiencyTriage(result),
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

function renderEfficiencyTriage(result: TestResult): string {
  const efficiency = result.trajectory?.efficiency;
  if (!efficiency) {
    return '<span class="efficiency-triage" data-testid="efficiency-triage"><strong>Efficiency triage</strong>非能力证据，不进统计 · 无</span>';
  }
  return [
    '<span class="efficiency-triage" data-testid="efficiency-triage">',
    `<strong>${escapeHtml((efficiency.efficiency * 100).toFixed(1))}%</strong>`,
    'Efficiency triage · 非能力证据，不进统计',
    '<br>',
    `${escapeHtml(efficiency.redundantSteps)} redundant / ${escapeHtml(efficiency.backtrackCount)} backtrack`,
    '</span>',
  ].join('');
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
