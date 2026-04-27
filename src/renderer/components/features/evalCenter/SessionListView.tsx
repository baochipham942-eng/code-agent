// ============================================================================
// SessionListView - 会话列表 + 筛选（AgentsView 视觉风格）
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import {
  getReviewQueueFailureAssetStatusLabel,
  getReviewQueueFailureCapabilityLabel,
  getReviewQueueReasonLabel,
  getReviewQueueSourceLabel,
  type ReviewQueueFailureCapabilityAssetStatus,
} from '@shared/contract/reviewQueue';
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
    reviewQueue,
    reviewQueueLoading,
    loadReviewQueue,
    enqueueReviewItem,
    updateFailureAssetStatus,
    setFilterStatus,
    setSortBy,
  } = useEvalCenterStore();

  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    loadSessionList();
    loadReviewQueue();
  }, [loadSessionList, loadReviewQueue]);

  const queuedSessionIds = useMemo(
    () => new Set(reviewQueue.map((item) => item.sessionId)),
    [reviewQueue],
  );

  const handleQueueReview = async (sessionId: string, sessionTitle: string) => {
    await enqueueReviewItem({
      sessionId,
      sessionTitle,
      reason: 'manual_review',
      enqueueSource: 'session_list',
    });
  };

  const getFailureAssetActions = (
    status: ReviewQueueFailureCapabilityAssetStatus,
  ): Array<{ status: ReviewQueueFailureCapabilityAssetStatus; label: string }> => {
    switch (status) {
      case 'draft':
        return [
          { status: 'ready', label: '标记待应用' },
          { status: 'dismissed', label: '忽略' },
        ];
      case 'ready':
        return [
          { status: 'applied', label: '标记已应用' },
          { status: 'dismissed', label: '忽略' },
        ];
      case 'applied':
      case 'dismissed':
      default:
        return [];
    }
  };

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
      <div className="p-3 border-b border-zinc-700">
        <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center w-full"
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-sm">{'\u{1F4AC}'}</span>
              <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                会话列表
              </span>
              {stats.total > 0 && (
                <span className="text-xs text-zinc-500">({stats.total})</span>
              )}
            </div>
            <svg
              className={`w-3.5 h-3.5 text-zinc-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {expanded && (
            <div className="mt-3 space-y-3">
              {/* Stats summary - agent-style pills */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-700/60 text-zinc-400">
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
                            : 'text-zinc-500 hover:text-zinc-400 hover:bg-zinc-800'
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
                        onClick={(e) => { e.stopPropagation(); setSortBy(sort); }}
                        className={`text-[10px] px-2 py-1 rounded-lg transition-colors ${
                          sortBy === sort
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'text-zinc-500 hover:text-zinc-400 hover:bg-zinc-800'
                        }`}
                      >
                        {labels[sort]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pt-2 border-t border-white/[0.04]">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                    Review Queue
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {reviewQueue.length}
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-zinc-600">
                  当前支持手动加入，也支持从 Replay 的 Failure Follow-up 入口回流。
                </div>

                {reviewQueueLoading ? (
                  <div className="mt-2 text-[11px] text-zinc-600">
                    加载 review queue...
                  </div>
                ) : reviewQueue.length === 0 ? (
                  <div className="mt-2 text-[11px] text-zinc-600">
                    还没有待 review 的会话
                  </div>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {reviewQueue.slice(0, 5).map((item) => (
                      <div
                        key={item.id}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-900/70 px-2 py-2 text-left transition hover:border-zinc-700 hover:bg-zinc-800"
                      >
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelectSession(item.sessionId);
                          }}
                          className="w-full text-left"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[11px] font-medium text-zinc-300">
                              {item.sessionTitle}
                            </span>
                            <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
                              <Eye className="h-3 w-3" />
                              Replay
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-600">
                            <span>{getReviewQueueReasonLabel(item.reason)}</span>
                            <span>·</span>
                            <span>{getReviewQueueSourceLabel(item.enqueueSource ?? item.source)}</span>
                            {item.failureCapability && (
                              <>
                                <span>·</span>
                                <span className="text-amber-500">
                                  {getReviewQueueFailureCapabilityLabel(item.failureCapability)}
                                </span>
                              </>
                            )}
                            <span>·</span>
                            <span className="font-mono">{item.trace.traceId.replace('session:', '')}</span>
                          </div>
                        </button>
                        {item.failureAsset && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-800 pt-2 text-[10px]">
                            <span className="text-zinc-600">Asset</span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                              {getReviewQueueFailureAssetStatusLabel(item.failureAsset.status)}
                            </span>
                            {getFailureAssetActions(item.failureAsset.status).map((action) => (
                              <button
                                key={action.status}
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void updateFailureAssetStatus(item.id, action.status);
                                }}
                                className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
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
            <span className="text-sm text-zinc-500">加载会话中...</span>
          </div>
        )}

        {!sessionListLoading && filtered.length === 0 && (
          <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-12 h-12 rounded-2xl bg-zinc-700/60 border border-white/[0.04] flex items-center justify-center text-xl">
              {'\u{1F4AD}'}
            </div>
            <p className="text-sm text-zinc-500">暂无会话数据</p>
            <p className="text-xs text-zinc-600">开始一次对话后，会话将显示在这里</p>
          </div>
        )}

        {!sessionListLoading && filtered.map((session) => (
          <SessionListItem
            key={session.id}
            session={session}
            onClick={onSelectSession}
            isQueued={queuedSessionIds.has(session.id)}
            onQueueReview={handleQueueReview}
          />
        ))}

        {!sessionListLoading && filtered.length > 0 && (
          <div className="text-center py-3">
            <span className="text-[10px] text-zinc-600 px-3 py-1 rounded-full bg-zinc-800">
              共 {filtered.length} 个会话
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
