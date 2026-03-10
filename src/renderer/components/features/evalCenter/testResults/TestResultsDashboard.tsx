import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { TestRunReport, TestReportListItem } from '@shared/ipc';
import { EVALUATION_CHANNELS, IPC_CHANNELS } from '@shared/ipc';
import { TestResultsSummary } from './TestResultsSummary';
import { TestResultsChart } from './TestResultsChart';
import { TestResultsTable } from './TestResultsTable';
import { ExperimentColumns } from './ExperimentColumns';
import { ScoreHeatmap } from './ScoreHeatmap';
import { FailureFunnel } from './FailureFunnel';
import { CreateExperimentDialog } from '../CreateExperimentDialog';
import ipcService from '../../../../services/ipcService';

interface ExperimentSummary {
  id: string;
  name: string;
  timestamp: number;
  model: string | null;
  summary_json: string;
  source: string;
  git_commit: string | null;
}

export const TestResultsDashboard: React.FC = () => {
  const [showCreateExperiment, setShowCreateExperiment] = useState(false);
  const [reports, setReports] = useState<TestReportListItem[]>([]);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [experimentsLoading, setExperimentsLoading] = useState(false);
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
        const list = await ipcService.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS) as TestReportListItem[] | undefined;
        const safeList = list || [];
        setReports(safeList);

        if (safeList.length === 0) {
          setIsLoading(false);
          return;
        }

        // Auto-load latest report
        const latestPath = safeList[0].filePath;
        const latest = await ipcService.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, latestPath) as TestRunReport | null | undefined;
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
              const r = await ipcService.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, item.filePath) as TestRunReport | null | undefined;
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
    loadExperiments();
  }, []);

  // Load experiments from DB
  const loadExperiments = useCallback(async () => {
    setExperimentsLoading(true);
    try {
      const list = await ipcService.invoke(
        IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS, 50
      ) as ExperimentSummary[] | undefined;
      setExperiments(list || []);
    } catch {
      // best-effort
    } finally {
      setExperimentsLoading(false);
    }
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
      const report = await ipcService.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, filePath) as TestRunReport | null | undefined;
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
        <div className="w-16 h-16 rounded-2xl bg-zinc-700 flex items-center justify-center">
          <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <div>
          <p className="text-zinc-400 font-medium text-sm">暂无评测报告</p>
          <p className="text-zinc-500 text-xs mt-1">运行评测集后，报告会自动出现在这里</p>
        </div>
        <div className="bg-zinc-700/60 rounded-lg p-4 text-left max-w-sm w-full">
          <p className="text-zinc-400 text-xs font-medium mb-2">如何生成评测报告</p>
          <div className="space-y-1.5 text-xs text-zinc-500">
            <div className="flex gap-2">
              <span className="text-zinc-600">1.</span>
              <span>在项目目录配置测试用例 <code className="bg-zinc-600 px-1 rounded text-zinc-400">.code-agent/test-cases/</code></span>
            </div>
            <div className="flex gap-2">
              <span className="text-zinc-600">2.</span>
              <span>运行 <code className="bg-zinc-600 px-1 rounded text-zinc-400">npm run test:eval</code></span>
            </div>
            <div className="flex gap-2">
              <span className="text-zinc-600">3.</span>
              <span>报告保存到 <code className="bg-zinc-600 px-1 rounded text-zinc-400">.code-agent/test-results/</code></span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="p-4 space-y-4">
      {/* Header with new experiment + export buttons */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setShowCreateExperiment(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition font-medium"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新建实验
        </button>
        <button
          onClick={handleExportReport}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-700/60 hover:bg-zinc-700 rounded-lg border border-zinc-800 transition"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          导出报告
        </button>
      </div>

      {/* Create Experiment Dialog */}
      <CreateExperimentDialog
        isOpen={showCreateExperiment}
        onClose={() => setShowCreateExperiment(false)}
        onSubmit={async (config) => {
          try {
            await ipcService.invoke(EVALUATION_CHANNELS.CREATE_EXPERIMENT, config);
            // Refresh the experiment/report list after creating a new experiment
            // Refresh both report list and experiment list
            setTimeout(async () => {
              try {
                const refreshedReports = await ipcService.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS);
                if (refreshedReports && Array.isArray(refreshedReports)) {
                  setReports(refreshedReports);
                }
              } catch {
                // best-effort refresh, ignore errors
              }
              loadExperiments();
            }, 1000);
          } catch {
            // best-effort, ignore errors
          }
        }}
      />

      {/* Experiment columns (replaces old TestResultsHeader dropdown) */}
      <ExperimentColumns
        reports={reports}
        currentReport={currentReport}
        onSelectReport={handleSelectReport}
        isLoading={isLoading}
      />

      {/* DB Experiments list */}
      {(experiments.length > 0 || experimentsLoading) && (
        <div className="bg-zinc-800 border border-zinc-700/20 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-zinc-700/20 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">
              实验记录
              <span className="text-zinc-500 ml-1.5">{experiments.length} 条</span>
            </span>
          </div>
          {experimentsLoading ? (
            <div className="flex items-center justify-center py-4 text-zinc-500 text-xs gap-2">
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              加载中...
            </div>
          ) : (
            <div className="divide-y divide-zinc-700/20 max-h-60 overflow-y-auto">
              {experiments.map((exp) => {
                let summary: { total?: number; passed?: number; failed?: number } = {};
                try { summary = JSON.parse(exp.summary_json || '{}'); } catch { /* ignore */ }
                const passRate = summary.total && summary.total > 0
                  ? Math.round(((summary.passed || 0) / summary.total) * 100)
                  : null;
                const scoreColor = passRate !== null
                  ? passRate >= 80 ? 'text-emerald-400' : passRate >= 50 ? 'text-amber-400' : 'text-red-400'
                  : 'text-zinc-500';

                return (
                  <div key={exp.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-600/20 transition text-xs">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-200 font-medium truncate">{exp.name}</span>
                        <span className="text-[10px] text-zinc-500 font-mono shrink-0">
                          {exp.git_commit ? exp.git_commit.slice(0, 7) : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-zinc-500">
                        <span>{exp.model || 'unknown'}</span>
                        <span>·</span>
                        <span>{new Date(exp.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        <span>·</span>
                        <span>{exp.source}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {passRate !== null ? (
                        <span className={`text-sm font-bold tabular-nums ${scoreColor}`}>{passRate}%</span>
                      ) : (
                        <span className="text-zinc-600 text-[10px]">--</span>
                      )}
                      {summary.total != null && (
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          {summary.passed || 0}/{summary.total} 通过
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Summary stats */}
      <TestResultsSummary report={currentReport} />

      {/* Failure Funnel - full width for proper flow diagram display */}
      <FailureFunnel cases={currentReport.results} />

      <TestResultsChart report={currentReport} />
      <TestResultsTable results={currentReport.results} />

      {/* Score heatmap: only when 2+ reports loaded */}
      {allLoadedReports.length >= 2 && (
        <ScoreHeatmap reports={allLoadedReports} />
      )}
    </div>
  );
};
