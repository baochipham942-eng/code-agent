// ============================================================================
// Orchestration - Multi-agent orchestration visualization for TaskPanel
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  GitBranch,
  Loader2,
  MessageSquare,
  MessageSquareText,
  ShieldAlert,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Message } from '@shared/types';
import type { SwarmLaunchRequest } from '@shared/types/swarm';
import { formatDuration } from '../../../shared/utils/format';
import {
  useSwarmStore,
  type SwarmExecutionPhase,
  type SwarmPlanReview,
  type SwarmTimelineEvent,
} from '../../stores/swarmStore';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import ipcService from '../../services/ipcService';
import SwarmDependencyMap from './SwarmDependencyMap';
import { ContextInterventionPanel } from './ContextInterventionPanel';
import { ContextProvenancePanel } from './ContextProvenancePanel';
import type {
  ContextInterventionAction,
  ContextProvenanceListEntry,
  ContextViewResponse,
} from '@shared/types/contextView';

const phaseMeta: Record<SwarmExecutionPhase, { label: string; className: string }> = {
  idle: { label: '空闲', className: 'bg-zinc-700/60 text-zinc-300' },
  planning: { label: '编排中', className: 'bg-blue-500/15 text-blue-300' },
  waiting_approval: { label: '等审批', className: 'bg-amber-500/15 text-amber-300' },
  executing: { label: '执行中', className: 'bg-primary-500/15 text-primary-300' },
  completed: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: '失败', className: 'bg-red-500/15 text-red-300' },
  cancelled: { label: '已取消', className: 'bg-zinc-700/60 text-zinc-300' },
};

const toneClassMap: Record<SwarmTimelineEvent['tone'], string> = {
  neutral: 'border-zinc-700 bg-zinc-800/70 text-zinc-300',
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200',
  warning: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  error: 'border-red-500/25 bg-red-500/10 text-red-200',
};

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

interface ContextSourceSummary {
  attachments: string[];
  tools: string[];
}

interface ContextTimelineEntry {
  id: string;
  title: string;
  summary: string;
  timestamp: number;
  tone: 'neutral' | 'success' | 'warning';
}

function isContextViewResponse(value: unknown): value is ContextViewResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ContextViewResponse>;
  return (
    typeof candidate.totalTokens === 'number'
    && typeof candidate.maxTokens === 'number'
    && typeof candidate.usagePercent === 'number'
    && typeof candidate.messageCount === 'number'
    && Array.isArray(candidate.contextItems)
  );
}

function getUsageToneClass(percent: number): string {
  if (percent >= 85) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function getUsageTextClass(percent: number): string {
  if (percent >= 85) return 'text-red-300';
  if (percent >= 70) return 'text-amber-300';
  return 'text-emerald-300';
}

function summarizeContextSources(messages: Message[]): ContextSourceSummary {
  const attachments = new Set<string>();
  const tools = new Set<string>();

  for (const message of messages.slice(-20)) {
    for (const attachment of message.attachments ?? []) {
      attachments.add(attachment.name);
    }
    for (const toolCall of message.toolCalls ?? []) {
      tools.add(toolCall.name);
    }
  }

  return {
    attachments: Array.from(attachments).slice(0, 6),
    tools: Array.from(tools).slice(0, 6),
  };
}

function formatCommitLabel(operation: string, layer: string): string {
  const operationMap: Record<string, string> = {
    truncate: '截断',
    snip: '裁剪',
    compact: '压缩',
    collapse: '折叠',
    drain: '抽离',
    reset: '重置',
  };

  const layerMap: Record<string, string> = {
    'tool-result-budget': 'tool budget',
    snip: 'snip',
    microcompact: 'microcompact',
    contextCollapse: 'collapse',
    autocompact: 'autocompact',
    'overflow-recovery': 'overflow',
    system: 'system',
  };

  return `${operationMap[operation] || operation} · ${layerMap[layer] || layer}`;
}

function buildContextTimeline(
  messages: Message[],
  contextView: ContextViewResponse | null,
  contextHealth: NonNullable<ReturnType<typeof useAppStore.getState>['contextHealth']> | null,
): ContextTimelineEntry[] {
  const entries: ContextTimelineEntry[] = [];

  for (const commit of contextView?.recentCommits ?? []) {
    entries.push({
      id: `commit-${commit.timestamp}-${commit.layer}-${commit.operation}`,
      title: formatCommitLabel(commit.operation, commit.layer),
      summary: commit.targetCount > 0 ? `影响 ${commit.targetCount} 条消息` : '系统级上下文调整',
      timestamp: commit.timestamp,
      tone: commit.operation === 'reset' ? 'neutral' : 'warning',
    });
  }

  const recentMessages = messages.slice(-8);
  recentMessages.forEach((message, index) => {
    const timestamp = message.timestamp ?? Date.now() - (recentMessages.length - index) * 1000;
    const attachmentCount = message.attachments?.length ?? 0;
    const toolNames = (message.toolCalls ?? []).map((toolCall) => toolCall.name);

    if (attachmentCount > 0) {
      entries.push({
        id: `attachment-${message.id}`,
        title: '附件进入上下文',
        summary: `${attachmentCount} 个附件被带入当前会话`,
        timestamp,
        tone: 'neutral',
      });
    }

    if (toolNames.length > 0) {
      entries.push({
        id: `tools-${message.id}`,
        title: '工具结果进入上下文',
        summary: toolNames.slice(0, 3).join(', '),
        timestamp,
        tone: 'neutral',
      });
    }
  });

  if (contextView && contextView.usagePercent >= 70) {
    entries.push({
      id: `budget-${contextView.usagePercent}`,
      title: contextView.usagePercent >= 85 ? '上下文预算告急' : '上下文预算升高',
      summary: `当前已使用 ${contextView.usagePercent.toFixed(1)}%，剩余 ${Math.max(0, 100 - contextView.usagePercent).toFixed(1)}%`,
      timestamp: recentMessages[recentMessages.length - 1]?.timestamp ?? Date.now(),
      tone: contextView.usagePercent >= 85 ? 'warning' : 'neutral',
    });
  }

  if (contextHealth?.compression?.lastCompressionAt) {
    entries.push({
      id: `health-compression-${contextHealth.compression.lastCompressionAt}`,
      title: '自动压缩生效',
      summary: `累计节省 ${formatTokens(contextHealth.compression.totalSavedTokens)} tokens`,
      timestamp: contextHealth.compression.lastCompressionAt,
      tone: 'success',
    });
  }

  return entries
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 8);
}

const Section: React.FC<{
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

const MetricCard: React.FC<{
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

const AgentLaneCard: React.FC<{
  agent: ReturnType<typeof useSwarmStore.getState>['agents'][number];
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

const AgentContextCard: React.FC<{
  agent: ReturnType<typeof useSwarmStore.getState>['agents'][number];
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

const LaunchRequestCard: React.FC<{ request: SwarmLaunchRequest }> = ({ request }) => {
  const [feedback, setFeedback] = useState(request.feedback || '');
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badgeClass =
    request.status === 'pending'
      ? 'bg-amber-500/15 text-amber-300'
      : request.status === 'approved'
      ? 'bg-emerald-500/15 text-emerald-300'
      : 'bg-red-500/15 text-red-300';

  const handleApprove = async () => {
    setSubmitting('approve');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_APPROVE_LAUNCH, {
        requestId: request.id,
        feedback: feedback.trim() || undefined,
      });
      if (!success) {
        setError('启动确认失败，当前请求可能已被处理。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动确认失败');
    } finally {
      setSubmitting(null);
    }
  };

  const handleReject = async () => {
    const trimmed = feedback.trim();
    if (!trimmed) {
      setError('取消编排时需要填写原因。');
      return;
    }

    setSubmitting('reject');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_REJECT_LAUNCH, {
        requestId: request.id,
        feedback: trimmed,
      });
      if (!success) {
        setError('取消失败，当前请求可能已被处理。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消失败');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
      <div className="flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-primary-400" />
        <div className="text-sm text-zinc-100">并行编排启动确认</div>
        <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${badgeClass}`}>
          {request.status === 'pending' ? '待确认' : request.status === 'approved' ? '已启动' : '已取消'}
        </span>
      </div>

      <div className="mt-2 text-xs leading-5 text-zinc-400">{request.summary}</div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          Agent <span className="ml-1 text-zinc-200">{request.agentCount}</span>
        </div>
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          依赖 <span className="ml-1 text-cyan-300">{request.dependencyCount}</span>
        </div>
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          写权限 <span className="ml-1 text-amber-300">{request.writeAgentCount}</span>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {request.tasks.map((task) => (
          <div key={task.id} className="rounded-lg border border-white/[0.04] bg-zinc-900/70 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                {task.role}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                  task.writeAccess
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-emerald-500/15 text-emerald-300'
                }`}
              >
                {task.writeAccess ? '可写' : '只读'}
              </span>
              {task.dependsOn && task.dependsOn.length > 0 && (
                <span className="text-[10px] text-cyan-300">
                  依赖 {task.dependsOn.join(', ')}
                </span>
              )}
            </div>
            <div className="mt-2 text-xs leading-5 text-zinc-400 line-clamp-4">{task.task}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {task.tools.slice(0, 4).map((tool) => (
                <span
                  key={`${task.id}-${tool}`}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
                >
                  {tool}
                </span>
              ))}
              {task.tools.length > 4 && (
                <span className="text-[10px] text-zinc-600">+{task.tools.length - 4}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {request.status === 'pending' && (
        <div className="mt-3 space-y-2">
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="可选说明；取消编排时填写原因"
            className="min-h-[72px] w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900/80 px-2.5 py-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none transition-colors focus:border-primary-500/40"
          />
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleApprove}
              disabled={submitting !== null}
              className="rounded-md bg-emerald-500/15 px-2.5 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting === 'approve' ? '启动中…' : '开始执行'}
            </button>
            <button
              onClick={handleReject}
              disabled={submitting !== null}
              className="rounded-md bg-red-500/15 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting === 'reject' ? '取消中…' : '取消编排'}
            </button>
          </div>
        </div>
      )}

      {request.feedback && request.status !== 'pending' && (
        <div className="mt-2 rounded bg-zinc-900/80 px-2 py-1.5 text-xs text-zinc-400">
          {request.feedback}
        </div>
      )}
    </div>
  );
};

const ApprovalCard: React.FC<{ review: SwarmPlanReview }> = ({ review }) => {
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

export const Orchestration: React.FC = () => {
  const { setShowAgentTeamPanel, setSelectedSwarmAgentId, contextHealth: appContextHealth } = useAppStore();
  const { currentSessionId, messages, sessionRuntimes } = useSessionStore();
  const {
    isRunning,
    startTime,
    agents,
    statistics,
    aggregation,
    verification,
    executionPhase,
    launchRequests,
    planReviews,
    eventLog,
    lastEventAt,
  } = useSwarmStore();
  const [delegateMode, setDelegateMode] = useState(false);
  const [delegateModeLoading, setDelegateModeLoading] = useState(true);
  const [delegateModePending, setDelegateModePending] = useState(false);
  const [cancelingAgentId, setCancelingAgentId] = useState<string | null>(null);
  const [retryingAgentId, setRetryingAgentId] = useState<string | null>(null);
  const [contextView, setContextView] = useState<ContextViewResponse | null>(null);
  const [contextViewLoading, setContextViewLoading] = useState(false);
  const [interventionLoadingId, setInterventionLoadingId] = useState<string | null>(null);
  const [selectedContextAgentId, setSelectedContextAgentId] = useState<string | null>(null);

  const runtimeContextHealth = currentSessionId
    ? sessionRuntimes.get(currentSessionId)?.contextHealth ?? null
    : null;
  const contextHealth = runtimeContextHealth ?? appContextHealth ?? null;
  const contextSources = useMemo(() => summarizeContextSources(messages), [messages]);
  const contextTimeline = useMemo(
    () => buildContextTimeline(messages, contextView, contextHealth),
    [messages, contextView, contextHealth],
  );
  const agentContextSnapshots = useMemo(
    () => agents.filter((agent) => Boolean(agent.contextSnapshot)),
    [agents],
  );

  const pendingLaunches = useMemo(
    () => launchRequests.filter((request) => request.status === 'pending'),
    [launchRequests],
  );
  const resolvedLaunches = useMemo(
    () => launchRequests.filter((request) => request.status !== 'pending').slice(-2).reverse(),
    [launchRequests],
  );
  const pendingReviews = useMemo(
    () => planReviews.filter((review) => review.status === 'pending'),
    [planReviews],
  );
  const resolvedReviews = useMemo(
    () => planReviews.filter((review) => review.status !== 'pending').slice(-3).reverse(),
    [planReviews],
  );
  const recentEvents = useMemo(() => eventLog.slice(-8).reverse(), [eventLog]);
  const activeLaunchRequest = pendingLaunches[0] || launchRequests[launchRequests.length - 1];
  const selectedContextAgent = useMemo(
    () => selectedContextAgentId
      ? agents.find((agent) => agent.id === selectedContextAgentId) ?? null
      : null,
    [agents, selectedContextAgentId],
  );
  const interventionItems = useMemo(
    () => (contextView?.contextItems ?? []).slice(-6).reverse(),
    [contextView],
  );
  const provenanceEntries = useMemo<ContextProvenanceListEntry[]>(() => {
    if (!contextView) return [];
    if (Array.isArray(contextView.provenanceEntries) && contextView.provenanceEntries.length > 0) {
      return contextView.provenanceEntries;
    }
    return (contextView.provenance ?? []).map((entry) => ({
      id: `${entry.messageId}:${entry.layer ?? 'session'}:${entry.timestamp ?? 0}`,
      label: entry.reason,
      source: entry.layer ?? entry.source,
      sourceType: entry.source === 'tool' ? 'tool' : 'message',
      reason: entry.reason,
      tokens: 0,
      action: entry.modifications.length > 0 ? 'compressed' : 'added',
      category: entry.modifications.includes('excluded')
        ? 'excluded'
        : entry.modifications.includes('pinned') || entry.modifications.includes('retained')
          ? 'manual_pin_retain'
          : entry.modifications.length > 0
            ? 'compression_survivor'
            : 'recent_turn',
      agentId: entry.agentId,
      timestamp: entry.timestamp ?? 0,
    }));
  }, [contextView]);

  if (!isRunning && agents.length === 0 && launchRequests.length === 0 && planReviews.length === 0 && !aggregation) {
    return (
      <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-4">
        <div className="flex items-center gap-2 text-zinc-300">
          <GitBranch className="w-4 h-4 text-primary-400" />
          <span className="text-sm font-medium">编排视图</span>
        </div>
        <div className="mt-3 text-xs leading-6 text-zinc-500">
          当前没有活跃的多 agent 编排。触发并行执行后，这里会显示 agent 泳道、审批队列、协作动态和最终汇总。
        </div>
      </div>
    );
  }

  const displayAgentCount = statistics.total || activeLaunchRequest?.agentCount || agents.length;
  const progressPercent = statistics.total > 0
    ? ((statistics.completed + statistics.failed + statistics.running * 0.5) / statistics.total) * 100
    : pendingLaunches.length > 0
    ? 8
    : 0;
  const elapsed = startTime ? formatDuration(Date.now() - startTime) : '0s';
  const phase = phaseMeta[executionPhase];
  const contextUsagePercent = contextView?.usagePercent ?? contextHealth?.usagePercent ?? 0;
  const contextTotalTokens = contextView?.totalTokens ?? contextHealth?.currentTokens ?? 0;
  const contextMaxTokens = contextView?.maxTokens ?? contextHealth?.maxTokens ?? 0;
  const contextDistribution = contextView
    ? [
        { label: 'System', value: contextView.tokenDistribution.system, tone: 'text-violet-300' },
        { label: 'User', value: contextView.tokenDistribution.user, tone: 'text-sky-300' },
        { label: 'Asst', value: contextView.tokenDistribution.assistant, tone: 'text-emerald-300' },
        { label: 'Tool', value: contextView.tokenDistribution.tool, tone: 'text-amber-300' },
      ]
    : contextHealth
    ? [
        { label: 'System', value: contextHealth.breakdown.systemPrompt, tone: 'text-violet-300' },
        { label: 'Msgs', value: contextHealth.breakdown.messages, tone: 'text-sky-300' },
        { label: 'Tools', value: contextHealth.breakdown.toolResults, tone: 'text-amber-300' },
      ]
    : [];
  const compressionCount = contextView?.compressionStatus.totalCommits
    ?? contextHealth?.compression?.compressionCount
    ?? 0;
  const compressionSavedTokens = contextView?.compressionStatus.savedTokens
    ?? contextHealth?.compression?.totalSavedTokens
    ?? 0;
  const compressionLayers = contextView?.compressionStatus.layersTriggered
    ?? (contextHealth?.compression?.compressionCount ? ['autocompact'] : []);
  const messagePreview = contextView?.apiViewPreview.slice(0, 6) ?? [];

  useEffect(() => {
    let cancelled = false;

    ipcService.invoke(IPC_CHANNELS.SWARM_GET_DELEGATE_MODE)
      .then((enabled) => {
        if (!cancelled) {
          setDelegateMode(Boolean(enabled));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDelegateModeLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentSessionId) {
      setContextView(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setContextViewLoading(true);
      ipcService.invoke(IPC_CHANNELS.CONTEXT_GET_VIEW, {
        sessionId: currentSessionId,
        agentId: selectedContextAgentId ?? undefined,
      })
        .then((result) => {
          if (!cancelled) {
            setContextView(isContextViewResponse(result) ? result : null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setContextView(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setContextViewLoading(false);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentSessionId, lastEventAt, selectedContextAgentId]);

  useEffect(() => {
    if (!selectedContextAgentId) return;
    const exists = agents.some((agent) => agent.id === selectedContextAgentId);
    if (!exists) {
      setSelectedContextAgentId(null);
    }
  }, [agents, selectedContextAgentId]);

  const openAgentTeam = (agentId: string) => {
    setSelectedSwarmAgentId(agentId);
    setShowAgentTeamPanel(true);
  };

  const toggleDelegateMode = async () => {
    const next = !delegateMode;
    setDelegateModePending(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.SWARM_SET_DELEGATE_MODE, next);
      setDelegateMode(next);
    } finally {
      setDelegateModePending(false);
    }
  };

  const cancelAgent = async (agentId: string) => {
    setCancelingAgentId(agentId);
    try {
      await ipcService.invoke(IPC_CHANNELS.SWARM_CANCEL_AGENT, { agentId });
    } finally {
      setCancelingAgentId((current) => (current === agentId ? null : current));
    }
  };

  const retryAgent = async (agentId: string) => {
    setRetryingAgentId(agentId);
    try {
      await ipcService.invoke(IPC_CHANNELS.SWARM_RETRY_AGENT, { agentId });
    } finally {
      setRetryingAgentId((current) => (current === agentId ? null : current));
    }
  };

  const handleContextIntervention = async (
    itemId: string,
    action: ContextInterventionAction,
    enabled: boolean,
  ) => {
    if (!currentSessionId) {
      return;
    }

    setInterventionLoadingId(itemId);
    try {
      await ipcService.invoke(IPC_CHANNELS.CONTEXT_INTERVENTION_SET, {
        sessionId: currentSessionId,
        agentId: selectedContextAgentId ?? undefined,
        messageId: itemId,
        action,
        enabled,
      });
    } finally {
      setInterventionLoadingId((current) => (current === itemId ? null : current));
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-3">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-primary-400" />
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">编排态势</span>
          <button
            onClick={() => {
              setSelectedSwarmAgentId(null);
              setShowAgentTeamPanel(true);
            }}
            className="ml-auto flex items-center gap-1 rounded-md border border-white/[0.06] bg-zinc-800/80 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-primary-500/20 hover:text-zinc-100"
          >
            <MessageSquare className="w-3 h-3" />
            协作
          </button>
          <button
            onClick={toggleDelegateMode}
            disabled={delegateModeLoading || delegateModePending}
            className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-zinc-800/80 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-primary-500/20 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            title="开启后优先走 delegate 编排路径"
          >
            {delegateMode ? (
              <ToggleRight className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <ToggleLeft className="w-3.5 h-3.5 text-zinc-500" />
            )}
            {delegateModePending ? '切换中…' : delegateMode ? '接管开' : '接管关'}
          </button>
          <span className={`rounded-full px-2 py-1 text-[11px] ${phase.className}`}>
            {phase.label}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between text-sm">
          <div className="text-zinc-100">
            {displayAgentCount} 个 agent
            <span className="ml-2 text-zinc-500">
              {pendingLaunches.length > 0 && !isRunning
                ? '等待启动确认'
                : `${statistics.running} 运行 / ${statistics.pending} 等待 / ${statistics.completed} 完成`}
            </span>
          </div>
          <div className="text-xs text-zinc-500">{elapsed}</div>
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary-500 via-cyan-400 to-emerald-400 transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(progressPercent, isRunning ? 8 : 0))}%` }}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <MetricCard
            icon={<Users className="w-3.5 h-3.5 text-primary-400" />}
            label="并行峰值"
            value={statistics.parallelPeak || statistics.running}
            emphasis="text-primary-300"
          />
          <MetricCard
            icon={<ShieldAlert className="w-3.5 h-3.5 text-amber-400" />}
            label="待确认"
            value={pendingLaunches.length + pendingReviews.length}
            emphasis={pendingLaunches.length + pendingReviews.length > 0 ? 'text-amber-300' : 'text-zinc-200'}
          />
          <MetricCard
            icon={<Ban className="w-3.5 h-3.5 text-red-400" />}
            label="阻塞中"
            value={agents.filter((agent) => agent.status === 'failed' || agent.status === 'cancelled').length}
            emphasis="text-red-300"
          />
          <MetricCard
            icon={<Zap className="w-3.5 h-3.5 text-cyan-400" />}
            label="总 Token"
            value={formatTokens(statistics.totalTokens)}
            emphasis="text-cyan-300"
          />
          <MetricCard
            icon={<FileText className="w-3.5 h-3.5 text-emerald-400" />}
            label="变更文件"
            value={aggregation?.filesChanged.length ?? 0}
            emphasis="text-emerald-300"
          />
        </div>
      </div>

      {launchRequests.length > 0 && (
        <Section
          title="启动确认"
          extra={
            pendingLaunches.length > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                {pendingLaunches.length} 待确认
              </span>
            ) : undefined
          }
          defaultExpanded
        >
          <div className="space-y-2">
            {pendingLaunches.map((request) => (
              <LaunchRequestCard key={request.id} request={request} />
            ))}
            {pendingLaunches.length === 0 && resolvedLaunches.map((request) => (
              <LaunchRequestCard key={request.id} request={request} />
            ))}
          </div>
        </Section>
      )}

      {activeLaunchRequest && (
        <Section title="依赖拓扑" defaultExpanded>
          <SwarmDependencyMap
            launchRequest={activeLaunchRequest}
            agents={agents}
            phase={executionPhase}
            parallelPeak={statistics.parallelPeak}
            lastEventAt={lastEventAt}
            selectedAgentId={selectedContextAgentId}
            onAgentSelect={setSelectedContextAgentId}
          />
        </Section>
      )}

      {(contextHealth || contextView || contextViewLoading) && (
        <Section
          title="上下文空间"
          extra={
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${getUsageTextClass(contextUsagePercent)}`}>
              {contextUsagePercent.toFixed(1)}%
            </span>
          }
        >
          <div className="space-y-3">
            <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-zinc-100">Context Budget</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {selectedContextAgent
                      ? `当前仅展示 ${selectedContextAgent.name} (${selectedContextAgent.id}) 的上下文视图`
                      : '当前展示全局上下文视图；点击 DAG agent 节点可切到对应 subagent'}
                  </div>
                </div>
                {selectedContextAgentId && (
                  <button
                    onClick={() => setSelectedContextAgentId(null)}
                    className="rounded-md border border-white/[0.06] bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-primary-500/20 hover:text-zinc-100"
                  >
                    查看全局
                  </button>
                )}
                {contextViewLoading && (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
                )}
              </div>

              <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-900/80">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${getUsageToneClass(contextUsagePercent)}`}
                  style={{ width: `${Math.min(100, contextUsagePercent)}%` }}
                />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <MetricCard
                  icon={<Zap className="w-3.5 h-3.5 text-cyan-400" />}
                  label="上下文预算"
                  value={`${formatTokens(contextTotalTokens)} / ${formatTokens(contextMaxTokens)}`}
                  emphasis={getUsageTextClass(contextUsagePercent)}
                />
                <MetricCard
                  icon={<Clock className="w-3.5 h-3.5 text-emerald-400" />}
                  label="预估剩余"
                  value={contextHealth ? `~${contextHealth.estimatedTurnsRemaining} 轮` : '—'}
                  emphasis="text-emerald-300"
                />
                <MetricCard
                  icon={<Activity className="w-3.5 h-3.5 text-violet-400" />}
                  label="消息视图"
                  value={contextView?.messageCount ?? messages.length}
                  emphasis="text-violet-300"
                />
                <MetricCard
                  icon={<ShieldAlert className="w-3.5 h-3.5 text-amber-400" />}
                  label="健康等级"
                  value={contextHealth?.warningLevel ?? 'normal'}
                  emphasis={getUsageTextClass(contextUsagePercent)}
                />
              </div>
            </div>

            {contextDistribution.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">Context Breakdown</div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {contextDistribution.map((entry) => {
                    const percent = contextTotalTokens > 0
                      ? `${((entry.value / contextTotalTokens) * 100).toFixed(1)}%`
                      : '0.0%';

                    return (
                      <div key={entry.label} className="rounded bg-zinc-900/70 px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">{entry.label}</div>
                        <div className={`mt-1 text-sm font-medium ${entry.tone}`}>{formatTokens(entry.value)}</div>
                        <div className="mt-1 text-[10px] text-zinc-600">{percent}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">Compression</div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    提交次数 <span className="ml-1 text-zinc-200">{compressionCount}</span>
                  </div>
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    节省 Token <span className="ml-1 text-emerald-300">{formatTokens(compressionSavedTokens)}</span>
                  </div>
                  <div className="col-span-2 rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    触发层 <span className="ml-1 text-zinc-200">{compressionLayers.length > 0 ? compressionLayers.join(', ') : '—'}</span>
                  </div>
                  {contextView && (
                    <div className="col-span-2 rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                      裁剪状态
                      <span className="ml-1 text-zinc-200">
                        snip {contextView.compressionStatus.snippedCount} / collapse {contextView.compressionStatus.collapsedSpans}
                      </span>
                    </div>
                  )}
                </div>
              </div>

            <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
              <div className="text-sm font-medium text-zinc-100">Context Sources</div>
              <div className="mt-2 text-xs text-zinc-500">最近 20 条消息里被带入上下文的附件与工具</div>
              <div className="mt-3 space-y-2">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Attachments</div>
                  <div className="flex flex-wrap gap-1.5">
                    {contextSources.attachments.length > 0 ? contextSources.attachments.map((name) => (
                      <span
                        key={name}
                        className="rounded bg-zinc-900/80 px-1.5 py-0.5 text-[10px] text-zinc-300"
                        title={name}
                      >
                        {name}
                      </span>
                    )) : (
                      <span className="text-[10px] text-zinc-600">无附件上下文</span>
                    )}
                  </div>
                </div>
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Tools</div>
                    <div className="flex flex-wrap gap-1.5">
                      {contextSources.tools.length > 0 ? contextSources.tools.map((name) => (
                        <span
                          key={name}
                          className="rounded bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300"
                        >
                          {name}
                        </span>
                      )) : (
                        <span className="text-[10px] text-zinc-600">无工具上下文</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {interventionItems.length > 0 && (
              <ContextInterventionPanel
                items={interventionItems}
                submittingId={interventionLoadingId}
                onAction={handleContextIntervention}
              />
            )}

            {provenanceEntries.length > 0 && (
              <ContextProvenancePanel entries={provenanceEntries} />
            )}

            {contextTimeline.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary-400" />
                  <div className="text-sm font-medium text-zinc-100">Context Timeline</div>
                </div>
                <div className="mt-3 space-y-2">
                  {contextTimeline.map((entry) => (
                    <div
                      key={entry.id}
                      className={`rounded-lg border px-3 py-2 ${toneClassMap[entry.tone]}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{entry.title}</span>
                        <span className="ml-auto text-[10px] text-zinc-500">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="mt-1 text-xs leading-5">{entry.summary}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {agentContextSnapshots.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-primary-400" />
                  <div className="text-sm font-medium text-zinc-100">Agent Context Snapshots</div>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {agentContextSnapshots.map((agent) => (
                    <AgentContextCard key={`ctx-${agent.id}`} agent={agent} />
                  ))}
                </div>
              </div>
            )}

            {messagePreview.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">API View Preview</div>
                <div className="mt-3 space-y-2">
                  {messagePreview.map((item) => (
                    <div
                      key={item.id}
                      className="rounded border border-white/[0.04] bg-zinc-900/70 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                          {item.role}
                        </span>
                        <span className="ml-auto text-[10px] text-zinc-500">{formatTokens(item.tokens)} tokens</span>
                      </div>
                      <div className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">
                        {item.contentPreview}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {agents.length > 0 && (
        <Section
          title="Agent 泳道"
          extra={<span className="text-[11px] text-zinc-600">{agents.length}</span>}
        >
          <div className="space-y-2">
            {agents.map((agent) => (
              <AgentLaneCard
                key={agent.id}
                agent={agent}
                onOpenTeam={openAgentTeam}
                onCancelAgent={cancelAgent}
                onRetryAgent={retryAgent}
                canceling={cancelingAgentId === agent.id}
                retrying={retryingAgentId === agent.id}
              />
            ))}
          </div>
        </Section>
      )}

      {(pendingReviews.length > 0 || resolvedReviews.length > 0) && (
        <Section
          title="审批队列"
          extra={
            pendingReviews.length > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                {pendingReviews.length} 待处理
              </span>
            ) : undefined
          }
        >
          <div className="space-y-2">
            {pendingReviews.map((review) => (
              <ApprovalCard key={review.id} review={review} />
            ))}
            {pendingReviews.length === 0 && resolvedReviews.map((review) => (
              <ApprovalCard key={review.id} review={review} />
            ))}
          </div>
        </Section>
      )}

      {recentEvents.length > 0 && (
        <Section title="协作动态" extra={<MessageSquareText className="w-3.5 h-3.5 text-zinc-500" />}>
          <div className="space-y-2">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className={`rounded-lg border px-3 py-2 ${toneClassMap[event.tone]}`}
              >
                <div className="flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">{event.title}</span>
                  <span className="ml-auto text-[10px] text-zinc-500">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5">{event.summary}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {(aggregation || verification) && (
        <Section title="结果收口" extra={<Sparkles className="w-3.5 h-3.5 text-violet-400" />}>
          <div className="space-y-3">
            {aggregation && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">聚合摘要</div>
                <div className="mt-2 text-xs leading-6 text-zinc-400">{aggregation.summary}</div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    加速比 <span className="ml-1 text-cyan-300">{aggregation.speedup.toFixed(1)}x</span>
                  </div>
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    成功率 <span className="ml-1 text-emerald-300">{(aggregation.successRate * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            )}

            {verification && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  {verification.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400" />
                  )}
                  验证{verification.passed ? '通过' : '未通过'}
                  <span className="ml-auto text-xs text-zinc-500">
                    {(verification.score * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {verification.checks.map((check) => (
                    <span
                      key={`${check.name}-${check.passed}`}
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        check.passed
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-red-500/15 text-red-300'
                      }`}
                      title={check.message}
                    >
                      {check.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
};

export default Orchestration;
