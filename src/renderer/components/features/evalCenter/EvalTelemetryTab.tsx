// ============================================================================
// EvalTelemetryTab - 评测中心「遥测」tab（会话遥测查看器，去外壳内嵌版）
//
// 契约：
// - 不含 FullScreenPage 外壳；作为评测中心 tab 内容挂载，页面框架由外层负责。
//   数据源与旧 TelemetryPanel（2026-07-03 孤儿清理删除）相同：telemetryStore +
//   telemetry:* IPC；本组件复活其「会话列表 → 会话详情（概览/轮次/时间线/工具）」
//   两级视图，文案全部走 i18n（t.telemetry.*，词典在 i18n/evalCenter.ts）。
// - v2 取舍：不带回旧面板的 AdminUserScopeSelect（跨用户范围筛选）与
//   CostCalendar（成本日历）——前者在评测中心 admin 门禁内收益低，后者组件已删；
//   需要时按同一数据源另起。
// - 实时性：订阅 telemetry:event 推送，isLive 开关沿用 store 语义。
// ============================================================================
import React, { useEffect, useState } from 'react';
import { BarChart3, List, Clock, Wrench, Radio, CircleOff } from 'lucide-react';
import { useTelemetryStore } from '../../../stores/telemetryStore';
import { useI18n } from '../../../hooks/useI18n';
import { BackButton } from '../shared/FullScreenPage';
import ipcService from '../../../services/ipcService';
import { SessionHeader } from '../telemetry/SessionHeader';
import { TurnList } from '../telemetry/TurnList';
import { TurnDetail } from '../telemetry/TurnDetail';
import { TimelineView } from '../telemetry/TimelineView';
import { ToolStats } from '../telemetry/ToolStats';
import { OverviewTab } from '../telemetry/OverviewTab';
import type { TelemetryPushEvent } from '@shared/contract/telemetry';

type SubTabId = 'overview' | 'turns' | 'timeline' | 'tools';

export const EvalTelemetryTab: React.FC = () => {
  const { t } = useI18n();
  const tm = t.telemetry;
  const [activeTab, setActiveTab] = useState<SubTabId>('overview');
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);

  const {
    sessions, currentSession, turns, events, selectedTurnDetail, toolStats, intentDistribution, isLive,
    loadSessions, loadSession, loadTurns, loadEvents, loadTurnDetail, loadToolStats, loadIntentDistribution,
    setLive, handlePushEvent,
  } = useTelemetryStore();

  const SUB_TABS: Array<{ id: SubTabId; label: string; icon: React.FC<{ className?: string }> }> = [
    { id: 'overview', label: tm.tabOverview, icon: BarChart3 },
    { id: 'turns', label: tm.tabTurns, icon: List },
    { id: 'timeline', label: tm.tabTimeline, icon: Clock },
    { id: 'tools', label: tm.tabTools, icon: Wrench },
  ];

  // 实时推送订阅（语义同旧 TelemetryPanel）。
  useEffect(() => {
    const unsubscribe = ipcService.on('telemetry:event' as const, (event) => {
      handlePushEvent(event as TelemetryPushEvent);
    });
    return () => {
      unsubscribe?.();
    };
  }, [handlePushEvent]);

  // 会话列表 / 会话详情数据加载。
  useEffect(() => {
    if (currentSession) {
      loadTurns(currentSession.id);
      loadEvents(currentSession.id);
      loadToolStats(currentSession.id);
      loadIntentDistribution(currentSession.id);
    } else {
      loadSessions();
    }
  }, [currentSession, loadSessions, loadTurns, loadEvents, loadToolStats, loadIntentDistribution]);

  useEffect(() => {
    if (selectedTurnId) {
      loadTurnDetail(selectedTurnId);
    }
  }, [selectedTurnId, loadTurnDetail]);

  // 列表视图。
  if (!currentSession) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="eval-telemetry-tab">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2">
          <h2 className="text-sm font-medium text-zinc-400">{tm.title}</h2>
          <button /* ds-allow:button: 遥测实时开关胶囊，10px 微尺寸行内样式，Button primitive 无对应变体 */
            type="button"
            onClick={() => setLive(!isLive)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] ${isLive ? 'bg-green-500/20 text-green-400' : 'bg-zinc-700 text-zinc-500'}`}
          >
            {isLive ? <Radio className="h-3 w-3" /> : <CircleOff className="h-3 w-3" />}
            {isLive ? tm.live : tm.paused}
          </button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {sessions.map((session) => (
            <button /* ds-allow:button: 遥测会话行（整块可点卡片），Button primitive 无行卡片变体 */
              key={session.id}
              type="button"
              onClick={() => loadSession(session.id)}
              className="w-full rounded-lg border border-transparent bg-zinc-800 p-2.5 text-left transition-colors hover:border-zinc-700"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="max-w-[240px] truncate text-xs text-zinc-400">{session.title}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${session.status === 'recording' ? 'bg-green-500/20 text-green-400' : 'bg-zinc-600/30 text-zinc-500'}`}>
                  {session.status === 'recording' ? tm.recording : tm.completed}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                <span>{session.modelProvider}/{session.modelName}</span>
                <span>{tm.turnsCount.replace('{n}', String(session.turnCount))}</span>
                <span>{Math.round(session.totalTokens / 1000)}K tokens</span>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="py-12 text-center text-sm text-zinc-500">{tm.empty}</div>
          )}
        </div>
      </div>
    );
  }

  // 详情视图。
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="eval-telemetry-tab">
      <div className="shrink-0 border-b border-zinc-800 p-2">
        {/* 返回列表与三级页 header 同款从属级返回（共享 BackButton，样式跟随 FullScreenPage） */}
        <BackButton
          onClick={() => useTelemetryStore.setState({ currentSession: null })}
          label={tm.backToList}
          className="mb-1"
        />
        <SessionHeader session={currentSession} />
      </div>

      <div className="flex shrink-0 border-b border-zinc-800" role="tablist">
        {SUB_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button /* ds-allow:button: 遥测详情子 tab（role=tab 分段控件），Button primitive 无 tab 语义变体 */
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-testid={`eval-telemetry-subtab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs transition-colors ${isActive ? 'border-blue-500 text-blue-400' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center pr-2">
          <button /* ds-allow:button: 遥测实时开关胶囊，同上 */
            type="button"
            onClick={() => setLive(!isLive)}
            aria-label={isLive ? tm.live : tm.paused}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] ${isLive ? 'bg-green-500/20 text-green-400' : 'bg-zinc-700 text-zinc-500'}`}
          >
            {isLive ? <Radio className="h-3 w-3" /> : <CircleOff className="h-3 w-3" />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {activeTab === 'overview' && (
          <OverviewTab session={currentSession} toolStats={toolStats} intentDistribution={intentDistribution} />
        )}
        {activeTab === 'turns' && (
          <div className="flex h-full gap-2">
            <div className="w-1/2">
              <TurnList turns={turns} selectedTurnId={selectedTurnId ?? undefined} onSelectTurn={setSelectedTurnId} />
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
                <div className="py-12 text-center text-sm text-zinc-500">{tm.pickTurn}</div>
              )}
            </div>
          </div>
        )}
        {activeTab === 'timeline' && <TimelineView events={events} />}
        {activeTab === 'tools' && <ToolStats stats={toolStats} />}
      </div>
    </div>
  );
};
