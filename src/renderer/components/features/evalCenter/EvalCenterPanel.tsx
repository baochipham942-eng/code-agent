// ============================================================================
// EvalCenterPanel - 评测中心（合并会话评测 + 遥测）
// ============================================================================

import React from 'react';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { EvaluationPanelV2 } from '../evaluation/EvaluationPanelV2';
import { TelemetryPanel } from '../telemetry';

type EvalTab = 'analysis' | 'telemetry';

const TABS: Array<{ id: EvalTab; label: string; icon: string }> = [
  { id: 'analysis', label: '会话分析', icon: '🧀' },
  { id: 'telemetry', label: '会话遥测', icon: '📡' },
];

export const EvalCenterPanel: React.FC = () => {
  const { showEvalCenter, evalCenterTab, setShowEvalCenter } = useAppStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  if (!showEvalCenter) return null;

  const activeTab = evalCenterTab;

  const handleClose = () => setShowEvalCenter(false);

  const switchTab = (tab: EvalTab) => {
    setShowEvalCenter(true, tab);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-xl border border-zinc-700/50 shadow-2xl w-[900px] max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/50">
          <h2 className="text-sm font-medium text-zinc-200">评测中心</h2>
          <button
            onClick={handleClose}
            className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-zinc-700/50">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => switchTab(tab.id)}
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

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'analysis' && currentSessionId && (
            <EvaluationPanelV2
              sessionId={currentSessionId}
              onClose={handleClose}
              embedded
            />
          )}
          {activeTab === 'analysis' && !currentSessionId && (
            <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
              请先选择一个会话
            </div>
          )}
          {activeTab === 'telemetry' && (
            <TelemetryPanel sessionId={currentSessionId || undefined} />
          )}
        </div>
      </div>
    </div>
  );
};
