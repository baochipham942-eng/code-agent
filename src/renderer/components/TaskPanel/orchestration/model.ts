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
import type { Translations } from '../../../i18n';

const phaseClassName: Record<SwarmExecutionPhase, string> = {
  idle: 'bg-zinc-700/60 text-zinc-300',
  planning: 'bg-blue-500/15 text-blue-300',
  waiting_approval: 'bg-amber-500/15 text-amber-300',
  executing: 'bg-primary-500/15 text-primary-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  cancelled: 'bg-zinc-700/60 text-zinc-300',
};

export function getPhaseMeta(
  phase: SwarmExecutionPhase,
  t: Translations,
): { label: string; className: string } {
  const o = t.taskStatusPanels.orchestration;
  const labels: Record<SwarmExecutionPhase, string> = {
    idle: o.phaseIdle,
    planning: o.phasePlanning,
    waiting_approval: o.phaseWaitingApproval,
    executing: o.phaseExecuting,
    completed: o.phaseCompleted,
    failed: o.phaseFailed,
    cancelled: o.phaseCancelled,
  };
  return { label: labels[phase], className: phaseClassName[phase] };
}

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

export function formatCommitLabel(operation: string, layer: string, t: Translations): string {
  const o = t.taskStatusPanels.orchestration;
  const operationMap: Record<string, string> = {
    truncate: o.opTruncate,
    snip: o.opSnip,
    compact: o.opCompact,
    collapse: o.opCollapse,
    drain: o.opDrain,
    reset: o.opReset,
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
  t: Translations,
): ContextTimelineEntry[] {
  const o = t.taskStatusPanels.orchestration;
  const entries: ContextTimelineEntry[] = [];

  for (const commit of contextView?.recentCommits ?? []) {
    entries.push({
      id: `commit-${commit.timestamp}-${commit.layer}-${commit.operation}`,
      title: formatCommitLabel(commit.operation, commit.layer, t),
      summary: commit.targetCount > 0
        ? o.timelineAffectedMessages.replace('{count}', String(commit.targetCount))
        : o.timelineSystemAdjustment,
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
        title: o.timelineAttachmentTitle,
        summary: o.timelineAttachmentSummary.replace('{count}', String(attachmentCount)),
        timestamp,
        tone: 'neutral',
      });
    }

    if (toolNames.length > 0) {
      entries.push({
        id: `tools-${message.id}`,
        title: o.timelineToolTitle,
        summary: toolNames.slice(0, 3).join(', '),
        timestamp,
        tone: 'neutral',
      });
    }
  });

  if (contextView && contextView.usagePercent >= 70) {
    entries.push({
      id: `budget-${contextView.usagePercent}`,
      title: contextView.usagePercent >= 85 ? o.contextBudgetCritical : o.contextBudgetRising,
      summary: o.contextBudgetSummary
        .replace('{used}', contextView.usagePercent.toFixed(1))
        .replace('{remaining}', Math.max(0, 100 - contextView.usagePercent).toFixed(1)),
      timestamp: recentMessages[recentMessages.length - 1]?.timestamp ?? Date.now(),
      tone: contextView.usagePercent >= 85 ? 'warning' : 'neutral',
    });
  }

  if (contextHealth?.compression?.lastCompressionAt) {
    entries.push({
      id: `health-compression-${contextHealth.compression.lastCompressionAt}`,
      title: o.autoCompressionActive,
      summary: o.cumulativeSavedTokens.replace('{tokens}', formatTokens(contextHealth.compression.totalSavedTokens)),
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
