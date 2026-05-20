import React, { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SwarmAgentState } from '@shared/contract/swarm';
import { formatDuration } from '../../../../shared/utils/format';
import type { SwarmPlanReview } from '../../../stores/swarmStore';
import ipcService from '../../../services/ipcService';
import {
  formatTokens,
  getUsageTextClass,
  getUsageToneClass,
} from './model';

export const Section: React.FC<{
  title: string;
  extra?: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}> = ({
  title,
  extra,
  defaultExpanded = true,
  children,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04]">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-3"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
        )}
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-400 flex-1 text-left">
          {title}
        </span>
        {extra}
      </button>

      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
};

export const MetricCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number;
  emphasis?: string;
}> = ({
  icon,
  label,
  value,
  emphasis = 'text-zinc-200',
}) => {
  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-sm font-medium ${emphasis}`}>{value}</div>
    </div>
  );
};

export const AgentLaneCard: React.FC<{
  agent: SwarmAgentState;
  onOpenTeam: (agentId: string) => void;
  onCancelAgent: (agentId: string) => void;
  onRetryAgent: (agentId: string) => void;
  canceling: boolean;
  retrying: boolean;
}> = ({
  agent,
  onOpenTeam,
  onCancelAgent,
  onRetryAgent,
  canceling,
  retrying,
}) => {
  const statusTone =
    agent.status === 'completed'
      ? 'border-emerald-500/20'
      : agent.status === 'failed'
      ? 'border-red-500/20'
      : agent.status === 'running'
      ? 'border-primary-500/20'
      : 'border-white/[0.04]';

  const duration = agent.startTime
    ? formatDuration((agent.endTime || Date.now()) - agent.startTime)
    : '待启动';

  return (
    <div className={`rounded-lg border ${statusTone} bg-zinc-800/70 p-3`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5">
          {agent.status === 'running' ? (
            <Loader2 className="w-4 h-4 text-primary-400 animate-spin" />
          ) : agent.status === 'completed' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          ) : agent.status === 'failed' ? (
            <XCircle className="w-4 h-4 text-red-400" />
          ) : (
            <Clock className="w-4 h-4 text-zinc-500" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-zinc-100 truncate">{agent.name}</div>
            <span className="rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              {agent.role}
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            {agent.lastReport || agent.resultPreview || agent.error || '等待任务分配'}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-zinc-500">
        <span className="rounded bg-zinc-900/70 px-1.5 py-0.5">{duration}</span>
        <span className="rounded bg-zinc-900/70 px-1.5 py-0.5">{agent.iterations} iter</span>
        {typeof agent.toolCalls === 'number' && (
          <span className="rounded bg-zinc-900/70 px-1.5 py-0.5">{agent.toolCalls} tools</span>
        )}
        {agent.tokenUsage && (
          <span className="rounded bg-zinc-900/70 px-1.5 py-0.5">
            {formatTokens(agent.tokenUsage.input + agent.tokenUsage.output)} tokens
          </span>
        )}
      </div>

      {agent.contextSnapshot && (
        <div className="mt-3 rounded-lg border border-white/[0.04] bg-zinc-900/70 px-2.5 py-2">
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`${getUsageTextClass(agent.contextSnapshot.usagePercent)}`}>
              ctx {agent.contextSnapshot.usagePercent.toFixed(1)}%
            </span>
            <span className="text-zinc-500">{agent.contextSnapshot.messageCount} msgs</span>
            {agent.contextSnapshot.truncatedMessages > 0 && (
              <span className="text-amber-300">
                {agent.contextSnapshot.truncatedMessages} truncated
              </span>
            )}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full ${getUsageToneClass(agent.contextSnapshot.usagePercent)}`}
              style={{ width: `${Math.min(100, agent.contextSnapshot.usagePercent)}%` }}
            />
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onOpenTeam(agent.id)}
          className="rounded-md border border-white/[0.06] bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-primary-500/20 hover:text-zinc-100"
        >
          对话
        </button>
        {agent.status === 'running' && (
          <button
            onClick={() => onCancelAgent(agent.id)}
            disabled={canceling}
            className="rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {canceling ? '取消中…' : '取消'}
          </button>
        )}
        {(agent.status === 'failed' || agent.status === 'cancelled') && (
          <button
            onClick={() => onRetryAgent(agent.id)}
            disabled={retrying}
            className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300 transition-colors hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {retrying ? '重试中…' : '重试'}
          </button>
        )}
      </div>

      {agent.filesChanged && agent.filesChanged.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {agent.filesChanged.slice(0, 4).map((file) => (
            <span
              key={file}
              className="rounded bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
              title={file}
            >
              {file.split('/').pop()}
            </span>
          ))}
          {agent.filesChanged.length > 4 && (
            <span className="text-[10px] text-zinc-600">+{agent.filesChanged.length - 4}</span>
          )}
        </div>
      )}
    </div>
  );
};

export const AgentContextCard: React.FC<{
  agent: SwarmAgentState;
}> = ({ agent }) => {
  const snapshot = agent.contextSnapshot;
  if (!snapshot) return null;

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium text-zinc-100 truncate">{agent.name}</div>
        <span className="rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
          {agent.role}
        </span>
        <span className={`ml-auto text-[11px] ${getUsageTextClass(snapshot.usagePercent)}`}>
          {snapshot.usagePercent.toFixed(1)}%
        </span>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-900/80">
        <div
          className={`h-full rounded-full ${getUsageToneClass(snapshot.usagePercent)}`}
          style={{ width: `${Math.min(100, snapshot.usagePercent)}%` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          预算 <span className="ml-1 text-zinc-200">{formatTokens(snapshot.currentTokens)} / {formatTokens(snapshot.maxTokens)}</span>
        </div>
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          消息 <span className="ml-1 text-zinc-200">{snapshot.messageCount}</span>
        </div>
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          警告 <span className={`ml-1 ${getUsageTextClass(snapshot.usagePercent)}`}>{snapshot.warningLevel}</span>
        </div>
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          压缩 <span className="ml-1 text-zinc-200">{snapshot.truncatedMessages}</span>
        </div>
      </div>

      {(snapshot.tools.length > 0 || snapshot.attachments.length > 0) && (
        <div className="mt-3 space-y-2">
          {snapshot.tools.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Tools</div>
              <div className="flex flex-wrap gap-1.5">
                {snapshot.tools.map((name) => (
                  <span
                    key={`${agent.id}-tool-${name}`}
                    className="rounded bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {snapshot.attachments.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Attachments</div>
              <div className="flex flex-wrap gap-1.5">
                {snapshot.attachments.map((name) => (
                  <span
                    key={`${agent.id}-attachment-${name}`}
                    className="rounded bg-zinc-900/80 px-1.5 py-0.5 text-[10px] text-zinc-300"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {snapshot.previews.length > 0 && (
        <div className="mt-3 space-y-2">
          {snapshot.previews.map((preview, index) => (
            <div
              key={`${agent.id}-preview-${preview.role}-${index}`}
              className="rounded border border-white/[0.04] bg-zinc-900/70 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                  {preview.role}
                </span>
                <span className="ml-auto text-[10px] text-zinc-500">{formatTokens(preview.tokens)} tokens</span>
              </div>
              <div className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">
                {preview.contentPreview || '空消息'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const ApprovalCard: React.FC<{ review: SwarmPlanReview }> = ({ review }) => {
  const [feedback, setFeedback] = useState(review.feedback || '');
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badgeClass =
    review.status === 'pending'
      ? 'bg-amber-500/15 text-amber-300'
      : review.status === 'approved'
      ? 'bg-emerald-500/15 text-emerald-300'
      : 'bg-red-500/15 text-red-300';

  const handleApprove = async () => {
    setSubmitting('approve');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_APPROVE_PLAN, {
        planId: review.id,
        feedback: feedback.trim() || undefined,
      });
      if (!success) {
        setError('审批失败，计划可能已被处理。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '审批失败');
    } finally {
      setSubmitting(null);
    }
  };

  const handleReject = async () => {
    const trimmed = feedback.trim();
    if (!trimmed) {
      setError('驳回时需要填写原因。');
      return;
    }

    setSubmitting('reject');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_REJECT_PLAN, {
        planId: review.id,
        feedback: trimmed,
      });
      if (!success) {
        setError('驳回失败，计划可能已被处理。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '驳回失败');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-400" />
        <div className="text-sm text-zinc-200">Agent {review.agentId}</div>
        <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${badgeClass}`}>
          {review.status === 'pending' ? '待处理' : review.status === 'approved' ? '已通过' : '已驳回'}
        </span>
      </div>
      {review.content && (
        <div className="mt-2 text-xs leading-5 text-zinc-400 line-clamp-4">{review.content}</div>
      )}
      {review.status === 'pending' && (
        <div className="mt-3 space-y-2">
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="可选反馈；驳回时填写原因"
            className="min-h-[72px] w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900/80 px-2.5 py-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none transition-colors focus:border-primary-500/40"
          />
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleApprove}
              disabled={submitting !== null}
              className="rounded-md bg-emerald-500/15 px-2.5 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting === 'approve' ? '通过中…' : '通过'}
            </button>
            <button
              onClick={handleReject}
              disabled={submitting !== null}
              className="rounded-md bg-red-500/15 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting === 'reject' ? '驳回中…' : '驳回'}
            </button>
          </div>
        </div>
      )}
      {review.feedback && (
        <div className="mt-2 rounded bg-zinc-900/80 px-2 py-1.5 text-xs text-zinc-400">
          {review.feedback}
        </div>
      )}
    </div>
  );
};
