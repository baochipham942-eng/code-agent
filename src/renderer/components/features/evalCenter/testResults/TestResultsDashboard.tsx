import React, { useState, useEffect, useCallback } from 'react';
import type { TestRunReport, TestReportListItem } from '@shared/ipc';
import { IPC_CHANNELS } from '@shared/ipc';
import { TestResultsHeader } from './TestResultsHeader';
import { TestResultsSummary } from './TestResultsSummary';
import { TestResultsChart } from './TestResultsChart';
import { TestResultsTable } from './TestResultsTable';

export const TestResultsDashboard: React.FC = () => {
  const [reports, setReports] = useState<TestReportListItem[]>([]);
  const [currentReport, setCurrentReport] = useState<TestRunReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load report list
  useEffect(() => {
    const loadReports = async () => {
      try {
        const list = await window.electronAPI?.invoke(IPC_CHANNELS.EVALUATION_LIST_TEST_REPORTS) as TestReportListItem[] | undefined;
        setReports(list || []);
        // Auto-load latest report
        if ((list?.length ?? 0) > 0 && list) {
          const report = await window.electronAPI?.invoke(IPC_CHANNELS.EVALUATION_LOAD_TEST_REPORT, list[0].filePath) as TestRunReport | null | undefined;
          setCurrentReport(report ?? null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setIsLoading(false);
      }
    };
    loadReports();
  }, []);

  const handleSelectReport = useCallback(async (filePath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const report = await window.electronAPI?.invoke(IPC_CHANNELS.EVALUATION_LOAD_TEST_REPORT, filePath) as TestRunReport | null | undefined;
      setCurrentReport(report ?? null);
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
      <TestResultsHeader
        report={currentReport}
        reports={reports}
        onSelectReport={handleSelectReport}
        isLoading={isLoading}
      />
      <TestResultsSummary report={currentReport} />
      <TestResultsChart report={currentReport} />
      <TestResultsTable results={currentReport.results} />
    </div>
  );
};
