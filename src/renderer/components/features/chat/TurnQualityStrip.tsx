import React, { useMemo, useState, useCallback } from 'react';
import type { TurnQualitySummary, TurnQualityMemoryItem } from '@shared/contract/turnQuality';
import { IPC_DOMAINS } from '@shared/ipc';
import { Archive, Bot, Brain, ChevronDown, ChevronRight, Cpu, EyeOff, Gauge, Wrench } from 'lucide-react';
import ipcService from '../../../services/ipcService';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { toast } from '../../../hooks/useToast';
import { unescapeHtmlEntities } from '../../../utils/htmlEntities';

interface TurnQualityStripProps {
  summary: TurnQualitySummary;
}

function formatModel(summary: TurnQualitySummary): string {
  const model = summary.strategy.model || summary.strategy.requestedModel || 'model';
  const provider = summary.strategy.provider || summary.strategy.requestedProvider;
  return provider ? `${provider}/${model}` : model;
}

function memoryItems(summary: TurnQualitySummary): TurnQualityMemoryItem[] {
  const items = summary.memory.blocks.flatMap((block) => block.items || []);
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.entryId)) return false;
    seen.add(item.entryId);
    return true;
  });
}

function memoryLabel(summary: TurnQualitySummary): string {
  if (summary.memory.mode === 'off') return '记忆关闭';
  const items = memoryItems(summary);
  if (items.length > 0) return `记忆 ${items.length}`;
  const injectedBlocks = summary.memory.blocks.filter((block) => block.injected);
  if (injectedBlocks.some((block) => block.blockType === 'memory_hint')) return '记忆提示';
  if (injectedBlocks.length > 0) return `记忆 ${injectedBlocks.length}`;
  return '记忆 0';
}

function memoryTone(summary: TurnQualitySummary): string {
  return summary.memory.mode === 'off'
    ? 'border-zinc-700/70 bg-zinc-900/60 text-zinc-500'
    : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200';
}

function scoreTone(summary: TurnQualitySummary): string {
  const grade = summary.score?.grade || 'watch';
  switch (grade) {
    case 'excellent':
    case 'good':
      return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200';
    case 'watch':
      return 'border-amber-400/20 bg-amber-400/10 text-amber-200';
    case 'risk':
      return 'border-red-400/20 bg-red-400/10 text-red-200';
    default:
      return 'border-zinc-700 bg-zinc-900/60 text-zinc-300';
  }
}

function strategyLabel(summary: TurnQualitySummary): string {
  const profile = summary.strategy.profile;
  if (profile === 'fast') return '快速策略';
  if (profile === 'deep') return '深度策略';
  if (profile === 'vision') return '视觉策略';
  if (profile === 'main') return '主任务策略';
  if (summary.strategy.adaptive) return '自动策略';
  return '模型策略';
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

export const TurnQualityStrip: React.FC<TurnQualityStripProps> = ({ summary }) => {
  const developerMode = useAppStore((state) => state.developerMode);
  const [expanded, setExpanded] = useState(false);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [archivedEntryIds, setArchivedEntryIds] = useState<Set<string>>(() => new Set());
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSession = useSessionStore((state) =>
    state.currentSessionId
      ? state.sessions.find((session) => session.id === state.currentSessionId)
      : null
  );
  const suppressMemoryEntryForSession = useSessionStore((state) => state.suppressMemoryEntryForSession);
  const items = useMemo(() => memoryItems(summary), [summary]);
  const suppressedIds = new Set(currentSession?.suppressedMemoryEntryIds || summary.memory.suppressedEntryIds || []);
  const score = summary.score || { score: 0, max: 100, grade: 'watch' as const, breakdown: [] };
  const hasDetails = summary.memory.blocks.length > 0
    || items.length > 0
    || Boolean(summary.warnings?.length)
    || Boolean(score.breakdown.length);

  const handleSuppress = useCallback(async (entryId: string) => {
    if (!currentSessionId) return;
    setBusyEntryId(entryId);
    try {
      await suppressMemoryEntryForSession(currentSessionId, entryId);
      toast.success('这条记忆已在本会话忽略');
    } catch (error) {
      toast.error(`忽略记忆失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setBusyEntryId(null);
    }
  }, [currentSessionId, suppressMemoryEntryForSession]);

  const handleArchive = useCallback(async (entryId: string) => {
    setBusyEntryId(entryId);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.MEMORY, 'memoryEntryUpdate', {
        entryId,
        status: 'archived',
      });
      if (currentSessionId) {
        await suppressMemoryEntryForSession(currentSessionId, entryId);
      }
      setArchivedEntryIds((prev) => new Set(prev).add(entryId));
      toast.success('记忆已归档');
    } catch (error) {
      toast.error(`归档记忆失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setBusyEntryId(null);
    }
  }, [currentSessionId, suppressMemoryEntryForSession]);

  // 默认（非开发者模式）：评分/记忆/failure-journal 是引擎自检信息，普通协作者
  // 不需要也看不懂，只留一颗安静的模型名徽标标注"这轮是谁在干活"。
  if (!developerMode) {
    const modelName = summary.strategy.model || summary.strategy.requestedModel;
    // 手动 /agent 指定（非 default）时透出"本轮由 X 执行"的安静徽标，
    // 恢复自动路由后 agentName 回到 default 徽标自然消失。
    const agentName = summary.capabilities?.agentName;
    const showAgent = Boolean(agentName && agentName !== 'default');
    if (!modelName && !showAgent) return null;
    return (
      <div className="mb-2 flex items-center gap-1">
        {modelName && (
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] text-zinc-600">
            {modelName}
          </span>
        )}
        {showAgent && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500">
            <Bot className="h-3 w-3" />
            {agentName}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        disabled={!hasDetails}
        className="flex max-w-full items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.025] px-2 py-1 text-left text-[11px] text-zinc-400 transition-colors hover:border-white/[0.12] hover:text-zinc-200 disabled:cursor-default disabled:hover:border-white/[0.06] disabled:hover:text-zinc-400"
        aria-expanded={expanded}
        title={expanded ? '收起本轮质量信息' : '展开本轮质量信息'}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${scoreTone(summary)}`}>
          <Gauge className="h-3 w-3" />
          {score.score}/{score.max}
        </span>
        {/* 折叠态只保留语义色评分 chip；记忆/策略/agent/工具数在展开后才显示，
            避免一行 5 个平级彩 chip 把正文挤成配角。 */}
        {expanded && (
          <>
            <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${memoryTone(summary)}`}>
              <Brain className="h-3 w-3" />
              {memoryLabel(summary)}
            </span>
            <span className="inline-flex min-w-0 items-center gap-1 rounded border border-sky-400/15 bg-sky-400/10 px-1.5 py-0.5 text-sky-200">
              <Cpu className="h-3 w-3 shrink-0" />
              <span className="truncate">{strategyLabel(summary)} · {formatModel(summary)}</span>
            </span>
            {summary.capabilities?.agentName && (
              <span className="inline-flex items-center gap-1 rounded border border-fuchsia-400/15 bg-fuchsia-400/10 px-1.5 py-0.5 text-fuchsia-200">
                <Bot className="h-3 w-3" />
                {summary.capabilities.agentName}
              </span>
            )}
            {summary.capabilities?.toolsUsed?.length ? (
              <span className="inline-flex items-center gap-1 rounded border border-zinc-600/50 bg-zinc-900/40 px-1.5 py-0.5 text-zinc-300">
                <Wrench className="h-3 w-3" />
                {summary.capabilities.toolsUsed.length}
              </span>
            ) : null}
          </>
        )}
      </button>

      {expanded && (
        <div className="mt-1.5 rounded-md border border-white/[0.06] bg-black/15 px-2.5 py-2 text-[11px] text-zinc-400">
          <div className="mb-2 grid gap-1.5 md:grid-cols-2">
            {score.breakdown.map((item) => (
              <div key={item.dimension} className="rounded-md border border-white/[0.06] bg-white/[0.025] px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-300">{item.dimension}</span>
                  <span className="font-mono text-zinc-500">{item.score}/{item.max}</span>
                </div>
                {item.reasons.length ? (
                  <div className="mt-1 line-clamp-2 text-[10px] text-zinc-600">{item.reasons.join(' / ')}</div>
                ) : null}
              </div>
            ))}
          </div>
          {(summary.strategy.reason || summary.strategy.complexity) && (
            <div className="mb-2 rounded-md border border-sky-400/10 bg-sky-400/[0.04] px-2 py-1.5 text-sky-100/80">
              {summary.strategy.reason || strategyLabel(summary)}
              {summary.strategy.complexity ? (
                <span className="ml-2 text-sky-200/50">
                  {summary.strategy.complexity.level} · {summary.strategy.complexity.score}
                </span>
              ) : null}
            </div>
          )}
          {summary.agentScorecard && (
            <div className="mb-2 rounded-md border border-fuchsia-400/10 bg-fuchsia-400/[0.04] px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-zinc-300">
                <span>{summary.agentScorecard.agentName || summary.agentScorecard.agentId || 'Main agent'}</span>
                <span className="font-mono text-zinc-500">
                  {summary.agentScorecard.score.score}/{summary.agentScorecard.score.max}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-zinc-600">
                <span>{summary.agentScorecard.model}</span>
                <span>memory {summary.agentScorecard.memoryUsed}</span>
                <span>tools {summary.agentScorecard.toolsUsed}</span>
                <span>warnings {summary.agentScorecard.warnings}</span>
              </div>
            </div>
          )}
          {summary.memory.offReason && (
            <div className="mb-2 text-zinc-500">本轮没有注入记忆：{summary.memory.offReason}</div>
          )}
          {summary.memory.blocks.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {summary.memory.blocks.map((block, index) => (
                <span
                  key={`${block.blockType}-${block.trigger}-${index}`}
                  className={`rounded border px-1.5 py-0.5 ${
                    block.injected
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                      : 'border-zinc-700 bg-zinc-900/60 text-zinc-500'
                  }`}
                  title={`${block.source} / ${block.trigger}`}
                >
                  {blockLabel(block.blockType)} {block.injected ? block.count : 0}
                </span>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <div className="space-y-1.5">
              {items.map((item) => {
                const isSuppressed = suppressedIds.has(item.entryId);
                const isArchived = archivedEntryIds.has(item.entryId);
                const busy = busyEntryId === item.entryId;
                return (
                  <div key={item.entryId} className="rounded-md bg-white/[0.025] px-2 py-1.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-zinc-200">{unescapeHtmlEntities(item.title)}</div>
                        {item.preview && (
                          <div className="mt-0.5 line-clamp-2 text-zinc-500">{unescapeHtmlEntities(item.preview)}</div>
                        )}
                        {item.scoreReasons?.length ? (
                          <div className="mt-1 text-[10px] text-zinc-600">{unescapeHtmlEntities(item.scoreReasons.join(' / '))}</div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSuppress(item.entryId)}
                        disabled={busy || isSuppressed || isArchived || !currentSessionId}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-default disabled:opacity-40"
                        title={isSuppressed ? '本会话已忽略' : '本会话忽略这条记忆'}
                        aria-label={isSuppressed ? '本会话已忽略' : '本会话忽略这条记忆'}
                      >
                        <EyeOff className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleArchive(item.entryId)}
                        disabled={busy || isArchived}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-default disabled:opacity-40"
                        title={isArchived ? '已归档' : '归档这条记忆'}
                        aria-label={isArchived ? '已归档' : '归档这条记忆'}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {summary.warnings?.length ? (
            <div className="mt-2 space-y-1 text-amber-300/80">
              {summary.warnings.map((warning) => (
                <div key={warning}>{unescapeHtmlEntities(warning)}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
