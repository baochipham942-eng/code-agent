import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Brain,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  ReplayBlock,
  ReplayMemoryAudit,
  ReplayModelDecision,
  ReplayToolCall,
  ReplayTurn,
  StructuredReplay,
} from '@shared/contract/evaluation';
import type {
  AgentQualityScorecard,
  TurnQualityMemoryBlock,
  TurnQualityMemoryItem,
  TurnQualityScoreBreakdown,
  TurnQualityScoreSummary,
} from '@shared/contract/turnQuality';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';

type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

interface ReplayAuditPanelViewProps {
  replay: StructuredReplay | null;
  sessionTitle?: string | null;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}

function gradeTone(grade?: TurnQualityScoreSummary['grade']): string {
  switch (grade) {
    case 'excellent':
    case 'good':
      return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200';
    case 'watch':
      return 'border-amber-400/20 bg-amber-400/10 text-amber-200';
    case 'risk':
      return 'border-red-400/20 bg-red-400/10 text-red-200';
    default:
      return 'border-zinc-700 bg-zinc-900/70 text-zinc-400';
  }
}

function dimensionTone(status?: TurnQualityScoreBreakdown['status']): string {
  switch (status) {
    case 'good':
      return 'border-emerald-400/15 bg-emerald-400/[0.05]';
    case 'watch':
      return 'border-amber-400/15 bg-amber-400/[0.05]';
    case 'risk':
      return 'border-red-400/15 bg-red-400/[0.05]';
    default:
      return 'border-white/[0.06] bg-white/[0.025]';
  }
}

function dimensionLabel(dimension: string): string {
  switch (dimension) {
    case 'strategy':
      return '任务策略';
    case 'memory':
      return '记忆质量';
    case 'capability':
      return 'Agent 能力';
    case 'tooling':
      return '工具执行';
    case 'delivery':
      return '交付质量';
    default:
      return dimension;
  }
}

function blockLabel(blockType: string): string {
  switch (blockType) {
    case 'seed-memory':
      return 'Seed';
    case 'memory_index':
      return 'Index';
    case 'memory_hint':
      return 'Hint';
    case 'recent_conversations':
      return 'Recent';
    case 'failure_journal':
      return 'Failure';
    default:
      return blockType;
  }
}

function strategyLabel(decision?: ReplayModelDecision | null, audit?: ReplayMemoryAudit | null): string {
  const profile = audit?.agentScorecard?.strategyProfile;
  if (profile === 'fast') return '快速策略';
  if (profile === 'main') return '主任务策略';
  if (profile === 'deep') return '深度策略';
  if (profile === 'vision') return '视觉策略';
  if (decision?.reason?.startsWith('strategy-')) return decision.reason.replace('strategy-', '策略 ');
  return decision?.reason || '模型策略';
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  return `${Math.round(sec / 60)}m`;
}

function formatNumber(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function compactText(value: string, max = 180): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}...`;
}

function getMemoryItems(audit: ReplayMemoryAudit): TurnQualityMemoryItem[] {
  const seen = new Set<string>();
  const items = audit.blocks.flatMap((block) => block.items || []);
  return items.filter((item) => {
    if (seen.has(item.entryId)) return false;
    seen.add(item.entryId);
    return true;
  });
}

function getMemoryStats(audits: ReplayMemoryAudit[]): {
  injectedBlocks: number;
  visibleItems: number;
  suppressed: number;
  offTurns: number;
} {
  return audits.reduce((acc, audit) => {
    acc.injectedBlocks += audit.blocks.filter((block) => block.injected).length;
    acc.visibleItems += getMemoryItems(audit).length;
    acc.suppressed += audit.suppressedEntryIds?.length || 0;
    if (audit.mode === 'off') acc.offTurns += 1;
    return acc;
  }, { injectedBlocks: 0, visibleItems: 0, suppressed: 0, offTurns: 0 });
}

function turnBlocks<T>(
  turn: ReplayTurn,
  type: ReplayBlock['type'],
  selector: (block: ReplayBlock) => T | undefined,
): T[] {
  return turn.blocks
    .filter((block) => block.type === type)
    .map(selector)
    .filter((value): value is T => Boolean(value));
}

function firstUserText(turn: ReplayTurn): string {
  const user = turn.blocks.find((block) => block.type === 'user');
  return user?.content ? compactText(user.content, 120) : '无用户输入文本';
}

function scoreValue(score?: TurnQualityScoreSummary | null): string {
  if (!score) return '--';
  return `${score.score}/${score.max}`;
}

const ScoreBadge: React.FC<{ score?: TurnQualityScoreSummary | null; label?: string }> = ({ score, label }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${gradeTone(score?.grade)}`}>
    <Gauge className="h-3.5 w-3.5" />
    {label ? <span>{label}</span> : null}
    <span className="font-mono">{scoreValue(score)}</span>
  </span>
);

const ScoreBreakdown: React.FC<{ score?: TurnQualityScoreSummary | null }> = ({ score }) => {
  if (!score?.breakdown?.length) {
    return (
      <div className="rounded-md border border-white/[0.06] bg-white/[0.025] px-3 py-3 text-xs text-zinc-500">
        暂无维度分。
      </div>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {score.breakdown.map((item) => (
        <div key={item.dimension} className={`rounded-md border px-3 py-2 ${dimensionTone(item.status)}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-zinc-300">{dimensionLabel(item.dimension)}</span>
            <span className="font-mono text-xs text-zinc-500">{item.score}/{item.max}</span>
          </div>
          {item.reasons.length ? (
            <div className="mt-1 text-[11px] leading-4 text-zinc-500">{item.reasons.slice(0, 2).join(' / ')}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const Metric: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="rounded-md border border-white/[0.06] bg-white/[0.025] px-3 py-2">
    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
      {icon}
      {label}
    </div>
    <div className="mt-1 text-sm font-medium text-zinc-200">{value}</div>
  </div>
);

const AgentScorecardRow: React.FC<{ scorecard: AgentQualityScorecard }> = ({ scorecard }) => (
  <div className="rounded-md border border-fuchsia-400/10 bg-fuchsia-400/[0.04] px-3 py-2">
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="truncate text-sm text-zinc-200">{scorecard.agentName || scorecard.agentId || 'Main agent'}</div>
        <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
          <span>{scorecard.model}</span>
          {scorecard.strategyProfile ? <span>{scorecard.strategyProfile}</span> : null}
          <span>memory {scorecard.memoryUsed}</span>
          <span>tools {scorecard.toolsUsed}</span>
          <span>warnings {scorecard.warnings}</span>
        </div>
      </div>
      <ScoreBadge score={scorecard.score} />
    </div>
  </div>
);

const MemoryAuditSummary: React.FC<{ audit: ReplayMemoryAudit }> = ({ audit }) => {
  const items = getMemoryItems(audit);
  const injectedBlocks = audit.blocks.filter((block) => block.injected);
  return (
    <div className="rounded-md border border-emerald-400/10 bg-emerald-400/[0.04] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-emerald-100">
          <Brain className="h-4 w-4" />
          {audit.mode === 'off' ? '记忆关闭' : `记忆命中 ${items.length}`}
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px] text-emerald-200/60">
          <span>{injectedBlocks.length} blocks</span>
          {audit.suppressedEntryIds?.length ? <span>{audit.suppressedEntryIds.length} suppressed</span> : null}
        </div>
      </div>
      {audit.offReason ? (
        <div className="mt-1 text-[11px] text-zinc-500">{audit.offReason}</div>
      ) : null}
      {audit.blocks.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {audit.blocks.map((block: TurnQualityMemoryBlock, index) => (
            <span
              key={`${block.blockType}-${index}`}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                block.injected
                  ? 'border-emerald-400/15 bg-emerald-400/10 text-emerald-200'
                  : 'border-zinc-700 bg-zinc-900/70 text-zinc-500'
              }`}
            >
              {blockLabel(block.blockType)} {block.count}
            </span>
          ))}
        </div>
      ) : null}
      {items.length ? (
        <div className="mt-2 space-y-1">
          {items.slice(0, 3).map((item) => (
            <div key={item.entryId} className="rounded border border-white/[0.05] bg-black/15 px-2 py-1">
              <div className="truncate text-[11px] text-zinc-300">{item.title}</div>
              {item.preview ? <div className="mt-0.5 text-[10px] text-zinc-600">{compactText(item.preview, 120)}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const ModelDecisionSummary: React.FC<{ decision: ReplayModelDecision; audit?: ReplayMemoryAudit | null }> = ({ decision, audit }) => (
  <div className="rounded-md border border-sky-400/10 bg-sky-400/[0.04] px-3 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-sky-100">
          <Cpu className="h-4 w-4" />
          <span className="truncate">{decision.provider}/{decision.model}</span>
        </div>
        <div className="mt-1 text-[11px] text-sky-200/60">{strategyLabel(decision, audit)}</div>
      </div>
      <div className="font-mono text-[11px] text-sky-200/50">
        {formatNumber(decision.inputTokens)} in / {formatNumber(decision.outputTokens)} out
      </div>
    </div>
    {decision.fallbackFrom ? (
      <div className="mt-1 text-[11px] text-amber-200/70">fallback from {decision.fallbackFrom}</div>
    ) : null}
  </div>
);

const ToolList: React.FC<{ tools: ReplayToolCall[] }> = ({ tools }) => {
  if (!tools.length) return null;
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.025] px-3 py-2">
      <div className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
        <Wrench className="h-4 w-4" />
        工具调用 {tools.length}
      </div>
      <div className="space-y-1">
        {tools.slice(0, 5).map((tool) => (
          <div key={tool.id} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-zinc-400">{tool.name}</span>
            <span className={tool.success ? 'text-emerald-300/70' : 'text-red-300/70'}>
              {tool.successKnown === false ? 'unknown' : tool.success ? 'ok' : 'failed'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const TurnAuditRow: React.FC<{ turn: ReplayTurn }> = ({ turn }) => {
  const audits = turnBlocks(turn, 'memory_audit', (block) => block.memoryAudit);
  const models = turnBlocks(turn, 'model_call', (block) => block.modelDecision);
  const tools = turnBlocks(turn, 'tool_call', (block) => block.toolCall);
  const errors = turn.blocks.filter((block) => block.type === 'error');
  const firstAudit = audits[0] || null;
  const score = firstAudit?.score || firstAudit?.agentScorecard?.score || null;

  return (
    <div className="rounded-md border border-white/[0.06] bg-zinc-950/70 px-3 py-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-zinc-200">
            <span className="font-mono text-zinc-500">#{turn.turnNumber}</span>
            <span className="truncate">{firstUserText(turn)}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-600">
            <span>{formatDuration(turn.durationMs)}</span>
            <span>{formatNumber(turn.inputTokens)} in</span>
            <span>{formatNumber(turn.outputTokens)} out</span>
          </div>
        </div>
        <ScoreBadge score={score} />
      </div>

      <div className="grid gap-2">
        {models.slice(0, 2).map((decision) => (
          <ModelDecisionSummary key={decision.id} decision={decision} audit={firstAudit} />
        ))}
        {audits.map((audit, index) => (
          <MemoryAuditSummary key={`${turn.turnNumber}-${index}`} audit={audit} />
        ))}
        <ToolList tools={tools} />
        {errors.length ? (
          <div className="rounded-md border border-red-400/15 bg-red-400/[0.05] px-3 py-2 text-[11px] text-red-200/80">
            {errors.map((block, index) => (
              <div key={`${block.timestamp}-${index}`}>{compactText(block.content, 160)}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const ReplayAuditPanelView: React.FC<ReplayAuditPanelViewProps> = ({
  replay,
  sessionTitle,
  loading = false,
  error = null,
  onRefresh,
}) => {
  const audits = useMemo(
    () => replay?.turns.flatMap((turn) => turnBlocks(turn, 'memory_audit', (block) => block.memoryAudit)) || [],
    [replay],
  );
  const memoryStats = useMemo(() => getMemoryStats(audits), [audits]);
  const agentScorecards = replay?.summary.agentScorecards || [];
  const toolEntries = Object.entries(replay?.summary.toolDistribution || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (loading && !replay) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        加载 Replay/Audit…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full overflow-y-auto bg-zinc-950 p-4">
        <div className="rounded-md border border-red-400/20 bg-red-400/[0.06] p-4 text-sm text-red-100">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Replay/Audit 加载失败
          </div>
          <div className="mt-2 text-xs text-red-200/70">{error}</div>
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-red-300/20 px-2 py-1 text-xs text-red-100 hover:bg-red-300/10"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!replay) {
    return (
      <div className="h-full overflow-y-auto bg-zinc-950 p-6 text-sm text-zinc-500">
        <div className="flex items-center gap-2 text-zinc-300">
          <ShieldCheck className="h-4 w-4" />
          暂无 Replay/Audit 数据
        </div>
        <div className="mt-2 text-xs text-zinc-600">
          当前会话还没有可读取的结构化回放。
        </div>
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] px-2 py-1 text-xs text-zinc-300 hover:bg-white/[0.05]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-zinc-950">
      <div className="border-b border-white/[0.06] bg-zinc-950/95 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              <ShieldCheck className="h-4 w-4 text-sky-300" />
              Replay/Audit
            </div>
            <div className="mt-1 truncate text-xs text-zinc-500">
              {sessionTitle || replay.sessionId}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ScoreBadge score={replay.summary.qualityScore} label="Session" />
            {onRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.08] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100 disabled:opacity-50"
                title="刷新 Replay/Audit"
                aria-label="刷新 Replay/Audit"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={<Database className="h-3.5 w-3.5" />} label="数据源" value={replay.dataSource} />
          <Metric icon={<Clock className="h-3.5 w-3.5" />} label="总耗时" value={formatDuration(replay.summary.totalDurationMs)} />
          <Metric icon={<Brain className="h-3.5 w-3.5" />} label="记忆证据" value={`${memoryStats.visibleItems} items / ${memoryStats.injectedBlocks} blocks`} />
          <Metric icon={<Wrench className="h-3.5 w-3.5" />} label="工具调用" value={String(toolEntries.reduce((sum, [, count]) => sum + count, 0))} />
        </div>

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Gauge className="h-3.5 w-3.5" />
            Session Score
          </div>
          <ScoreBreakdown score={replay.summary.qualityScore} />
        </section>

        {agentScorecards.length ? (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Bot className="h-3.5 w-3.5" />
              Agent Scorecards
            </div>
            <div className="grid gap-2">
              {agentScorecards.map((scorecard, index) => (
                <AgentScorecardRow key={`${scorecard.agentId || scorecard.agentName || 'agent'}-${index}`} scorecard={scorecard} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Brain className="h-3.5 w-3.5" />
            Memory Audit
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <Metric icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="命中条目" value={String(memoryStats.visibleItems)} />
            <Metric icon={<Database className="h-3.5 w-3.5" />} label="注入块" value={String(memoryStats.injectedBlocks)} />
            <Metric icon={<AlertTriangle className="h-3.5 w-3.5" />} label="已屏蔽" value={String(memoryStats.suppressed)} />
            <Metric icon={<Brain className="h-3.5 w-3.5" />} label="关闭轮次" value={String(memoryStats.offTurns)} />
          </div>
        </section>

        {toolEntries.length ? (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Wrench className="h-3.5 w-3.5" />
              Tool Mix
            </div>
            <div className="flex flex-wrap gap-1.5">
              {toolEntries.map(([category, count]) => (
                <span key={category} className="rounded-md border border-white/[0.06] bg-white/[0.025] px-2 py-1 text-xs text-zinc-300">
                  {category} {count}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Cpu className="h-3.5 w-3.5" />
            Turn Evidence
          </div>
          <div className="space-y-2">
            {replay.turns.map((turn) => (
              <TurnAuditRow key={`${turn.turnNumber}-${turn.startTime}`} turn={turn} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export const ReplayAuditPanel: React.FC = () => {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSession = useSessionStore((state) =>
    state.currentSessionId
      ? state.sessions.find((session) => session.id === state.currentSessionId)
      : null,
  );
  const [replay, setReplay] = useState<StructuredReplay | null>(null);
  const [status, setStatus] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!currentSessionId) {
      setReplay(null);
      setStatus('empty');
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const result = await ipcService.invoke(IPC_CHANNELS.REPLAY_GET_STRUCTURED_DATA, currentSessionId) as StructuredReplay | null;
        if (cancelled) return;
        setReplay(result);
        setStatus(result ? 'ready' : 'empty');
      } catch (err) {
        if (cancelled) return;
        setReplay(null);
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, refreshToken]);

  return (
    <ReplayAuditPanelView
      replay={replay}
      sessionTitle={currentSession?.title}
      loading={status === 'loading'}
      error={error}
      onRefresh={() => setRefreshToken((value) => value + 1)}
    />
  );
};

export default ReplayAuditPanel;
