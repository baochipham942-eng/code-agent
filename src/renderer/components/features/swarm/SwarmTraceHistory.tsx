// ============================================================================
// SwarmTraceHistory - Swarm 运行历史回看面板（ADR-010 #5）
// ============================================================================
//
// 最小可用版（对齐 LangSmith / Langfuse trace viewer v1）：
//   - List：按 started_at desc 拉取最近 N 个 swarm run，显示状态/agents/
//     duration/cost/tokens
//   - Detail：点击进入 → 显示该 run 的 timeline + per-agent rollup +
//     aggregation 摘要
//
// 不做：搜索、对比、全文检索、LLM 自动归因。这些是后续条目。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  CheckCircle,
  Clock,
  DollarSign,
  History,
  Loader2,
  RefreshCw,
  XCircle,
  Zap,
} from 'lucide-react';
import { invoke } from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc/legacy-channels';
import type {
  SwarmRunListItem,
  SwarmRunDetail,
  SwarmRunStatus,
} from '@shared/contract/swarmTrace';
import { formatDuration } from '../../../../shared/utils/format';

const STATUS_META: Record<
  SwarmRunStatus,
  { label: string; tone: string; icon: React.ReactNode }
> = {
  running: {
    label: '运行中',
    tone: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
  },
  completed: {
    label: '已完成',
    tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
    icon: <CheckCircle className="w-3 h-3" />,
  },
  failed: {
    label: '失败',
    tone: 'text-red-300 bg-red-500/10 border-red-500/30',
    icon: <XCircle className="w-3 h-3" />,
  },
  cancelled: {
    label: '已取消',
    tone: 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30',
    icon: <XCircle className="w-3 h-3" />,
  },
};

function formatTokens(n: number): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Props {
  /** 默认显示的 run 数量，对应 SWARM_TRACE.DEFAULT_LIST_LIMIT */
  limit?: number;
  /** 紧凑模式：用于嵌入侧边栏 */
  compact?: boolean;
}

export const SwarmTraceHistory: React.FC<Props> = ({ limit = 20, compact = false }) => {
  const [runs, setRuns] = useState<SwarmRunListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SwarmRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke(IPC_CHANNELS.SWARM_LIST_TRACE_RUNS, { limit });
      setRuns(Array.isArray(result) ? result : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  const loadDetail = useCallback(async (runId: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const result = await invoke(IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL, { runId });
      setDetail(result ?? null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedRunId) {
      void loadDetail(selectedRunId);
    } else {
      setDetail(null);
    }
  }, [selectedRunId, loadDetail]);

  const sectionPadding = compact ? 'px-3 py-2' : 'px-4 py-3';

  if (selectedRunId) {
    return (
      <SwarmRunDetailView
        runId={selectedRunId}
        detail={detail}
        loading={detailLoading}
        onBack={() => setSelectedRunId(null)}
        compact={compact}
      />
    );
  }

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04]">
      <div className={`${sectionPadding} flex items-center justify-between border-b border-white/[0.04]`}>
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-primary-400" />
          <span className="text-sm font-medium text-zinc-200">历史 Swarm 运行</span>
          <span className="text-xs text-zinc-500">({runs.length})</span>
        </div>
        <button
          type="button"
          onClick={() => void loadList()}
          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
          title="刷新"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-500/5 border-b border-red-500/20">
          加载失败: {error}
        </div>
      )}

      {!loading && runs.length === 0 && !error && (
        <div className="px-4 py-6 text-center text-xs text-zinc-500">
          暂无历史 swarm 运行
        </div>
      )}

      <div className="divide-y divide-white/[0.04] max-h-96 overflow-y-auto">
        {runs.map((run) => (
          <RunListRow key={run.id} run={run} onClick={() => setSelectedRunId(run.id)} />
        ))}
      </div>
    </div>
  );
};

const RunListRow: React.FC<{ run: SwarmRunListItem; onClick: () => void }> = ({ run, onClick }) => {
  const meta = STATUS_META[run.status];
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${meta.tone}`}
        >
          {meta.icon}
          {meta.label}
        </span>
        <span className="text-[11px] text-zinc-500 font-mono truncate">{run.id.slice(0, 8)}</span>
        <span className="ml-auto text-[11px] text-zinc-500">{formatTime(run.startedAt)}</span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <Stat label="agents" value={`${run.completedCount}/${run.totalAgents}`} />
        <Stat label="耗时" value={run.durationMs != null ? formatDuration(run.durationMs) : '—'} />
        <Stat label="tokens" value={formatTokens(run.totalTokensIn + run.totalTokensOut)} />
        <Stat label="cost" value={run.totalCostUsd > 0 ? `$${run.totalCostUsd.toFixed(4)}` : '—'} />
      </div>
    </button>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col">
    <span className="text-zinc-500">{label}</span>
    <span className="text-zinc-200 font-medium truncate">{value}</span>
  </div>
);

const SwarmRunDetailView: React.FC<{
  runId: string;
  detail: SwarmRunDetail | null;
  loading: boolean;
  onBack: () => void;
  compact: boolean;
}> = ({ runId, detail, loading, onBack, compact }) => {
  const sectionPadding = compact ? 'px-3 py-2' : 'px-4 py-3';
  const meta = detail ? STATUS_META[detail.run.status] : null;

  const sortedAgents = useMemo(() => {
    if (!detail) return [];
    return [...detail.agents].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  }, [detail]);

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04]">
      <div className={`${sectionPadding} flex items-center justify-between border-b border-white/[0.04]`}>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回列表
        </button>
        <div className="flex items-center gap-2">
          {meta && (
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${meta.tone}`}>
              {meta.icon}
              {meta.label}
            </span>
          )}
          <span className="text-[11px] text-zinc-500 font-mono">{runId.slice(0, 12)}</span>
        </div>
      </div>

      {loading && (
        <div className="px-4 py-6 text-center text-xs text-zinc-500 flex items-center justify-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
        </div>
      )}

      {!loading && !detail && (
        <div className="px-4 py-6 text-center text-xs text-zinc-500">未找到该 run</div>
      )}

      {!loading && detail && (
        <>
          {/* Run summary */}
          <div className={`${sectionPadding} grid grid-cols-2 gap-2 border-b border-white/[0.04]`}>
            <SummaryCell
              icon={<Clock className="w-3.5 h-3.5" />}
              label="开始"
              value={formatTime(detail.run.startedAt)}
            />
            <SummaryCell
              icon={<Activity className="w-3.5 h-3.5" />}
              label="耗时"
              value={
                detail.run.endedAt != null
                  ? formatDuration(detail.run.endedAt - detail.run.startedAt)
                  : '运行中'
              }
            />
            <SummaryCell
              icon={<Zap className="w-3.5 h-3.5" />}
              label="tokens"
              value={`${formatTokens(detail.run.totalTokensIn)} / ${formatTokens(detail.run.totalTokensOut)}`}
            />
            <SummaryCell
              icon={<DollarSign className="w-3.5 h-3.5" />}
              label="cost"
              value={detail.run.totalCostUsd > 0 ? `$${detail.run.totalCostUsd.toFixed(4)}` : '—'}
            />
          </div>

          {/* Aggregation summary */}
          {detail.run.aggregation && (
            <div className={`${sectionPadding} text-xs space-y-1 border-b border-white/[0.04]`}>
              <div className="text-zinc-500 uppercase tracking-wider text-[10px]">聚合摘要</div>
              <div className="text-zinc-300 line-clamp-3">{detail.run.aggregation.summary}</div>
              {detail.run.aggregation.filesChanged.length > 0 && (
                <div className="text-[11px] text-zinc-500">
                  变更文件 {detail.run.aggregation.filesChanged.length}：
                  <span className="text-zinc-300 font-mono ml-1">
                    {detail.run.aggregation.filesChanged.slice(0, 3).join('、')}
                    {detail.run.aggregation.filesChanged.length > 3 ? '...' : ''}
                  </span>
                </div>
              )}
            </div>
          )}

          {detail.run.errorSummary && (
            <div className="px-4 py-2 text-[11px] text-red-300 bg-red-500/5 border-b border-red-500/20">
              错误：{detail.run.errorSummary}
            </div>
          )}

          {/* Per-agent rollup */}
          <div className={sectionPadding}>
            <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-2">
              Agents ({sortedAgents.length})
            </div>
            <div className="space-y-1.5">
              {sortedAgents.map((a) => {
                const aMeta = STATUS_META[
                  (a.status === 'pending' || a.status === 'ready' || a.status === 'running'
                    ? 'running'
                    : a.status) as SwarmRunStatus
                ];
                return (
                  <div
                    key={a.agentId}
                    className="flex items-center gap-2 text-[11px] py-1 border-b border-white/[0.02] last:border-0"
                  >
                    <span
                      className={`inline-flex items-center gap-1 px-1 py-0.5 rounded border text-[9px] ${aMeta.tone}`}
                    >
                      {aMeta.icon}
                      {a.status}
                    </span>
                    <span className="text-zinc-200 font-medium truncate flex-1">{a.name || a.agentId}</span>
                    <span className="text-zinc-500 font-mono">
                      {formatTokens(a.tokensIn + a.tokensOut)} tok
                    </span>
                    <span className="text-zinc-500 font-mono">
                      {a.durationMs != null ? formatDuration(a.durationMs) : '—'}
                    </span>
                    {a.error && (
                      <span
                        className="text-red-400 truncate max-w-[80px]"
                        title={a.error}
                      >
                        {a.failureCategory ?? 'err'}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Timeline */}
          <div className={`${sectionPadding} border-t border-white/[0.04]`}>
            <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-2">
              Timeline ({detail.events.length})
            </div>
            <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
              {detail.events.map((e) => (
                <div
                  key={e.id}
                  className="flex items-start gap-2 text-[11px] py-0.5"
                >
                  <span className="text-zinc-600 font-mono w-12 flex-shrink-0">
                    +{((e.timestamp - detail.run.startedAt) / 1000).toFixed(1)}s
                  </span>
                  <span className={`font-medium flex-shrink-0 w-32 truncate ${
                    e.level === 'error' ? 'text-red-300' :
                    e.level === 'warn' ? 'text-amber-300' :
                    'text-zinc-300'
                  }`}>
                    {e.title}
                  </span>
                  <span className="text-zinc-500 truncate">{e.summary}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const SummaryCell: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="flex items-center gap-2">
    <span className="text-zinc-500">{icon}</span>
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <span className="text-xs text-zinc-200 font-medium truncate">{value}</span>
    </div>
  </div>
);

export default SwarmTraceHistory;
