// ============================================================================
// TaskMonitor - StatusRail 主工作面视图
// ============================================================================
// 四个 Card: TodoCard → ContextCard（主卡）→ OutputsCard → ReferencesCard
// 数据统一来自 useStatusRailModel
// ============================================================================

import React, { useState, useMemo, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useSkillStore } from '../../stores/skillStore';
import { useStatusRailModel } from '../../hooks/useStatusRailModel';
import {
  Check, Loader2, Clock, AlertTriangle,
  FileText, Sparkles, FolderOpen, Shrink,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { classifyTool, PHASE_ICONS, formatElapsed, type PhaseType } from './taskPanelUtils';
import { useToolProgress } from './useToolProgress';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CompactResult } from '@shared/types/contextHealth';
import ipcService from '../../services/ipcService';
import type { ContextBucket, ContextItem } from '../../utils/contextBuckets';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

export const TaskMonitor: React.FC = () => {
  const { currentSessionId, messages } = useSessionStore();
  const { workingDirectory } = useAppStore();
  const sessionTaskProgress = useAppStore((s) => s.sessionTaskProgress);
  const processingSessionIds = useAppStore((s) => s.processingSessionIds);
  const isProcessing = currentSessionId ? processingSessionIds.has(currentSessionId) : false;
  const { mountedSkills } = useSkillStore();
  const { t } = useI18n();
  const { toolProgress, toolTimeout } = useToolProgress(currentSessionId);
  const taskProgress = currentSessionId ? sessionTaskProgress[currentSessionId] ?? null : null;

  const model = useStatusRailModel();
  const { context, compact, todos: todoModel, outputs } = model;

  // ── ContextCard 状态 ──
  const [selectedBucket, setSelectedBucket] = useState<ContextBucket | 'all'>('all');
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<CompactResult | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);

  // ── 从工具调用中检测被调用的 skills ──
  const invokedSkills = useMemo(() => {
    const skillNames = new Set<string>();
    for (const msg of messages.slice(-50)) {
      if (!msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (tc.name === 'Skill') {
          const args = tc.arguments as Record<string, unknown>;
          const cmd = (args?.command || args?.skill) as string | undefined;
          if (cmd) skillNames.add(cmd);
        }
      }
    }
    return Array.from(skillNames);
  }, [messages]);

  // ── Phase-based 进度推导（无 todos 时的回退）──
  const toolPhases = useMemo(() => {
    if (todoModel.total > 0) return [];
    const phases: Array<{ type: PhaseType; count: number; status: 'completed' | 'in_progress' }> = [];
    for (const msg of messages.slice(-30)) {
      if (!msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        const phase = classifyTool(tc.name);
        if (!phase) continue;
        const last = phases[phases.length - 1];
        if (last?.type === phase) {
          last.count++;
        } else {
          if (phases.length > 0) phases[phases.length - 1].status = 'completed';
          phases.push({ type: phase, count: 1, status: 'in_progress' });
        }
      }
    }
    if (phases.length > 0 && !isProcessing) {
      phases[phases.length - 1].status = 'completed';
    }
    return phases;
  }, [messages, todoModel.total, isProcessing]);

  const handleCompact = useCallback(async () => {
    if (isCompacting || !compact.canCompact) return;
    setIsCompacting(true);
    setCompactResult(null);
    setCompactError(null);
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPACT_FROM, '') as CompactResult;
      if (result.success) {
        setCompactResult(result);
      } else {
        setCompactError('压缩失败');
      }
      setTimeout(() => { setCompactResult(null); setCompactError(null); }, 5000);
    } catch {
      setCompactError('压缩失败');
      setTimeout(() => setCompactError(null), 3000);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, compact.canCompact]);

  const folderName = workingDirectory ? workingDirectory.split('/').pop() || workingDirectory : null;
  const showToolElapsed = toolProgress && toolProgress.elapsedMs >= 5000;
  const isAgentWorking = taskProgress && taskProgress.phase !== 'completed';

  const phaseLabel = (type: PhaseType): string => {
    const map: Record<PhaseType, string> = {
      read: t.taskPanel.phaseRead,
      edit: t.taskPanel.phaseEdit,
      execute: t.taskPanel.phaseExecute,
      search: t.taskPanel.phaseSearch,
      mcp: t.taskPanel.phaseMcp,
    };
    return map[type];
  };

  const buckets: Array<{ key: ContextBucket | 'all'; label: string; count: number }> = [
    { key: 'all', label: 'All', count: context.buckets.rules + context.buckets.files + context.buckets.web + context.buckets.other },
    { key: 'rules', label: t.taskPanel.bucketRules, count: context.buckets.rules },
    { key: 'files', label: t.taskPanel.bucketFiles, count: context.buckets.files },
    { key: 'web', label: t.taskPanel.bucketWeb, count: context.buckets.web },
    { key: 'other', label: t.taskPanel.bucketOther, count: context.buckets.other },
  ];

  // ── 渲染 ──

  return (
    <div className="space-y-2">
      {/* 工作目录 */}
      {folderName && (
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <FolderOpen className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">
            {t.taskPanel.workIn.replace('{folderName}', folderName)}
          </span>
        </div>
      )}

      {/* 实时进度指示器 */}
      {isAgentWorking && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 py-1 px-2 bg-primary-500/5 rounded-lg">
          <Loader2 className="w-3.5 h-3.5 text-primary-500 animate-spin flex-shrink-0" />
          <span className="text-xs text-zinc-300 flex-1 truncate">
            {taskProgress.step || taskProgress.phase}
          </span>
          {showToolElapsed && (
            <span className={`flex items-center gap-1 text-xs shrink-0 ${
              toolTimeout ? 'text-amber-400' : 'text-zinc-500'
            }`}>
              <Clock className="w-3 h-3" />
              {formatElapsed(toolProgress!.elapsedMs)}
            </span>
          )}
        </div>
      )}

      {/* 超时警告 */}
      {toolTimeout && (
        <div className="flex items-center gap-2 text-xs text-amber-400/80 py-1">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{toolTimeout.toolName} {formatElapsed(toolTimeout.elapsedMs)}</span>
        </div>
      )}

      {/* ═══ Card 1: TodoCard ═══ */}
      <Card title={t.taskPanel.sectionTodos} count={todoModel.total > 0 ? `${todoModel.completed}/${todoModel.total}` : undefined} isEmpty={todoModel.total === 0 && toolPhases.length === 0} emptyLabel="空闲">
        {todoModel.total > 0 ? (
          <div className="space-y-0.5">
            {todoModel.items.map((todo, index) => (
              <div key={index} className="flex items-center gap-2 py-0.5">
                {todo.status === 'completed' ? (
                  <div className="w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                    <Check className="w-2.5 h-2.5 text-white" />
                  </div>
                ) : todo.status === 'in_progress' ? (
                  <div className="w-4 h-4 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0 animate-pulse">
                    <Loader2 className="w-2.5 h-2.5 text-primary-400 animate-spin" />
                  </div>
                ) : (
                  <div className="w-4 h-4 rounded-full border border-zinc-600 flex-shrink-0" />
                )}
                <span className={`text-xs truncate ${
                  todo.status === 'completed' ? 'text-zinc-500 line-through'
                    : todo.status === 'in_progress' ? 'text-zinc-200'
                    : 'text-zinc-400'
                }`}>
                  {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                </span>
              </div>
            ))}
          </div>
        ) : toolPhases.length > 0 ? (
          <div className="space-y-0.5">
            {toolPhases.map((phase, index) => {
              const PhaseIcon = PHASE_ICONS[phase.type];
              return (
                <div key={`${phase.type}-${index}`} className="flex items-center gap-2 py-0.5">
                  {phase.status === 'completed' ? (
                    <div className="w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  ) : (
                    <div className="w-4 h-4 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0 animate-pulse">
                      <PhaseIcon className="w-2.5 h-2.5 text-primary-400" />
                    </div>
                  )}
                  <span className={`text-xs flex-1 ${
                    phase.status === 'completed' ? 'text-zinc-500' : 'text-zinc-200'
                  }`}>
                    {phaseLabel(phase.type)}
                  </span>
                  <span className="text-xs text-zinc-600">
                    {t.taskPanel.phaseOps.replace('{count}', String(phase.count))}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState text={t.taskPanel.todosEmpty} />
        )}
      </Card>

      {/* ═══ Card 2: ContextCard ★ 主卡 ═══ */}
      <Card
        title={t.taskPanel.sectionContext}
        highlight={context.warningLevel !== 'normal'}
        rightElement={
          compact.canCompact ? (
            <button
              onClick={handleCompact}
              disabled={isCompacting}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors disabled:opacity-50"
              title="主动压缩上下文"
            >
              {isCompacting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Shrink className="w-3 h-3" />
              )}
              <span>Compact</span>
            </button>
          ) : undefined
        }
      >
        {/* 大数字 + 进度条 */}
        <div className="space-y-2">
          <div className="flex items-end gap-2">
            <span className={`text-xl font-bold tabular-nums ${
              context.warningLevel === 'critical' ? 'text-red-400' :
              context.warningLevel === 'warning' ? 'text-yellow-400' :
              'text-emerald-400'
            }`}>
              {Math.round(context.usagePercent)}%
            </span>
            <span className="text-sm text-zinc-500 pb-1">
              {formatTokens(context.currentTokens)} / {formatTokens(context.maxTokens)}
            </span>
            <span className="text-[10px] text-zinc-600 ml-auto">tokens</span>
          </div>

          {/* 进度条 */}
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                context.warningLevel === 'critical' ? 'bg-red-500' :
                context.warningLevel === 'warning' ? 'bg-yellow-500' :
                'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, context.usagePercent)}%` }}
            />
          </div>

          {/* Bucket tabs */}
          <div className="flex gap-1 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
            <style>{`.bucket-tabs::-webkit-scrollbar { height: 0; }`}</style>
            {buckets.map((b) => (
              <button
                key={b.key}
                onClick={() => setSelectedBucket(b.key)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] whitespace-nowrap shrink-0 transition-colors ${
                  selectedBucket === b.key
                    ? 'bg-white/10 text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-400'
                }`}
              >
                {b.label}
                {b.count > 0 && (
                  <span className="text-zinc-400 bg-zinc-700/60 rounded px-1 min-w-[14px] text-center">{b.count}</span>
                )}
              </button>
            ))}
          </div>

          {/* Context items 列表 */}
          {(() => {
            const filtered = context.items.filter(
              (item) => selectedBucket === 'all' || item.bucket === selectedBucket
            );
            const shown = filtered.slice(0, 8);
            const remaining = filtered.length - shown.length;
            if (shown.length === 0) return null;
            return (
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {shown.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 py-0.5" title={item.label}>
                    <span className="text-[10px] text-zinc-600 w-8 shrink-0 text-right">{item.detail}</span>
                    <span className="text-xs text-zinc-400 truncate font-mono">{item.label}</span>
                  </div>
                ))}
                {remaining > 0 && (
                  <div className="text-[10px] text-zinc-600 pl-10">+{remaining} more</div>
                )}
              </div>
            );
          })()}

          {/* 压缩结果反馈 */}
          {compactResult && (
            <div className="space-y-1 animate-fade-in">
              <div className="text-xs text-emerald-400">
                {compactResult.totalSavedTokens > 0
                  ? `累计释放 ${formatTokens(compactResult.totalSavedTokens)} tokens`
                  : `已压缩 ${compactResult.compressionCount} 次`
                }
              </div>
              {compactResult.layersUsed.length > 0 && (
                <div className="text-[10px] text-zinc-500">
                  层级: {compactResult.layersUsed.join(' → ')}
                  {' · '}保留最近 {compactResult.retained.recentTurns} 轮
                  {compactResult.retained.pinnedItems > 0 && ` · ${compactResult.retained.pinnedItems} 个 pin`}
                </div>
              )}
            </div>
          )}

          {/* 压缩错误 */}
          {compactError && (
            <div className="text-xs text-red-400 animate-fade-in">{compactError}</div>
          )}

          {/* 高压提示 */}
          {context.warningLevel === 'critical' && !compactResult && !compactError && (
            <div className="text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              上下文接近上限，建议压缩
            </div>
          )}

          {/* 压缩历史 */}
          {compact.compressionCount > 0 && (
            <div className="text-[10px] text-zinc-600">
              已压缩 {compact.compressionCount} 次，累计释放 {formatTokens(compact.totalSavedTokens)}
            </div>
          )}
        </div>
      </Card>

      {/* ═══ Card 3: OutputsCard ═══ */}
      <Card title={t.taskPanel.sectionOutputs} count={outputs.count > 0 ? String(outputs.count) : undefined} isEmpty={outputs.count === 0} emptyLabel="0">
        {outputs.count > 0 ? (
          <div className="space-y-0.5">
            {outputs.files.map((file) => (
              <div key={file.path} className="flex items-center gap-2 py-0.5" title={file.path}>
                <FileText className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                <span className="text-xs text-zinc-400 truncate font-mono">{file.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState text={t.taskPanel.artifactsEmpty} />
        )}
      </Card>

      {/* ═══ Card 4: ReferencesCard ═══ */}
      <Card title={t.taskPanel.sectionReferences} isEmpty={mountedSkills.length === 0 && invokedSkills.length === 0} emptyLabel="0">
        {mountedSkills.length > 0 || invokedSkills.length > 0 ? (
          <div className="space-y-0.5">
            {mountedSkills.map((mount) => (
              <div key={mount.skillName} className="flex items-center gap-2 py-0.5">
                <Sparkles className="w-3 h-3 text-purple-400/70 flex-shrink-0" />
                <span className="text-xs text-zinc-400 truncate">{mount.skillName}</span>
              </div>
            ))}
            {invokedSkills
              .filter((name) => !mountedSkills.some((m) => m.skillName === name))
              .map((name) => (
                <div key={`invoked-${name}`} className="flex items-center gap-2 py-0.5">
                  <Sparkles className="w-3 h-3 text-emerald-400/70 flex-shrink-0" />
                  <span className="text-xs text-zinc-400 truncate">{name}</span>
                </div>
              ))}
          </div>
        ) : (
          <EmptyState text={t.taskPanel.skillsMcpEmpty} />
        )}
      </Card>
    </div>
  );
};

// ── Card 容器组件 ──

interface CardProps {
  title: string;
  count?: string;
  highlight?: boolean;
  rightElement?: React.ReactNode;
  isEmpty?: boolean;
  emptyLabel?: string;
  children: React.ReactNode;
}

function Card({ title, count, highlight, rightElement, isEmpty, emptyLabel, children }: CardProps) {
  const [expanded, setExpanded] = useState(true);

  // Compact single-line for empty cards
  if (isEmpty) {
    return (
      <div className="bg-white/[0.02] rounded-lg border border-white/[0.04] px-3 py-2 flex items-center justify-between">
        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{title}</span>
        <span className="text-[10px] text-zinc-600">{emptyLabel || '0'}</span>
      </div>
    );
  }

  return (
    <div className={`bg-white/[0.02] backdrop-blur-sm rounded-lg border ${
      highlight ? 'border-yellow-500/20' : 'border-white/[0.04]'
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center w-full px-3 py-2"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
            {title}
          </span>
          {count && (
            <span className="text-[10px] text-zinc-600">{count}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {rightElement && (
            <div onClick={(e) => e.stopPropagation()}>
              {rightElement}
            </div>
          )}
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** 空状态 */
function EmptyState({ text }: { text: string }) {
  return <div className="text-xs text-zinc-600 py-1">{text}</div>;
}
