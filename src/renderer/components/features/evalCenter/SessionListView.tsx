// ============================================================================
// SessionListView - 会话列表 + 筛选
// ============================================================================

import React, { useEffect, useMemo } from 'react';
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

  return (
    <div className="h-full flex flex-col">
      {/* Filter & Sort Bar */}
      <div className="flex items-center gap-3 p-3 border-b border-zinc-700/50">
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
                onClick={() => setFilterStatus(status)}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  filterStatus === status
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {labels[status]}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <span className="text-[10px] text-zinc-600 mr-1">排序:</span>
          {(['time', 'turns', 'cost'] as const).map((sort) => {
            const labels: Record<string, string> = {
              time: '时间',
              turns: '轮次',
              cost: '成本',
            };
            return (
              <button
                key={sort}
                onClick={() => setSortBy(sort)}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  sortBy === sort
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {labels[sort]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessionListLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full mr-2" />
            <span className="text-sm text-zinc-500">加载中...</span>
          </div>
        )}

        {!sessionListLoading && filtered.length === 0 && (
          <div className="text-center text-zinc-500 text-sm py-12">
            暂无会话数据
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
          <div className="text-center text-[10px] text-zinc-600 py-2">
            共 {filtered.length} 个会话
          </div>
        )}
      </div>
    </div>
  );
};
