// ============================================================================
// EvalCenterPanel - 评测中心（单页 Dashboard 重构）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import { EvalSessionHeader } from './EvalSessionHeader';
import { EvalDashboard } from './EvalDashboard';
import { SessionListView } from './SessionListView';
import { SessionReplayView } from './SessionReplayView';
import { OpenCodingWorkbench } from './testResults/OpenCodingWorkbench';
import type { CaseAnnotation } from './testResults/OpenCodingWorkbench';
import type { TestRunReport, TestCaseResult } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@shared/ipc';
import { ChevronLeft } from 'lucide-react';

export const EvalCenterPanel: React.FC = () => {
  const { showEvalCenter, evalCenterSessionId, setShowEvalCenter } = useAppStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { sessionInfo, isLoading, loadSession } = useEvalCenterStore();

  // mode: 'list' (session list), 'detail' (dashboard), 'replay' (structured replay), or 'coding' (open coding annotation)
  const [mode, setMode] = useState<'list' | 'detail' | 'replay' | 'coding'>('list');
  const [codingCases, setCodingCases] = useState<TestCaseResult[]>([]);
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);

  const effectiveSessionId = detailSessionId || evalCenterSessionId || currentSessionId;

  // Auto-enter detail mode if we have a session
  useEffect(() => {
    if (evalCenterSessionId) {
      setDetailSessionId(evalCenterSessionId);
      setMode('detail');
    } else if (currentSessionId) {
      setDetailSessionId(currentSessionId);
      setMode('detail');
    } else {
      setMode('list');
    }
  }, [evalCenterSessionId, currentSessionId]);

  // Load session data when entering detail mode
  useEffect(() => {
    if (mode === 'detail' && effectiveSessionId) {
      loadSession(effectiveSessionId);
    }
  }, [mode, effectiveSessionId, loadSession]);

  if (!showEvalCenter) return null;

  const handleClose = () => setShowEvalCenter(false);

  const handleSelectSession = (sessionId: string) => {
    setDetailSessionId(sessionId);
    setMode('detail');
  };

  const handleBackToList = () => {
    setDetailSessionId(null);
    setMode('list');
  };

  const handleEnterReplay = () => {
    setMode('replay');
  };

  const handleBackToDetail = () => {
    setMode('detail');
  };

  // Load latest report and enter coding mode
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-xl border border-zinc-700/50 shadow-2xl w-[900px] max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/50">
          <div className="flex items-center gap-2">
            {(mode === 'detail' || mode === 'replay' || mode === 'coding') && (
              <button
                onClick={
                  mode === 'replay' ? handleBackToDetail :
                  mode === 'coding' ? handleBackToList :
                  handleBackToList
                }
                className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <h2 className="text-sm font-medium text-zinc-200">
              {mode === 'list' ? '评测中心' :
               mode === 'detail' ? '评测中心 / 会话详情' :
               mode === 'replay' ? '评测中心 / 会话回放' :
               '评测中心 / 标注工作台'}
            </h2>
          </div>
          {/* Mode navigation tabs */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMode('list')}
              className={`px-2.5 py-1 rounded text-xs transition ${
                mode === 'list'
                  ? 'bg-zinc-700 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              📋 列表
            </button>
            <button
              onClick={handleEnterCoding}
              className={`px-2.5 py-1 rounded text-xs transition ${
                mode === 'coding'
                  ? 'bg-zinc-700 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              📝 标注
            </button>
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

        {mode === 'coding' ? (
          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            <OpenCodingWorkbench
              cases={codingCases}
              onSave={handleSaveAnnotations}
            />
          </div>
        ) : mode === 'list' ? (
          <div className="flex-1 overflow-hidden min-h-0">
            <SessionListView onSelectSession={handleSelectSession} />
          </div>
        ) : mode === 'replay' ? (
          <div className="flex-1 overflow-hidden min-h-0">
            {effectiveSessionId ? (
              <SessionReplayView sessionId={effectiveSessionId} />
            ) : (
              <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
                请先选择一个会话
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Session Header */}
            <EvalSessionHeader sessionInfo={sessionInfo} isLoading={isLoading} />

            {!effectiveSessionId ? (
              <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
                请先选择一个会话
              </div>
            ) : (
              <EvalDashboard sessionId={effectiveSessionId} onEnterReplay={handleEnterReplay} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
