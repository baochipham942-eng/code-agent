// ============================================================================
// SessionListView - 会话列表 + 筛选（AgentsView 视觉风格）
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import { SessionListItem } from './SessionListItem';

interface SessionListViewProps {
  onSelectSession: (sessionId: string) => void;
}

export const SessionListView: React.FC<SessionListViewProps> = ({ onSelectSession }) => {
  const {
    sessionList,
    sessionListLoading,
    filterStatus,
    sortBy,
    loadSessionList,
    setFilterStatus,
    setSortBy,
  } = useEvalCenterStore();

  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    loadSessionList();
  }, [loadSessionList]);

  const filtered = useMemo(() => {
    let list = [...sessionList];

    // Filter
    if (filterStatus !== 'all') {
      list = list.filter(s => s.status === filterStatus);
    }

    // Sort
    switch (sortBy) {
      case 'turns':
        list.sort((a, b) => b.turnCount - a.turnCount);
        break;
      case 'cost':
        list.sort((a, b) => b.estimatedCost - a.estimatedCost);
        break;
      case 'time':
      default:
        list.sort((a, b) => b.startTime - a.startTime);
        break;
    }

    return list;
  }, [sessionList, filterStatus, sortBy]);

  // Stats
  const stats = useMemo(() => {
    const total = sessionList.length;
    const completed = sessionList.filter(s => s.status === 'completed').length;
    const recording = sessionList.filter(s => s.status === 'recording').length;
    const errors = sessionList.filter(s => s.status === 'error').length;
    return { total, completed, recording, errors };
  }, [sessionList]);

  return (
    <div className="h-full flex flex-col">
      {/* Header card - AgentsView style */}
      <div className="p-3 border-b border-border-default">
        <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center w-full"
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-sm">{'\u{1F4AC}'}</span>
              <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                会话列表
              </span>
              {stats.total > 0 && (
                <span className="text-xs text-text-tertiary">({stats.total})</span>
              )}
            </div>
            <svg
              className={`w-3.5 h-3.5 text-text-tertiary flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {expanded && (
            <div className="mt-3 space-y-3">
              {/* Stats summary - agent-style pills */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-elevated/60 text-text-secondary">
                  {'\u2705'} {stats.completed} 已完成
                </span>
                {stats.recording > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">
                    {'\u{1F534}'} {stats.recording} 录制中
                  </span>
                )}
                {stats.errors > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-400">
                    {'\u274C'} {stats.errors} 错误
                  </span>
                )}
              </div>

              {/* Filter & Sort */}
              <div className="flex items-center gap-3 pt-2 border-t border-white/[0.04]">
                <div className="flex items-center gap-1">
                  {(['all', 'recording', 'completed', 'error'] as const).map((status) => {
                    const labels: Record<string, string> = {
                      all: '全部',
                      recording: '录制中',
                      completed: '已完成',
                      error: '错误',
                    };
                    return (
                      <button
                        key={status}
                        onClick={(e) => { e.stopPropagation(); setFilterStatus(status); }}
                        className={`text-[10px] px-2 py-1 rounded-lg transition-colors ${
                          filterStatus === status
                            ? 'bg-blue-500/20 text-blue-400'
                            : 'text-text-tertiary hover:text-text-secondary hover:bg-surface'
                        }`}
                      >
                        {labels[status]}
                      </button>
                    );
                  })}
                </div>

                <div className="ml-auto flex items-center gap-1">
                  <span className="text-[10px] text-text-disabled mr-1">排序:</span>
                  {(['time', 'turns', 'cost'] as const).map((sort) => {
                    const labels: Record<string, string> = {
                      time: '时间',
                      turns: '轮次',
                      cost: '成本',
                    };
                    return (
                      <button
                        key={sort}
                        onClick={(e) => { e.stopPropagation(); setSortBy(sort); }}
                        className={`text-[10px] px-2 py-1 rounded-lg transition-colors ${
                          sortBy === sort
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'text-text-tertiary hover:text-text-secondary hover:bg-surface'
                        }`}
                      >
                        {labels[sort]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {sessionListLoading && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <svg
              className="animate-spin w-6 h-6 text-blue-400"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-text-tertiary">加载会话中...</span>
          </div>
        )}

        {!sessionListLoading && filtered.length === 0 && (
          <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-12 h-12 rounded-2xl bg-elevated/60 border border-white/[0.04] flex items-center justify-center text-xl">
              {'\u{1F4AD}'}
            </div>
            <p className="text-sm text-text-tertiary">暂无会话数据</p>
            <p className="text-xs text-text-disabled">开始一次对话后，会话将显示在这里</p>
          </div>
        )}

        {!sessionListLoading && filtered.map((session) => (
          <SessionListItem
            key={session.id}
            session={session}
            onClick={onSelectSession}
          />
        ))}

        {!sessionListLoading && filtered.length > 0 && (
          <div className="text-center py-3">
            <span className="text-[10px] text-text-disabled px-3 py-1 rounded-full bg-surface">
              共 {filtered.length} 个会话
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
