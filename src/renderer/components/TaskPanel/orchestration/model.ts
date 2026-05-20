import type { Message } from '@shared/contract';
import type { ContextHealthState } from '@shared/contract/contextHealth';
import type {
  ContextProvenanceListEntry,
  ContextViewResponse,
} from '@shared/contract/contextView';
import type {
  SwarmExecutionPhase,
  SwarmTimelineEvent,
} from '../../../stores/swarmStore';

export const phaseMeta: Record<SwarmExecutionPhase, { label: string; className: string }> = {
  idle: { label: '空闲', className: 'bg-zinc-700/60 text-zinc-300' },
  planning: { label: '编排中', className: 'bg-blue-500/15 text-blue-300' },
  waiting_approval: { label: '等审批', className: 'bg-amber-500/15 text-amber-300' },
  executing: { label: '执行中', className: 'bg-primary-500/15 text-primary-300' },
  completed: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: '失败', className: 'bg-red-500/15 text-red-300' },
  cancelled: { label: '已取消', className: 'bg-zinc-700/60 text-zinc-300' },
};

export const toneClassMap: Record<SwarmTimelineEvent['tone'], string> = {
  neutral: 'border-zinc-700 bg-zinc-800/70 text-zinc-300',
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200',
  warning: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  error: 'border-red-500/25 bg-red-500/10 text-red-200',
};

export interface ContextSourceSummary {
  attachments: string[];
  tools: string[];
}

export interface ContextTimelineEntry {
  id: string;
  title: string;
  summary: string;
  timestamp: number;
  tone: 'neutral' | 'success' | 'warning';
}

export interface ContextDistributionEntry {
  label: string;
  value: number;
  tone: string;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

export function isContextViewResponse(value: unknown): value is ContextViewResponse {
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

export function getUsageToneClass(percent: number): string {
  if (percent >= 85) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export function getUsageTextClass(percent: number): string {
  if (percent >= 85) return 'text-red-300';
  if (percent >= 70) return 'text-amber-300';
  return 'text-emerald-300';
}

export function summarizeContextSources(messages: Message[]): ContextSourceSummary {
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

export function formatCommitLabel(operation: string, layer: string): string {
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

export function buildContextTimeline(
  messages: Message[],
  contextView: ContextViewResponse | null,
  contextHealth: ContextHealthState | null,
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

export function buildContextDistribution(
  contextView: ContextViewResponse | null,
  contextHealth: ContextHealthState | null,
): ContextDistributionEntry[] {
  if (contextView) {
    return [
      { label: 'System', value: contextView.tokenDistribution.system, tone: 'text-violet-300' },
      { label: 'User', value: contextView.tokenDistribution.user, tone: 'text-sky-300' },
      { label: 'Asst', value: contextView.tokenDistribution.assistant, tone: 'text-emerald-300' },
      { label: 'Tool', value: contextView.tokenDistribution.tool, tone: 'text-amber-300' },
    ];
  }

  if (contextHealth) {
    return [
      { label: 'System', value: contextHealth.breakdown.systemPrompt, tone: 'text-violet-300' },
      { label: 'Msgs', value: contextHealth.breakdown.messages, tone: 'text-sky-300' },
      { label: 'Tools', value: contextHealth.breakdown.toolResults, tone: 'text-amber-300' },
    ];
  }

  return [];
}

export function buildProvenanceEntries(
  contextView: ContextViewResponse | null,
): ContextProvenanceListEntry[] {
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
}
