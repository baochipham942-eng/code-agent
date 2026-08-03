// ============================================================================
// MemoryDiagnosticsSections - 设置 → 记忆 诊断区内容（Light Memory 健康 + Injection Trace）
// ============================================================================
//
// 2026-08-02 从 features/knowledge/KnowledgeMemoryPanel.tsx 搬入（整窗页壳子退役，
// 两块诊断能力并入 MemoryTab 既有 SettingsDetails 诊断区，不另起并列分区）。
// 组件逻辑未改；外壳从整窗页卡片（rounded-lg border-zinc-800 bg-zinc-900/70）
// 改为设置页诊断区内的内联分块，对齐 SettingsDetails 里既有内容的观感。

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useI18n } from '../../../../hooks/useI18n';
import { zh, type Translations } from '../../../../i18n';
import {
  buildLightMemoryIssuePreview,
  countLightMemoryHealthIssues,
  invokeMemoryAudit,
  invokeMemoryCommand,
  type LightMemoryHealthReport,
  type LightMemoryRebuildResult,
  type MemoryInjectionTrace,
} from './memoryAuditClient';

export function LightMemoryHealthPanel({
  health,
  rebuildResult,
  isLoading,
  isRebuilding,
  onRebuild,
}: {
  health: LightMemoryHealthReport | null;
  rebuildResult: LightMemoryRebuildResult | null;
  isLoading: boolean;
  isRebuilding: boolean;
  onRebuild: () => void;
}) {
  const { t } = useI18n();
  const issueCount = countLightMemoryHealthIssues(health);
  const issuePreview = health ? buildLightMemoryIssuePreview(health, t) : [];
  const statusLabel = !health || isLoading
    ? t.knowledgeMemory.healthCheckingStatus
    : issueCount === 0
      ? t.knowledgeMemory.healthHealthyStatus
      : t.knowledgeMemory.healthIssueCountStatus.replace('{count}', String(issueCount));
  const statusTone = !health || isLoading
    ? 'border-zinc-700 bg-zinc-900 text-zinc-400'
    : issueCount === 0
      ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200';

  return (
    <div data-testid="light-memory-health-panel">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-xs text-zinc-400">Light Memory</span>
          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${statusTone}`}>{statusLabel}</span>
        </div>
        <button
          type="button"
          onClick={onRebuild}
          disabled={isLoading || isRebuilding}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRebuilding ? 'animate-spin' : ''}`} />
          {t.knowledgeMemory.healthRebuildIndex}
        </button>
      </div>
      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
        <div className="grid grid-cols-3 gap-2">
          <HealthMetric label={t.knowledgeMemory.healthMetricFiles} value={health?.totalFiles ?? '-'} />
          <HealthMetric label={t.knowledgeMemory.healthMetricIndexLines} value={health?.indexLineCount ?? '-'} />
          <HealthMetric label={t.knowledgeMemory.healthMetricIssues} value={issueCount} />
        </div>
        {issuePreview.length > 0 ? (
          <div className="space-y-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-4 text-amber-100">
            {issuePreview.map((item) => (
              <div key={item} className="flex gap-1.5">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="break-all">{item}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[11px] text-zinc-500">
            {t.knowledgeMemory.healthIndexConsistent}
          </div>
        )}
        {rebuildResult ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[11px] leading-4 text-zinc-400">
            {t.knowledgeMemory.healthRebuildSummary.replace('{indexed}', String(rebuildResult.indexedFiles)).replace('{total}', String(rebuildResult.totalFiles))}
            {rebuildResult.skippedFiles.length > 0 ? t.knowledgeMemory.healthRebuildSkipped.replace('{count}', String(rebuildResult.skippedFiles.length)) : ''}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HealthMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold leading-none text-zinc-100">{value}</div>
    </div>
  );
}

export function MemoryInjectionTraceList({ traces }: { traces: MemoryInjectionTrace[] }) {
  const { t } = useI18n();
  const recentTraces = traces.slice(0, 5);
  return (
    <div data-testid="memory-injection-traces">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-xs text-zinc-400">Injection Trace</span>
        </div>
        <span className="text-[11px] text-zinc-600">{t.knowledgeMemory.countSuffix.replace('{count}', String(traces.length))}</span>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
        {recentTraces.length === 0 ? (
          <div className="text-[11px] text-zinc-500">{t.knowledgeMemory.injectionTraceEmpty}</div>
        ) : (
          <div className="grid gap-1.5">
            {recentTraces.map((trace) => (
              <div key={trace.id} className="flex min-w-0 items-center gap-2 text-[11px] leading-4">
                <span className={`shrink-0 rounded border px-1.5 py-0.5 ${trace.injected ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success' : 'border-zinc-700 bg-zinc-900 text-zinc-500'}`}>
                  {trace.injected ? t.knowledgeMemory.injectionTraceInjected : t.knowledgeMemory.injectionTraceNotInjected}
                </span>
                <span className="shrink-0 font-medium text-zinc-300">{trace.blockType}</span>
                <span className="min-w-0 truncate text-zinc-500">{trace.trigger} · {t.knowledgeMemory.injectionTraceUnitCount.replace('{count}', String(trace.count))} · {trace.chars} chars</span>
                <span className="ml-auto shrink-0 text-zinc-600">{formatTraceTime(trace.timestamp, t)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTraceTime(timestamp: number, t: Translations = zh): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return t.knowledgeMemory.traceTimeUnknown;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 自管数据的容器：MemoryTab 诊断区只挂这一个组件，健康检查与注入trace各自拉取、
// 重建索引后内部重拉，不侵入 MemoryTab 的文件列表加载链路。
export function MemoryDiagnosticsSection() {
  const { t } = useI18n();
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [lightHealth, setLightHealth] = useState<LightMemoryHealthReport | null>(null);
  const [rebuildResult, setRebuildResult] = useState<LightMemoryRebuildResult | null>(null);
  const [traces, setTraces] = useState<MemoryInjectionTrace[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDiagnostics = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [result, health] = await Promise.all([
        invokeMemoryAudit({
          projectPath: workingDirectory,
          sessionId: currentSessionId,
        }),
        invokeMemoryCommand<LightMemoryHealthReport>('lightHealth'),
      ]);
      setTraces(result.injectionTraces ?? []);
      setLightHealth(health);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTraces([]);
      setLightHealth(null);
    } finally {
      setIsLoading(false);
    }
  }, [currentSessionId, workingDirectory]);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const handleRebuildLightIndex = useCallback(async () => {
    setIsRebuildingIndex(true);
    setError(null);
    try {
      const result = await invokeMemoryCommand<LightMemoryRebuildResult>('lightRebuildIndex');
      setRebuildResult(result);
      await loadDiagnostics();
    } catch (err) {
      setError(t.knowledgeMemory.lightRebuildFailed.replace('{message}', err instanceof Error ? err.message : String(err)));
    } finally {
      setIsRebuildingIndex(false);
    }
  }, [loadDiagnostics, t]);

  return (
    <div className="space-y-4" data-testid="memory-diagnostics-section">
      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-badge-danger">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : null}
      <LightMemoryHealthPanel
        health={lightHealth}
        rebuildResult={rebuildResult}
        isLoading={isLoading}
        isRebuilding={isRebuildingIndex}
        onRebuild={() => void handleRebuildLightIndex()}
      />
      <MemoryInjectionTraceList traces={traces} />
    </div>
  );
}
