import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { TestRunReport, TestReportListItem } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@shared/ipc';
import { TestResultsSummary } from './TestResultsSummary';
import { TestResultsChart } from './TestResultsChart';
import { TestResultsTable } from './TestResultsTable';
import { ExperimentColumns } from './ExperimentColumns';
import { ScoreHeatmap } from './ScoreHeatmap';
import { FailureFunnel } from './FailureFunnel';

export const TestResultsDashboard: React.FC = () => {
  const [reports, setReports] = useState<TestReportListItem[]>([]);
  const [currentReport, setCurrentReport] = useState<TestRunReport | null>(null);
  // Cache of loaded full reports for heatmap (keyed by filePath)
  const reportCache = useRef<Map<string, TestRunReport>>(new Map());
  const [allLoadedReports, setAllLoadedReports] = useState<TestRunReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load report list and eagerly fetch up to 10 recent reports for heatmap
  useEffect(() => {
    const loadReports = async () => {
      try {
        const list = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS) as TestReportListItem[] | undefined;
        const safeList = list || [];
        setReports(safeList);

        if (safeList.length === 0) {
          setIsLoading(false);
          return;
        }

        // Auto-load latest report
        const latestPath = safeList[0].filePath;
        const latest = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, latestPath) as TestRunReport | null | undefined;
        if (latest) {
          reportCache.current.set(latestPath, latest);
          setCurrentReport(latest);
        }

        // Background-load up to 9 more for heatmap
        const toLoad = safeList.slice(1, 10);
        const loaded: TestRunReport[] = latest ? [latest] : [];
        await Promise.allSettled(
          toLoad.map(async (item) => {
            try {
              const r = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, item.filePath) as TestRunReport | null | undefined;
              if (r) {
                reportCache.current.set(item.filePath, r);
                loaded.push(r);
              }
            } catch {
              // best-effort, ignore individual failures
            }
          })
        );
        setAllLoadedReports([...loaded]);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setIsLoading(false);
      }
    };
    loadReports();
  }, []);

  const handleSelectReport = useCallback(async (filePath: string) => {
    // Use cache if available
    const cached = reportCache.current.get(filePath);
    if (cached) {
      setCurrentReport(cached);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const report = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, filePath) as TestRunReport | null | undefined;
      if (report) {
        reportCache.current.set(filePath, report);
        setCurrentReport(report);
        setAllLoadedReports((prev) => {
          if (prev.some((r) => r.runId === report.runId)) return prev;
          return [...prev, report];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  if (isLoading && !currentReport) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        <div className="flex items-center gap-2">
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          加载报告中...
        </div>
      </div>
    );
  }

  if (error && !currentReport) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (!currentReport) {
    return (
      <div className="flex flex-col items-center justify-center h-80 text-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center">
          <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <div>
          <p className="text-zinc-300 font-medium text-sm">暂无评测报告</p>
          <p className="text-zinc-500 text-xs mt-1">运行评测集后，报告会自动出现在这里</p>
        </div>
        <div className="bg-zinc-800/60 rounded-lg p-4 text-left max-w-sm w-full">
          <p className="text-zinc-400 text-xs font-medium mb-2">如何生成评测报告</p>
          <div className="space-y-1.5 text-xs text-zinc-500">
            <div className="flex gap-2">
              <span className="text-zinc-600">1.</span>
              <span>在项目目录配置测试用例 <code className="bg-zinc-700 px-1 rounded text-zinc-300">.code-agent/test-cases/</code></span>
            </div>
            <div className="flex gap-2">
              <span className="text-zinc-600">2.</span>
              <span>运行 <code className="bg-zinc-700 px-1 rounded text-zinc-300">npm run test:eval</code></span>
            </div>
            <div className="flex gap-2">
              <span className="text-zinc-600">3.</span>
              <span>报告保存到 <code className="bg-zinc-700 px-1 rounded text-zinc-300">.code-agent/test-results/</code></span>
            </div>
          </div>
        </div>
      </div>
    );
  }


  const handleExportReport = useCallback(() => {
    if (!currentReport) return;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const passRate = Math.round((currentReport.passed / Math.max(currentReport.total, 1)) * 100);
    const scoreColor = (s: number) => s >= 80 ? '#34d399' : s >= 60 ? '#fbbf24' : '#f87171';
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>评测报告 - ${currentReport.runId}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#333;background:#fafafa}
  h1{font-size:20px;border-bottom:2px solid #eee;padding-bottom:8px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}
  .stat{background:#fff;border:1px solid #eee;border-radius:8px;padding:12px;text-align:center}
  .stat .val{font-size:24px;font-weight:700}
  .stat .lbl{font-size:11px;color:#888;margin-top:4px}
  table{width:100%;border-collapse:collapse;margin:20px 0;font-size:13px}
  th,td{padding:8px 12px;border:1px solid #eee;text-align:left}
  th{background:#f5f5f5;font-weight:600}
  .pass{color:#059669} .fail{color:#dc2626} .partial{color:#d97706}
  .footer{margin-top:40px;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#999}
</style></head><body>
<h1>评测报告</h1>
<p style="color:#888;font-size:12px">Run ID: ${currentReport.runId} | 生成时间: ${new Date().toLocaleString('zh-CN')}</p>
<div class="stats">
  <div class="stat"><div class="val" style="color:${scoreColor(passRate)}">${passRate}%</div><div class="lbl">通过率</div></div>
  <div class="stat"><div class="val">${currentReport.total}</div><div class="lbl">总用例</div></div>
  <div class="stat"><div class="val" style="color:#059669">${currentReport.passed}</div><div class="lbl">通过</div></div>
  <div class="stat"><div class="val" style="color:#dc2626">${currentReport.failed}</div><div class="lbl">失败</div></div>
</div>
<h2 style="font-size:16px">用例详情</h2>
<table><thead><tr><th>Test ID</th><th>状态</th><th>得分</th><th>耗时</th><th>说明</th></tr></thead><tbody>
${currentReport.results.map(r => {
  const cls = r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : 'partial';
  const label = r.status === 'passed' ? '通过' : r.status === 'failed' ? '失败' : '部分通过';
  return '<tr><td><code>' + esc(r.testId) + '</code></td><td class="' + cls + '">' + label + '</td><td>' + Math.round(r.score * 100) + '%</td><td>' + (r.duration/1000).toFixed(1) + 's</td><td>' + esc(r.failureReason || r.description || '-') + '</td></tr>';
}).join('\n')}
</tbody></table>
<div class="footer">由 Code Agent 评测中心生成</div>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eval-report-' + currentReport.runId.slice(0, 8) + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [currentReport]);

  return (
    <div className="p-4 space-y-4">
      {/* Header with export button */}
      <div className="flex items-center justify-between">
        <div />
        <button
          onClick={handleExportReport}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800/60 hover:bg-zinc-700/60 rounded-lg border border-zinc-700/30 transition"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          导出报告
        </button>
      </div>

      {/* Experiment columns (replaces old TestResultsHeader dropdown) */}
      <ExperimentColumns
        reports={reports}
        currentReport={currentReport}
        onSelectReport={handleSelectReport}
        isLoading={isLoading}
      />

      {/* Summary + Failure Funnel side by side */}
      <div className="grid grid-cols-[1fr_220px] gap-4 items-start">
        <TestResultsSummary report={currentReport} />
        <FailureFunnel cases={currentReport.results} />
      </div>

      <TestResultsChart report={currentReport} />
      <TestResultsTable results={currentReport.results} />

      {/* Score heatmap: only when 2+ reports loaded */}
      {allLoadedReports.length >= 2 && (
        <ScoreHeatmap reports={allLoadedReports} />
      )}
    </div>
  );
};
