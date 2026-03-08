// ============================================================================
// EvalCenterPanel - 评测中心（3 Tab 重构：报告 / 会话历史 / 标注）
// ============================================================================

import React, { useState, useCallback } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { SessionListView } from './SessionListView';
import { OpenCodingWorkbench } from './testResults/OpenCodingWorkbench';
import { TestResultsDashboard } from './testResults/TestResultsDashboard';
import type { CaseAnnotation } from './testResults/OpenCodingWorkbench';
import type { TestRunReport, TestCaseResult } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@shared/ipc';

type Mode = 'reports' | 'sessions' | 'coding';

export const EvalCenterPanel: React.FC = () => {
  const { showEvalCenter, setShowEvalCenter } = useAppStore();

  const [mode, setMode] = useState<Mode>('reports');
  const [codingCases, setCodingCases] = useState<TestCaseResult[]>([]);

  if (!showEvalCenter) return null;

  const handleClose = () => setShowEvalCenter(false);

  // Load latest report's failed cases and enter coding mode
  const handleEnterCoding = useCallback(async () => {
    try {
      const list = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS) as { filePath: string }[] | undefined;
      if (list && list.length > 0) {
        const report = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, list[0].filePath) as TestRunReport | null | undefined;
        if (report) {
          const failed = report.results.filter((r: TestCaseResult) => r.status !== 'passed');
          setCodingCases(failed);
        }
      }
    } catch {
      // best-effort
    }
    setMode('coding');
  }, []);

  const handleSaveAnnotations = useCallback(async (annotations: CaseAnnotation[]) => {
    const toEvalErrorType = (errorType: CaseAnnotation['errorTypes'][number]) => {
      switch (errorType) {
        case 'tool_selection_wrong':
          return 'tool_misuse' as const;
        case 'planning_failure':
        case 'execution_error':
          return 'reasoning_error' as const;
        case 'output_format_wrong':
          return 'incomplete_output' as const;
        case 'self_repair_failed':
          return 'hallucination' as const;
        default:
          return 'incomplete_output' as const;
      }
    };

    try {
      await Promise.all(
        annotations.map((annotation, index) =>
          window.electronAPI?.invoke(EVALUATION_CHANNELS.SAVE_ANNOTATIONS, {
            id: `${annotation.caseId}-${Date.now()}-${index}`,
            caseId: annotation.caseId,
            round: 1,
            timestamp: new Date().toISOString(),
            errorTypes: annotation.errorTypes.map(toEvalErrorType),
            rootCause: annotation.rootCause || annotation.notes || 'N/A',
            severity: annotation.severity,
            annotator: 'open-coding-workbench',
          })
        )
      );
    } catch (error) {
      console.error('[OpenCoding] Failed to persist annotations', error);
    }
  }, []);

  const tabs: { key: Mode; label: string; onClick?: () => void }[] = [
    { key: 'reports', label: '📊 评测报告' },
    { key: 'sessions', label: '📋 会话历史' },
    { key: 'coding', label: '📝 标注', onClick: handleEnterCoding },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-xl border border-zinc-700/50 shadow-2xl w-[900px] max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/50">
          <h2 className="text-sm font-medium text-zinc-200">评测中心</h2>

          {/* Tab navigation */}
          <div className="flex items-center gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={tab.onClick ?? (() => setMode(tab.key))}
                className={`px-2.5 py-1 rounded text-xs transition ${
                  mode === tab.key
                    ? 'bg-zinc-700 text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            onClick={handleClose}
            className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {mode === 'reports' && (
          <div className="flex-1 overflow-y-auto min-h-0">
            <TestResultsDashboard />
          </div>
        )}
        {mode === 'sessions' && (
          <div className="flex-1 overflow-hidden min-h-0">
            <SessionListView onSelectSession={() => {}} />
          </div>
        )}
        {mode === 'coding' && (
          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            <OpenCodingWorkbench
              cases={codingCases}
              onSave={handleSaveAnnotations}
            />
          </div>
        )}
      </div>
    </div>
  );
};
