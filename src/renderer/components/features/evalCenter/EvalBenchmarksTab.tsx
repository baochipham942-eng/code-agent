// ============================================================================
// EvalBenchmarksTab - 评测中心「跑分」tab（2026-08-29 爸拍板 R4）
//
// 这里只装配开跑、事件订阅和历史刷新；向导、进行中和历史分组各自在
// 独立文件内，避免 type-aware ESLint 在单个超大 JSX AST 上耗尽 CI heap。
// renderer 只传 scope/split/tags/maxCases，模型、密钥、目录和价格均由 host 决定。
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  EvalExperimentListItem,
  EvalRunEvent,
  EvalRunPanelProbe,
  EvalRunRequest,
  EvalRunSubscriptionResult,
} from '@shared/contract/evaluation';
import {
  evalRunPanelEn,
  evalRunPanelZh,
  type EvalRunPanelLabels,
} from '../../../i18n/evalRunPanel';
import { invokeEvaluation, onEvaluation } from '../../../services/evaluationRunIpc';
import ipcService from '../../../services/ipcService';
import { useAppStore } from '../../../stores/appStore';
import { Button } from '../../primitives/Button';
import {
  EvalRunHistory,
  getEvalRunConfig,
  getLatestEvalRun,
} from './EvalRunHistory';
import {
  EvalRunProgress,
  reduceEvalActiveRun,
  type EvalActiveRun,
} from './EvalRunProgress';
import {
  EvalRunWizard,
  type EvalRunSplit,
} from './EvalRunWizard';

const RUN_CONFIRM_WINDOW_MS = 5_000;

type LoadState = 'loading' | 'ready' | 'error';

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function splitLabel(
  split: string,
  labels: EvalRunPanelLabels,
): string {
  if (split === 'held-in') return labels.dailySet;
  if (split === 'held-out') return labels.heldOutSet;
  if (split === 'safety') return labels.safetySet;
  return split === 'all' ? labels.allSet : split;
}

export const EvalBenchmarksTab: React.FC = () => {
  const language = useAppStore((state) => state.language);
  const labels = language === 'zh' ? evalRunPanelZh.runPanel : evalRunPanelEn.runPanel;
  const [experiments, setExperiments] = useState<EvalExperimentListItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probe, setProbe] = useState<EvalRunPanelProbe | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [split, setSplit] = useState<EvalRunSplit>('held-in');
  const [tags, setTags] = useState<string[]>([]);
  const [maxCases, setMaxCases] = useState(1);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [activeRun, setActiveRun] = useState<EvalActiveRun | null>(null);
  const [quietNotice, setQuietNotice] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);

  const loadExperiments = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const list = await ipcService.invoke(IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS, { limit: 100 });
      setExperiments(list ?? []);
      setLoadState('ready');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void loadExperiments();
    void invokeEvaluation(IPC_CHANNELS.EVALUATION_RUN_EVENTS).then((result) => {
      if (result && 'environment' in result) {
        setProbe(result);
        setMaxCases(result.splitCounts['held-in']);
      }
    });
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      unsubscribeRef.current?.();
    };
  }, [loadExperiments]);

  const lastRun = useMemo(() => getLatestEvalRun(experiments), [experiments]);
  const estimatedCost = probe ? probe.estimatedCostPerCaseUsd * maxCases : undefined;

  const openWizard = useCallback((quick = false) => {
    setQuietNotice(null);
    setWizardOpen(true);
    setConfirmArmed(false);
    setSplit('held-in');
    setTags(quick ? (probe?.quickCheck.tags ?? ['core-path']) : []);
    setMaxCases(quick
      ? (probe?.quickCheck.maxCases ?? 12)
      : (probe?.splitCounts['held-in'] ?? 1));
  }, [probe]);

  const closeWizard = useCallback(() => {
    if (starting) return;
    setWizardOpen(false);
    setConfirmArmed(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, [starting]);

  const updateActiveRunFromEvent = useCallback((event: EvalRunEvent) => {
    if (event.schemaVersion !== 2) {
      setQuietNotice(labels.quietDegraded);
      setActiveRun(null);
      void loadExperiments();
      return;
    }
    if (event.type === 'error') {
      setQuietNotice(labels.quietDegraded);
      setActiveRun(null);
      unsubscribeRef.current?.();
      void loadExperiments();
      return;
    }
    if (event.type === 'run_end') {
      setQuietNotice(event.aborted ? labels.incomplete : null);
      setActiveRun(null);
      unsubscribeRef.current?.();
      void loadExperiments();
      return;
    }

    setActiveRun((current) => {
      if (current?.runId !== event.runId) return current;
      return reduceEvalActiveRun(current, event, labels);
    });
  }, [labels, loadExperiments]);

  const startRun = useCallback(async () => {
    setStarting(true);
    setQuietNotice(null);
    try {
      const request: EvalRunRequest = {
        scope: 'full',
        split,
        maxCases,
        ...(tags.length > 0 ? { tags } : {}),
      };
      const runResult = await invokeEvaluation(IPC_CHANNELS.EVALUATION_RUN_SUITE, request);
      if (!runResult || typeof runResult.runId !== 'string' || runResult.runId.length === 0) {
        throw new Error('Evaluation run did not return a runId');
      }
      const { runId } = runResult;
      const now = Date.now();
      setActiveRun({
        runId,
        split,
        model: probe?.model ?? 'unknown',
        provider: probe?.provider ?? 'unknown',
        plannedCaseIds: [],
        cases: {},
        startTs: now,
        lastTs: now,
        logs: [],
        toolCounts: {},
        stopping: false,
      });
      setWizardOpen(false);
      setConfirmArmed(false);

      let receivedRunEnd = false;
      // 先挂监听再 subscribe，避免 host 同步推送的 run_start 丢失。
      unsubscribeRef.current?.();
      const unsubscribe = onEvaluation(IPC_CHANNELS.EVALUATION_RUN_EVENTS, (event) => {
        if (event.runId !== runId) return;
        if (event.type === 'run_end') receivedRunEnd = true;
        updateActiveRunFromEvent(event);
      });
      unsubscribeRef.current = unsubscribe;
      if (!unsubscribe) {
        setQuietNotice(labels.quietDegraded);
        setActiveRun(null);
        return;
      }
      const subscription = await invokeEvaluation(
        IPC_CHANNELS.EVALUATION_RUN_EVENTS,
        { runId },
      ) as EvalRunSubscriptionResult;
      if (!subscription.running && !receivedRunEnd) {
        setQuietNotice(labels.endedBeforeSubscribe);
        setActiveRun(null);
        unsubscribe();
        void loadExperiments();
      }
    } catch {
      setQuietNotice(labels.runFailed);
    } finally {
      setStarting(false);
    }
  }, [labels, loadExperiments, maxCases, probe, split, tags, updateActiveRunFromEvent]);

  const handleRunClick = useCallback(() => {
    if (confirmArmed) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      void startRun();
      return;
    }
    setConfirmArmed(true);
    confirmTimerRef.current = setTimeout(() => setConfirmArmed(false), RUN_CONFIRM_WINDOW_MS);
  }, [confirmArmed, startRun]);

  const stopRun = useCallback(async () => {
    if (!activeRun || activeRun.stopping) return;
    setActiveRun((current) => current ? { ...current, stopping: true } : current);
    try {
      await invokeEvaluation(IPC_CHANNELS.EVALUATION_ABORT_RUN, { runId: activeRun.runId });
    } catch {
      setQuietNotice(labels.quietDegraded);
      setActiveRun(null);
      void loadExperiments();
    }
  }, [activeRun, labels.quietDegraded, loadExperiments]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950" data-testid="eval-benchmarks-tab">
      <div className="m-3 flex shrink-0 items-center rounded-lg bg-zinc-900 px-3 py-2 shadow-sm">
        <Button size="sm" onClick={() => openWizard(false)}>{labels.launch}</Button>
        {lastRun && (
          <span className="ml-auto text-xs text-zinc-500">
            {replace(labels.lastRun, {
              set: splitLabel(getEvalRunConfig(lastRun).split, labels),
              model: lastRun.model ?? 'unknown',
              k: getEvalRunConfig(lastRun).k,
            })}
          </span>
        )}
      </div>

      {activeRun && (
        <EvalRunProgress run={activeRun} labels={labels} onStop={() => void stopRun()} />
      )}

      {quietNotice && (
        <div className="mx-3 mb-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400" role="status">
          {quietNotice}
        </div>
      )}

      <EvalRunHistory
        experiments={experiments}
        loadState={loadState}
        loadError={loadError}
        hasActiveRun={Boolean(activeRun)}
        probe={probe}
        labels={labels}
        language={language}
        loadingText={labels.loading}
        onRefresh={() => void loadExperiments()}
        onOpenWizard={openWizard}
      />

      <EvalRunWizard
        open={wizardOpen}
        probe={probe}
        split={split}
        tags={tags}
        maxCases={maxCases}
        confirmArmed={confirmArmed}
        starting={starting}
        estimatedCost={estimatedCost}
        labels={labels}
        onClose={closeWizard}
        onSplit={(next) => {
          setSplit(next);
          setMaxCases(probe?.splitCounts[next] ?? 1);
          setConfirmArmed(false);
        }}
        onToggleTag={(tag) => {
          setTags((current) => current.includes(tag)
            ? current.filter((item) => item !== tag)
            : [...current, tag]);
          setConfirmArmed(false);
        }}
        onMaxCases={(next) => {
          setMaxCases(next);
          setConfirmArmed(false);
        }}
        onRun={handleRunClick}
      />
    </div>
  );
};
