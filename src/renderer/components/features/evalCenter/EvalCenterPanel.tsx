// ============================================================================
// EvalCenterPanel - 评测中心（全页面布局：左侧导航 + 7 页面）
// ============================================================================

import React, { useState } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { TestResultsDashboard } from './testResults/TestResultsDashboard';
import { TestCaseManager } from './pages/TestCaseManager';
import { ScoringConfigPage } from './pages/ScoringConfigPage';
import { ExperimentDetailPage } from './pages/ExperimentDetailPage';
import { FailureAnalysisPage } from './pages/FailureAnalysisPage';
import { CrossExperimentPage } from './pages/CrossExperimentPage';
import { SessionListView } from './SessionListView';
import { SessionEvalView } from './pages/SessionEvalView';

type NavItem = 'sessions' | 'overview' | 'test-cases' | 'scoring' | 'detail' | 'failure' | 'compare';

const NAV_ITEMS: Array<{ key: NavItem; icon: string; label: string }> = [
  { key: 'sessions', icon: '💬', label: '会话评测' },
  { key: 'overview', icon: '📊', label: '实验总览' },
  { key: 'test-cases', icon: '📋', label: '测试集' },
  { key: 'scoring', icon: '⚙️', label: '评分配置' },
  { key: 'detail', icon: '🔬', label: '实验详情' },
  { key: 'failure', icon: '🔍', label: '失败分析' },
  { key: 'compare', icon: '📈', label: '对比分析' },
];

export const EvalCenterPanel: React.FC = () => {
  const { showEvalCenter, setShowEvalCenter } = useAppStore();
  const [activeNav, setActiveNav] = useState<NavItem>('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const handleClose = () => setShowEvalCenter(false);

  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
  };

  const handleBackToSessions = () => {
    setSelectedSessionId(null);
  };

  if (!showEvalCenter) return null;

  return (
    <div className="w-full h-full flex flex-col bg-deep">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default shrink-0">
          <h2 className="text-sm font-medium text-text-primary">评测中心</h2>
          <button
            onClick={handleClose}
            className="p-1 text-text-tertiary hover:text-text-secondary hover:bg-hover rounded transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body: sidebar + main */}
        <div className="flex flex-1 min-h-0">
          {/* Left sidebar */}
          <div className="w-[160px] shrink-0 bg-deep border-r border-border-default py-2 flex flex-col gap-0.5">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => {
                  setActiveNav(item.key);
                  if (item.key !== 'sessions') {
                    setSelectedSessionId(null);
                  }
                }}
                className={`flex items-center gap-2 px-3 py-2 mx-1 rounded text-xs transition ${
                  activeNav === item.key
                    ? 'bg-hover text-text-primary'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-surface'
                }`}
              >
                <span className="text-sm">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          {/* Main content */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {activeNav === 'sessions' && (
              selectedSessionId ? (
                <SessionEvalView
                  sessionId={selectedSessionId}
                  onBack={handleBackToSessions}
                />
              ) : (
                <SessionListView onSelectSession={handleSelectSession} />
              )
            )}
            {activeNav === 'overview' && <TestResultsDashboard />}
            {activeNav === 'test-cases' && <TestCaseManager />}
            {activeNav === 'scoring' && <ScoringConfigPage />}
            {activeNav === 'detail' && <ExperimentDetailPage />}
            {activeNav === 'failure' && <FailureAnalysisPage />}
            {activeNav === 'compare' && <CrossExperimentPage />}
          </div>
        </div>
    </div>
  );
};
