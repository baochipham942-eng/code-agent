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
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        暂无评测报告
      </div>
    );
  }


  return (
    <div className="p-4 space-y-4">
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
