// ============================================================================
// EvalCenterPanel - 评测中心（单页 Dashboard 重构）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import { EvalSessionHeader } from './EvalSessionHeader';
import { EvalDashboard } from './EvalDashboard';
import { SessionListView } from './SessionListView';
import { ChevronLeft } from 'lucide-react';

export const EvalCenterPanel: React.FC = () => {
  const { showEvalCenter, evalCenterSessionId, setShowEvalCenter } = useAppStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { sessionInfo, isLoading, loadSession } = useEvalCenterStore();

  // mode: 'list' (session list) or 'detail' (dashboard)
  const [mode, setMode] = useState<'list' | 'detail'>('list');
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
          <div className="flex-1 overflow-hidden min-h-0">
            <SessionListView onSelectSession={handleSelectSession} />
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
              <EvalDashboard sessionId={effectiveSessionId} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
