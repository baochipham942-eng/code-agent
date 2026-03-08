import React, { useState, useCallback, useEffect } from 'react';
import { FailureFunnel } from '../testResults/FailureFunnel';
import { OpenCodingWorkbench } from '../testResults/OpenCodingWorkbench';
import type { CaseAnnotation } from '../testResults/OpenCodingWorkbench';
import type { TestRunReport, TestCaseResult, EvalAnnotationErrorType } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@shared/ipc';

type FailureView = 'funnel' | 'coding' | 'axial';

export const FailureAnalysisPage: React.FC = () => {
  const [view, setView] = useState<FailureView>('funnel');
  const [cases, setCases] = useState<TestCaseResult[]>([]);
  const [allCases, setAllCases] = useState<TestCaseResult[]>([]);

  const loadFailedCases = useCallback(async () => {
    try {
      const list = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS) as { filePath: string }[] | undefined;
      if (list && list.length > 0) {
        const report = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, list[0].filePath) as TestRunReport | null | undefined;
        if (report) {
          setAllCases(report.results);
          setCases(report.results.filter((r: TestCaseResult) => r.status !== 'passed'));
        }
      }
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => { loadFailedCases(); }, [loadFailedCases]);

  const handleSave = useCallback(async (annotations: CaseAnnotation[]) => {
    try {
      await Promise.all(
        annotations.map((ann, i) =>
          window.electronAPI?.invoke(EVALUATION_CHANNELS.SAVE_ANNOTATIONS, {
            id: `${ann.caseId}-${Date.now()}-${i}`,
            caseId: ann.caseId,
            round: 1,
            timestamp: new Date().toISOString(),
            errorTypes: ann.errorTypes.map((t: string): EvalAnnotationErrorType => {
              const map: Record<string, EvalAnnotationErrorType> = {
                tool_selection_wrong: 'tool_misuse',
                planning_failure: 'reasoning_error',
                execution_error: 'reasoning_error',
                output_format_wrong: 'incomplete_output',
                self_repair_failed: 'hallucination',
              };
              return map[t] || 'incomplete_output';
            }),
            rootCause: ann.rootCause || ann.notes || 'N/A',
            severity: ann.severity,
            annotator: 'failure-analysis',
          })
        )
      );
    } catch (err) {
      console.error('[FailureAnalysis] save failed', err);
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Sub-nav */}
      <div className="flex gap-1 px-4 pt-3 border-b border-zinc-700/30">
        {([
          { key: 'funnel' as const, label: '失败漏斗' },
          { key: 'coding' as const, label: 'Open Coding' },
          { key: 'axial' as const, label: 'Axial Coding' },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setView(tab.key)}
            className={`px-3 py-2 text-xs transition border-b-2 ${
              view === tab.key
                ? 'text-zinc-200 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-300 border-transparent'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {view === 'funnel' && (
          <div className="p-4">
            {allCases.length > 0 ? (
              <FailureFunnel cases={allCases} />
            ) : (
              <div className="text-zinc-500 text-sm text-center py-12">
                运行评测后，失败漏斗数据将出现在此
              </div>
            )}
          </div>
        )}
        {view === 'coding' && (
          <OpenCodingWorkbench cases={cases} onSave={handleSave} />
        )}
        {view === 'axial' && (
          <div className="p-4 space-y-3">
            <h4 className="text-sm font-medium text-zinc-200">Axial Coding 聚类</h4>
            <p className="text-xs text-zinc-500">
              根据 Open Coding 标注结果自动聚类，识别高频错误模式 → 指导 Prompt 优化
            </p>
            <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 p-8 text-center text-zinc-500 text-sm">
              完成 Open Coding 标注后，聚类结果将显示在此
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
