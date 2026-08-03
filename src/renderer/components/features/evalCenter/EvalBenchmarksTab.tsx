// ============================================================================
// EvalBenchmarksTab - 评测中心「基准」tab（eval-harness 跑分结果只读视图）
//
// 契约：
// - 只读不编排：数据源是 host 侧 experiments / experiment_cases 表（ExperimentAdapter
//   落盘，source ∈ test-runner / eval-harness / regression），走两条只读 IPC：
//   EVALUATION_LIST_EXPERIMENTS（列表）+ EVALUATION_LOAD_EXPERIMENT（用例行，回归对比）。
// - 布局三层：① aily 五关卡分层条（静态分组框架，i18n 文案，不接自动判定——
//   关卡与跑分结果的挂载关系留给后续手工/规则层）；② 按「source + 归一数据集名」
//   分组的跑分列表（name 的日期/时间戳后缀归一为数据集名，见 evalDatasetName.ts，
//   同一数据集的多次跑分归到一组）；③ 组内「最近两次对比」（同一归一名下按时间
//   取最近两次：通过率 delta + 用例状态变迁），点展开才懒加载用例行。
// - 状态变迁口径：passed → 通过侧，failed/error → 失败侧，partial/skipped 不参与
//   对比（与 ADR-036 F2「skipped 不进能力分母」一致）。
// ============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  EvalExperimentCaseItem,
  EvalExperimentDetail,
  EvalExperimentListItem,
} from '@shared/contract/evaluation';
import ipcService from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';
import { groupExperimentsByDataset, type EvalDatasetGroup } from './evalDatasetName';

type LoadState = 'loading' | 'ready' | 'error';

interface CaseTransition {
  caseId: string;
  kind: 'regressed' | 'fixed';
  from: string;
  to: string;
}

interface GroupComparison {
  current: EvalExperimentDetail;
  previous: EvalExperimentDetail;
  transitions: CaseTransition[];
}

/** 对比口径：passed=通过侧，failed/error=失败侧，其余（partial/skipped）不参与。 */
function caseSide(status: string): 'pass' | 'fail' | null {
  if (status === 'passed') return 'pass';
  if (status === 'failed' || status === 'error') return 'fail';
  return null;
}

function computeTransitions(currentCases: EvalExperimentCaseItem[], previousCases: EvalExperimentCaseItem[]): CaseTransition[] {
  const previousByCaseId = new Map(previousCases.map((c) => [c.caseId, c]));
  const transitions: CaseTransition[] = [];
  for (const current of currentCases) {
    const previous = previousByCaseId.get(current.caseId);
    if (!previous) continue;
    const from = caseSide(previous.status);
    const to = caseSide(current.status);
    if (!from || !to || from === to) continue;
    transitions.push({
      caseId: current.caseId,
      kind: to === 'fail' ? 'regressed' : 'fixed',
      from: previous.status,
      to: current.status,
    });
  }
  return transitions;
}

function formatPercent(rate: number | undefined): string {
  if (rate === undefined || Number.isNaN(rate)) return '--';
  return `${(rate * 100).toFixed(1)}%`;
}

export const EvalBenchmarksTab: React.FC = () => {
  const { t } = useI18n();
  const b = t.evalCenter.benchmarks;

  const [experiments, setExperiments] = useState<EvalExperimentListItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [comparisons, setComparisons] = useState<Record<string, GroupComparison | 'loading' | 'needTwo'>>({});

  const loadExperiments = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const list = await ipcService.invoke(IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS, { limit: 100 });
      setExperiments(list ?? []);
      setLoadState('ready');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  const LEVELS = [
    { name: b.level1Name, desc: b.level1Desc },
    { name: b.level2Name, desc: b.level2Desc },
    { name: b.level3Name, desc: b.level3Desc },
    { name: b.level4Name, desc: b.level4Desc },
    { name: b.level5Name, desc: b.level5Desc },
  ];

  const sourceLabel = useCallback((source: string): string => {
    switch (source) {
      case 'eval-harness': return b.sourceEvalHarness;
      case 'test-runner': return b.sourceTestRunner;
      case 'regression': return b.sourceRegression;
      default: return source;
    }
  }, [b]);

  // 按「source + 归一数据集名」分组（组内按时间倒序）。
  const groups = useMemo(() => groupExperimentsByDataset(experiments), [experiments]);

  // 展开分组时懒加载该数据集最近两次运行的用例行并计算状态变迁。
  const toggleGroup = useCallback(async (group: EvalDatasetGroup) => {
    if (expandedGroup === group.key) {
      setExpandedGroup(null);
      return;
    }
    setExpandedGroup(group.key);
    if (comparisons[group.key]) return;
    if (group.runs.length < 2) {
      setComparisons((prev) => ({ ...prev, [group.key]: 'needTwo' }));
      return;
    }
    setComparisons((prev) => ({ ...prev, [group.key]: 'loading' }));
    try {
      const [current, previous] = await Promise.all([
        ipcService.invoke(IPC_CHANNELS.EVALUATION_LOAD_EXPERIMENT, group.runs[0].id),
        ipcService.invoke(IPC_CHANNELS.EVALUATION_LOAD_EXPERIMENT, group.runs[1].id),
      ]);
      if (!current || !previous) {
        setComparisons((prev) => ({ ...prev, [group.key]: 'needTwo' }));
        return;
      }
      setComparisons((prev) => ({
        ...prev,
        [group.key]: {
          current,
          previous,
          transitions: computeTransitions(current.cases, previous.cases),
        },
      }));
    } catch {
      setComparisons((prev) => ({ ...prev, [group.key]: 'needTwo' }));
    }
  }, [expandedGroup, comparisons]);

  const renderComparison = (group: EvalDatasetGroup) => {
    const comparison = comparisons[group.key];
    if (!comparison || comparison === 'loading') {
      return <div className="px-3 py-2 text-xs text-zinc-500">{b.compareLoading}</div>;
    }
    if (comparison === 'needTwo') {
      return <div className="px-3 py-2 text-xs text-zinc-500">{b.compareNeedTwo}</div>;
    }
    const currentRate = comparison.current.experiment.summary?.passRate;
    const previousRate = comparison.previous.experiment.summary?.passRate;
    const delta = currentRate !== undefined && previousRate !== undefined ? currentRate - previousRate : undefined;
    const regressed = comparison.transitions.filter((tr) => tr.kind === 'regressed');
    const fixed = comparison.transitions.filter((tr) => tr.kind === 'fixed');
    const unchanged = comparison.current.cases.length - comparison.transitions.length;

    return (
      <div className="border-t border-zinc-800 px-3 py-2" data-testid={`benchmark-compare-${group.source}-${group.dataset}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-zinc-300">{b.compareTitle}</span>
          {delta !== undefined && (
            <span className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${
              delta < 0
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                : delta > 0
                  ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400'
            }`}>
              {delta < 0 ? <TrendingDown className="h-3 w-3" /> : delta > 0 ? <TrendingUp className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
              {formatPercent(previousRate)} → {formatPercent(currentRate)}
            </span>
          )}
          <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-rose-200">
            {b.regressedCount.replace('{n}', String(regressed.length))}
          </span>
          <span className="rounded border border-badge-success/30 bg-emerald-500/10 px-1.5 py-0.5 text-badge-success">
            {b.fixedCount.replace('{n}', String(fixed.length))}
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
            {b.unchangedCount.replace('{n}', String(unchanged))}
          </span>
        </div>
        {comparison.transitions.length === 0 ? (
          <div className="text-xs text-zinc-500">{b.noCaseChanges}</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {comparison.transitions.map((tr) => (
              <li key={tr.caseId} className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                  tr.kind === 'regressed' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-badge-success'
                }`}>
                  {tr.kind === 'regressed' ? b.caseStatusRegressed : b.caseStatusFixed}
                </span>
                <span className="font-mono text-zinc-400">{tr.caseId}</span>
                <span className="text-zinc-600">{tr.from} → {tr.to}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="eval-benchmarks-tab">
      {/* 五关卡分层条：静态分组框架（不接自动判定） */}
      <div className="shrink-0 border-b border-zinc-800 px-3 py-2">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-xs font-medium text-zinc-300">{b.levelsTitle}</span>
          <span className="text-[10px] text-zinc-600">{b.levelsNote}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
          {LEVELS.map((level, index) => (
            <div key={level.name} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2" data-testid={`benchmark-level-${index + 1}`}>
              <div className="text-xs font-medium text-zinc-200">Lv.{index + 1} {level.name}</div>
              <div className="mt-0.5 text-[10px] leading-4 text-zinc-500">{level.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 跑分结果列表（按 source + 归一数据集名分组） */}
      <div className="flex shrink-0 items-center justify-between px-3 pt-2">
        <span className="text-xs font-medium text-zinc-300">{b.runsTitle}</span>
        <button /* ds-allow:button: 基准 tab 刷新按钮，12px 微尺寸行内样式，Button primitive 无对应变体 */
          type="button"
          onClick={() => {
            setComparisons({});
            void loadExperiments();
          }}
          className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          <RefreshCw className="h-3 w-3" /> {b.refresh}
        </button>
      </div>

      {loadState === 'loading' && (
        <div className="px-3 py-8 text-center text-sm text-zinc-500">{t.settings.modal.loading}</div>
      )}
      {loadState === 'error' && (
        <div className="px-3 py-8 text-center text-sm text-rose-300">
          {b.loadFailed.replace('{message}', loadError ?? '')}
        </div>
      )}
      {loadState === 'ready' && experiments.length === 0 && (
        <div className="px-3 py-8 text-center text-sm text-zinc-500">{b.empty}</div>
      )}

      {loadState === 'ready' && groups.map((group) => {
        const latest = group.runs[0];
        const expanded = expandedGroup === group.key;
        return (
          <div key={group.key} className="mx-3 mt-2 rounded-lg border border-zinc-800 bg-zinc-900/70" data-testid={`benchmark-group-${group.source}-${group.dataset}`}>
            <button /* ds-allow:button: 基准分组头（整块可点展开行），Button primitive 无行卡片变体 */
              type="button"
              onClick={() => void toggleGroup(group)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />}
              <span className="text-xs font-medium text-zinc-200">{group.dataset}</span>
              <span className="text-[10px] text-zinc-600">{sourceLabel(group.source)}</span>
              <span className="text-[10px] text-zinc-500">{b.runs.replace('{n}', String(group.runs.length))}</span>
              <span className="ml-auto text-xs text-zinc-400">
                {b.passRate} {formatPercent(latest?.summary?.passRate)}
              </span>
            </button>

            {expanded && (
              <>
                <div className="border-t border-zinc-800">
                  {group.runs.map((run) => (
                    <div key={run.id} className="flex items-center gap-3 border-b border-zinc-800/60 px-3 py-1.5 text-xs last:border-b-0">
                      <span className="min-w-0 flex-1 truncate text-zinc-300">{run.name}</span>
                      <span className="text-[10px] text-zinc-500">{new Date(run.timestamp).toLocaleString()}</span>
                      <span className="w-28 truncate text-[10px] text-zinc-500">{run.model ?? '--'}</span>
                      <span className="w-16 text-right text-[10px] text-zinc-400">
                        {run.summary?.passed ?? '--'}/{run.summary?.total ?? '--'}
                      </span>
                      <span className="w-14 text-right text-zinc-300">{formatPercent(run.summary?.passRate)}</span>
                    </div>
                  ))}
                </div>
                {renderComparison(group)}
              </>
            )}
          </div>
        );
      })}
      <div className="h-3 shrink-0" />
    </div>
  );
};
