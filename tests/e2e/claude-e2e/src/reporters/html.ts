import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { BaseReporter } from './base.js';
import { TestReport, TestResult } from '../types.js';

export class HtmlReporter extends BaseReporter {
  async generate(report: TestReport): Promise<string> {
    await mkdir(this.options.outputDir!, { recursive: true });

    const filename = `report-${report.timestamp.replace(/[:.]/g, '-')}.html`;
    const filepath = join(this.options.outputDir!, filename);

    const html = this.renderHtml(report);
    await writeFile(filepath, html);

    console.log(`📄 HTML report saved to: ${filepath}`);
    return filepath;
  }

  private renderHtml(report: TestReport): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Agent E2E Test Report</title>
  <style>${this.getStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 Claude Agent E2E Test Report</h1>
      <p class="timestamp">Generated: ${report.timestamp}</p>
    </header>
    ${this.renderSummary(report)}
    ${this.renderCharts(report)}
    ${this.renderProcessAnalysis(report)}
    ${this.renderTestResults(report)}
  </div>
  <script>${this.getScripts()}</script>
</body>
</html>`;
  }

  private renderSummary(report: TestReport): string {
    const { summary } = report;
    const passRate = ((summary.passed / summary.total) * 100).toFixed(1);

    return `
    <section class="summary">
      <h2>📊 Summary</h2>
      <div class="stats-grid">
        <div class="stat-card total"><div class="stat-value">${summary.total}</div><div class="stat-label">Total</div></div>
        <div class="stat-card passed"><div class="stat-value">${summary.passed}</div><div class="stat-label">✅ Passed</div></div>
        <div class="stat-card failed"><div class="stat-value">${summary.failed}</div><div class="stat-label">❌ Failed</div></div>
        <div class="stat-card"><div class="stat-value">${passRate}%</div><div class="stat-label">Pass Rate</div></div>
        <div class="stat-card"><div class="stat-value">${this.formatDuration(report.duration)}</div><div class="stat-label">Duration</div></div>
      </div>
    </section>`;
  }

  private renderCharts(report: TestReport): string {
    const { byCategory, byComplexity } = report;

    return `
    <section class="charts">
      <h2>📈 Breakdown</h2>
      <div class="charts-grid">
        <div class="chart-container">
          <h3>By Complexity</h3>
          <div class="bar-chart">
            ${Object.entries(byComplexity)
              .map(
                ([level, stats]) => `
              <div class="bar-row">
                <span class="bar-label">${level}</span>
                <div class="bar-track"><div class="bar-fill" style="width: ${(stats.passed / stats.total) * 100 || 0}%"></div></div>
                <span class="bar-value">${stats.passed}/${stats.total}</span>
              </div>`
              )
              .join('')}
          </div>
        </div>
        <div class="chart-container">
          <h3>By Category</h3>
          <div class="bar-chart">
            ${Object.entries(byCategory)
              .map(
                ([cat, stats]) => `
              <div class="bar-row">
                <span class="bar-label">${cat}</span>
                <div class="bar-track"><div class="bar-fill" style="width: ${(stats.passed / stats.total) * 100 || 0}%"></div></div>
                <span class="bar-value">${stats.passed}/${stats.total}</span>
              </div>`
              )
              .join('')}
          </div>
        </div>
      </div>
    </section>`;
  }

  private renderProcessAnalysis(report: TestReport): string {
    const processStats: Record<string, { passed: number; total: number }> = {};

    for (const result of report.results) {
      if (!result.processValidations) continue;
      for (const pv of result.processValidations) {
        const type = pv.validation.type;
        if (!processStats[type]) processStats[type] = { passed: 0, total: 0 };
        processStats[type].total++;
        if (pv.passed) processStats[type].passed++;
      }
    }

    return `
    <section class="process-analysis">
      <h2>🔍 Process Validation Analysis</h2>
      <table class="data-table">
        <thead><tr><th>Validation Type</th><th>Passed</th><th>Total</th><th>Rate</th><th>Status</th></tr></thead>
        <tbody>
          ${Object.entries(processStats)
            .map(([type, stats]) => {
              const rate = ((stats.passed / stats.total) * 100).toFixed(0);
              const status =
                stats.passed === stats.total
                  ? '✅'
                  : Number(rate) >= 80
                    ? '⚠️'
                    : '❌';
              return `<tr><td><code>${type}</code></td><td>${stats.passed}</td><td>${stats.total}</td><td>${rate}%</td><td>${status}</td></tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </section>`;
  }

  private renderTestResults(report: TestReport): string {
    return `
    <section class="test-results">
      <h2>📝 Test Results</h2>
      <div class="filter-bar">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="passed">✅ Passed</button>
        <button class="filter-btn" data-filter="failed">❌ Failed</button>
      </div>
      <div class="results-list">
        ${report.results.map((r) => this.renderTestResult(r)).join('')}
      </div>
    </section>`;
  }

  private renderTestResult(result: TestResult): string {
    const { testCase, status, metrics, validations, processValidations } =
      result;
    const statusClass = status === 'passed' ? 'passed' : 'failed';

    const failedValidations = [
      ...validations.filter((v) => !v.passed),
      ...(processValidations?.filter((v) => !v.passed) || []),
    ];

    return `
    <div class="result-card ${statusClass}" data-status="${status}">
      <div class="result-header" onclick="toggleDetails(this)">
        <span class="result-id">${testCase.id}</span>
        <span class="result-name">${testCase.name}</span>
        <span class="result-meta">
          <span class="complexity">${testCase.complexity}</span>
          <span class="category">${testCase.category}</span>
          <span class="duration">${this.formatDuration(metrics.duration)}</span>
          <span class="status-badge ${statusClass}">${this.getStatusEmoji(status)}</span>
        </span>
      </div>
      <div class="result-details" style="display: none;">
        ${
          failedValidations.length > 0
            ? `<div class="failures"><h4>Failed Validations:</h4><ul>
            ${failedValidations.map((v) => `<li><code>${v.validation.type}</code>: ${v.message || 'Failed'}</li>`).join('')}
          </ul></div>`
            : ''
        }
        <div class="metrics"><h4>Metrics:</h4><ul>
          <li>Duration: ${this.formatDuration(metrics.duration)}</li>
          ${metrics.toolCalls !== undefined ? `<li>Tool Calls: ${metrics.toolCalls}</li>` : ''}
        </ul></div>
        ${result.workDir ? `<p class="work-dir">📁 Work dir: <code>${result.workDir}</code></p>` : ''}
      </div>
    </div>`;
  }

  private getStyles(): string {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
      .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
      header { text-align: center; margin-bottom: 30px; }
      header h1 { font-size: 2em; margin-bottom: 10px; }
      .timestamp { color: #666; }
      section { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      h2 { margin-bottom: 15px; color: #2c3e50; }
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 15px; }
      .stat-card { text-align: center; padding: 15px; border-radius: 8px; background: #f8f9fa; }
      .stat-card.passed { background: #d4edda; }
      .stat-card.failed { background: #f8d7da; }
      .stat-value { font-size: 2em; font-weight: bold; }
      .stat-label { color: #666; font-size: 0.9em; }
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
      .bar-row { display: flex; align-items: center; margin-bottom: 8px; }
      .bar-label { width: 100px; font-size: 0.85em; }
      .bar-track { flex: 1; height: 20px; background: #e9ecef; border-radius: 4px; overflow: hidden; }
      .bar-fill { height: 100%; background: #28a745; }
      .bar-value { width: 60px; text-align: right; font-size: 0.85em; }
      .data-table { width: 100%; border-collapse: collapse; }
      .data-table th, .data-table td { padding: 10px; text-align: left; border-bottom: 1px solid #dee2e6; }
      .data-table th { background: #f8f9fa; }
      .filter-bar { margin-bottom: 15px; }
      .filter-btn { padding: 8px 16px; margin-right: 8px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; }
      .filter-btn.active { background: #007bff; color: white; border-color: #007bff; }
      .result-card { border: 1px solid #dee2e6; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
      .result-card.passed { border-left: 4px solid #28a745; }
      .result-card.failed { border-left: 4px solid #dc3545; }
      .result-header { display: flex; align-items: center; padding: 12px 15px; cursor: pointer; background: #f8f9fa; }
      .result-header:hover { background: #e9ecef; }
      .result-id { font-weight: bold; margin-right: 10px; color: #007bff; }
      .result-name { flex: 1; }
      .result-meta { display: flex; gap: 10px; align-items: center; }
      .complexity, .category { font-size: 0.8em; padding: 2px 8px; background: #e9ecef; border-radius: 4px; }
      .duration { color: #666; font-size: 0.85em; }
      .result-details { padding: 15px; background: white; border-top: 1px solid #dee2e6; }
      .result-details h4 { margin: 10px 0 5px; }
      .result-details ul { padding-left: 20px; }
      code { background: #f1f1f1; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    `;
  }

  private getScripts(): string {
    return `
      function toggleDetails(header) {
        const details = header.nextElementSibling;
        details.style.display = details.style.display === 'none' ? 'block' : 'none';
      }
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const filter = btn.dataset.filter;
          document.querySelectorAll('.result-card').forEach(card => {
            card.style.display = (filter === 'all' || card.dataset.status === filter) ? 'block' : 'none';
          });
        });
      });
    `;
  }
}
