// ============================================================================
// EvalCenterPanel - 评测中心（3-Tab 重构：概览 + 深度评测 + 轮次详情）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import { EvalSessionHeader } from './EvalSessionHeader';
import { OverviewSection } from './OverviewSection';
import { DeepEvalSection } from './DeepEvalSection';
import { SessionListView } from './SessionListView';
import { TelemetryPanel } from '../telemetry';
import { ChevronLeft } from 'lucide-react';

type EvalTab = 'overview' | 'deepeval' | 'turns';

const TABS: Array<{ id: EvalTab; label: string; icon: string }> = [
  { id: 'overview', label: '概览', icon: '📊' },
  { id: 'deepeval', label: '深度评测', icon: '🧀' },
  { id: 'turns', label: '轮次详情', icon: '📡' },
];

export const EvalCenterPanel: React.FC = () => {
  const { showEvalCenter, evalCenterSessionId, setShowEvalCenter } = useAppStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { sessionInfo, objective, previousEvaluations, latestEvaluation, eventSummary, isLoading, loadSession } = useEvalCenterStore();

  // mode: 'list' (session list) or 'detail' (3-tab detail view)
  const [mode, setMode] = useState<'list' | 'detail'>('list');
  const [activeTab, setActiveTab] = useState<EvalTab>('overview');
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);

  // Determine which session to show
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
    setActiveTab('overview');
  };

  const handleBackToList = () => {
    setDetailSessionId(null);
    setMode('list');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-xl border border-zinc-700/50 shadow-2xl w-[900px] max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/50">
          <div className="flex items-center gap-2">
            {mode === 'detail' && (
              <button
                onClick={handleBackToList}
                className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <h2 className="text-sm font-medium text-zinc-200">
              {mode === 'list' ? '评测中心' : '评测中心 / 会话详情'}
            </h2>
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

        {mode === 'list' ? (
          /* Session List Mode */
          <div className="flex-1 overflow-hidden min-h-0">
            <SessionListView onSelectSession={handleSelectSession} />
          </div>
        ) : (
          /* Detail Mode with 3 Tabs */
          <>
            {/* Session Header (shared across tabs) */}
            <EvalSessionHeader sessionInfo={sessionInfo} isLoading={isLoading} />

            {/* Tab Bar */}
            <div className="flex border-b border-zinc-700/50">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs transition-colors border-b-2 ${
                      isActive
                        ? 'border-amber-500 text-amber-400'
                        : 'border-transparent text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <span>{tab.icon}</span>
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {!effectiveSessionId && (
                <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
                  请先选择一个会话
                </div>
              )}

              {effectiveSessionId && activeTab === 'overview' && (
                <div className="p-4">
                  <OverviewSection
                    objective={objective}
                    eventSummary={eventSummary}
                  />
                </div>
              )}

              {effectiveSessionId && activeTab === 'deepeval' && (
                <div className="p-4">
                  <DeepEvalSection
                    sessionId={effectiveSessionId}
                    previousEvaluations={previousEvaluations}
                    latestEvaluation={latestEvaluation as Parameters<typeof DeepEvalSection>[0]['latestEvaluation']}
                  />
                </div>
              )}

              {effectiveSessionId && activeTab === 'turns' && (
                <TelemetryPanel sessionId={effectiveSessionId} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
