// ============================================================================
// Telemetry Panel - 遥测主面板（4 Tab）
// ============================================================================

import React, { useEffect, useState } from 'react';
import { useTelemetryStore } from '../../../stores/telemetryStore';
import { SessionHeader } from './SessionHeader';
import { TurnList } from './TurnList';
import { TurnDetail } from './TurnDetail';
import { TimelineView } from './TimelineView';
import { ToolStats } from './ToolStats';
import { OverviewTab } from './OverviewTab';
import { BarChart3, List, Clock, Wrench, Radio, CircleOff, ChevronLeft } from 'lucide-react';

interface TelemetryPanelProps {
  sessionId?: string;
}

type TabId = 'overview' | 'turns' | 'timeline' | 'tools';

const TABS: Array<{ id: TabId; label: string; icon: React.FC<{ className?: string }> }> = [
  { id: 'overview', label: '概览', icon: BarChart3 },
  { id: 'turns', label: '轮次', icon: List },
  { id: 'timeline', label: '时间线', icon: Clock },
  { id: 'tools', label: '工具', icon: Wrench },
];

export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({ sessionId: propSessionId }) => {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);

  const {
    sessions,
    currentSession,
    turns,
    selectedTurnDetail,
    toolStats,
    intentDistribution,
    isLive,
    loadSessions,
    loadSession,
    loadTurns,
    loadTurnDetail,
    loadToolStats,
    loadIntentDistribution,
    setLive,
    handlePushEvent,
  } = useTelemetryStore();

  // Subscribe to IPC events
  useEffect(() => {
    const unsubscribe = window.electronAPI?.on('telemetry:event' as 'telemetry:event', (event) => {
      handlePushEvent(event as Parameters<typeof handlePushEvent>[0]);
    });
    return () => {
      unsubscribe?.();
    };
  }, [handlePushEvent]);

  // Load session data
  useEffect(() => {
    if (propSessionId) {
      loadSession(propSessionId);
      loadTurns(propSessionId);
      loadToolStats(propSessionId);
      loadIntentDistribution(propSessionId);
    } else {
      loadSessions();
    }
  }, [propSessionId, loadSession, loadTurns, loadToolStats, loadIntentDistribution, loadSessions]);

  // Load turn detail when selected
  useEffect(() => {
    if (selectedTurnId) {
      loadTurnDetail(selectedTurnId);
    }
  }, [selectedTurnId, loadTurnDetail]);

  // If no session selected, show session list
  if (!currentSession && !propSessionId) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-zinc-700/50">
          <h2 className="text-sm font-medium text-zinc-300">会话遥测</h2>
          <button
            onClick={() => setLive(!isLive)}
            className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded ${
              isLive ? 'bg-green-500/20 text-green-400' : 'bg-zinc-700/50 text-zinc-500'
            }`}
          >
            {isLive ? <Radio className="w-3 h-3" /> : <CircleOff className="w-3 h-3" />}
            {isLive ? '实时' : '暂停'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => loadSession(session.id)}
              className="w-full text-left p-2.5 bg-zinc-800/30 rounded-lg border border-transparent hover:border-zinc-700/50 hover:bg-zinc-800/50 transition-colors"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-300 truncate max-w-[200px]">{session.title}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  session.status === 'recording' ? 'bg-green-500/20 text-green-400' : 'bg-zinc-600/30 text-zinc-500'
                }`}>
                  {session.status === 'recording' ? '录制中' : '已完成'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                <span>{session.modelProvider}/{session.modelName}</span>
                <span>{session.turnCount} 轮</span>
                <span>{Math.round(session.totalTokens / 1000)}K tokens</span>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="text-center text-zinc-500 text-sm py-12">
              暂无遥测数据
            </div>
          )}
        </div>
      </div>
    );
  }

  // Collect all events from turns for timeline view
  const allEvents = turns.flatMap(t => t.events ?? []).sort((a, b) => a.timestamp - b.timestamp);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-2 border-b border-zinc-700/50">
        {!propSessionId && (
          <button
            onClick={() => useTelemetryStore.setState({ currentSession: null })}
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 mb-1"
          >
            <ChevronLeft className="w-3 h-3" />
            返回列表
          </button>
        )}
        {currentSession && <SessionHeader session={currentSession} />}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-700/50">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors border-b-2 ${
                isActive
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}

        {/* Live indicator */}
        <div className="ml-auto flex items-center pr-2">
          <button
            onClick={() => setLive(!isLive)}
            className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded ${
              isLive ? 'bg-green-500/20 text-green-400' : 'bg-zinc-700/50 text-zinc-500'
            }`}
          >
            {isLive ? <Radio className="w-3 h-3" /> : <CircleOff className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-2">
        {activeTab === 'overview' && currentSession && (
          <OverviewTab
            session={currentSession}
            toolStats={toolStats}
            intentDistribution={intentDistribution}
          />
        )}

        {activeTab === 'turns' && (
          <div className="flex gap-2 h-full">
            <div className="w-1/2">
              <TurnList
                turns={turns}
                selectedTurnId={selectedTurnId ?? undefined}
                onSelectTurn={setSelectedTurnId}
              />
            </div>
            <div className="w-1/2">
              {selectedTurnDetail ? (
                <TurnDetail
                  turn={selectedTurnDetail.turn}
                  modelCalls={selectedTurnDetail.modelCalls}
                  toolCalls={selectedTurnDetail.toolCalls}
                  events={selectedTurnDetail.events}
                />
              ) : (
                <div className="text-center text-zinc-500 text-sm py-12">
                  选择一个轮次查看详情
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'timeline' && (
          <TimelineView events={allEvents} />
        )}

        {activeTab === 'tools' && (
          <ToolStats stats={toolStats} />
        )}
      </div>
    </div>
  );
};
