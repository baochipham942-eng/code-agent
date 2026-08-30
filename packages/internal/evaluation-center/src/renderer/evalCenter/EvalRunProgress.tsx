import React, { useRef, useState } from 'react';
import { ArrowDown, Check, Circle, Minus, X } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { EvalRunEvent } from '@shared/contract/evaluation';
import type { EvalRunPanelLabels } from '../i18n/evalRunPanel';
import { Button } from '@renderer/components/primitives/Button';
import type { EvalRunSplit } from './EvalRunWizard';

type CasePresentationStatus = 'waiting' | 'running' | 'passed' | 'failed' | 'excluded';

interface CasePresentation {
  id: string;
  displayId?: string;
  status: CasePresentationStatus;
  result: string;
}

interface LogLine {
  id: string;
  text: string;
  caseId?: string;
  kind?: 'tools';
}

export interface EvalActiveRun {
  runId: string;
  split: EvalRunSplit;
  model: string;
  provider: string;
  plannedCaseIds: string[];
  cases: Record<string, CasePresentation>;
  currentCaseId?: string;
  startTs: number;
  lastTs: number;
  logs: LogLine[];
  toolCounts: Record<string, number>;
  stopping: boolean;
}

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function splitLabel(split: string, labels: EvalRunPanelLabels): string {
  if (split === 'held-in') return labels.dailySet;
  if (split === 'held-out') return labels.heldOutSet;
  if (split === 'safety') return labels.safetySet;
  return split === 'all' ? labels.allSet : split;
}

function appendLog(run: EvalActiveRun, line: LogLine): LogLine[] {
  if (line.kind === 'tools' && line.caseId) {
    const existing = run.logs.findIndex((item) => item.kind === 'tools' && item.caseId === line.caseId);
    if (existing >= 0) return run.logs.map((item, index) => index === existing ? line : item);
  }
  return [...run.logs, line];
}

export function reduceEvalActiveRun(
  current: EvalActiveRun,
  event: Exclude<EvalRunEvent, { type: 'error' | 'run_end' }>,
  labels: EvalRunPanelLabels,
): EvalActiveRun {
  const next: EvalActiveRun = { ...current, lastTs: event.ts };
  if (event.type === 'run_start') {
    const plannedCaseIds = event.config.compare
      ? event.plannedCaseIds.flatMap((id) => [`${id}:baseline`, `${id}:candidate`])
      : event.plannedCaseIds;
    const cases = Object.fromEntries(plannedCaseIds.map((id) => [id, {
      id,
      displayId: id.endsWith(':baseline')
        ? `${id.slice(0, -9)} · ${labels.baselineGroup}`
        : id.endsWith(':candidate') ? `${id.slice(0, -10)} · ${labels.candidateGroup}` : id,
      status: 'waiting' as const,
      result: labels.noResult,
    }]));
    return {
      ...next,
      model: event.config.model,
      provider: event.config.provider,
      plannedCaseIds,
      cases,
      startTs: event.ts,
      logs: appendLog(next, { id: `${event.ts}:start`, text: labels.runStarted }),
    };
  }
  if (event.type === 'case_start') {
    const item: CasePresentation = { id: event.testId, status: 'running', result: labels.running };
    return {
      ...next,
      currentCaseId: event.testId,
      cases: { ...next.cases, [event.testId]: item },
      logs: appendLog(next, {
        id: `${event.ts}:case-start:${event.testId}`,
        caseId: event.testId,
        text: replace(labels.caseStarted, { caseId: event.testId }),
      }),
    };
  }
  if (event.type === 'case_end') {
    const caseKey = event.arm ? `${event.testId}:${event.arm}` : event.testId;
    let status: CasePresentationStatus = 'failed';
    let result = event.failureReason ?? labels.failed;
    if (event.status === 'passed') {
      status = 'passed';
      result = labels.passed;
    } else if (event.status === 'infra_excluded') {
      status = 'excluded';
      result = labels.excluded;
    } else if (['skipped', 'partial', 'cost_exceeded', 'not_run'].includes(event.status)) {
      status = 'excluded';
      result = event.status === 'cost_exceeded' ? labels.costExceeded : labels.skipped;
    }
    const line = status === 'passed'
      ? replace(labels.casePassed, { caseId: event.testId })
      : status === 'excluded'
        ? replace(labels.caseExcluded, { caseId: event.testId })
        : replace(labels.caseFailed, { caseId: event.testId, reason: result });
    return {
      ...next,
      cases: { ...next.cases, [caseKey]: {
        id: caseKey,
        displayId: event.arm ? `${event.testId} · ${event.arm === 'baseline' ? labels.baselineGroup : labels.candidateGroup}` : event.testId,
        status,
        result,
      } },
      logs: appendLog(next, {
        id: `${event.ts}:case-end:${event.testId}`,
        caseId: event.testId,
        text: line,
      }),
    };
  }
  if (event.type === 'tool_call') {
    const count = (next.toolCounts[event.testId] ?? 0) + 1;
    return {
      ...next,
      toolCounts: { ...next.toolCounts, [event.testId]: count },
      logs: appendLog(next, {
        id: `tools:${event.testId}`,
        kind: 'tools',
        caseId: event.testId,
        text: replace(labels.toolsCalled, { caseId: event.testId, count }),
      }),
    };
  }
  if (event.type === 'skill_activated') {
    return { ...next, logs: appendLog(next, {
      id: `${event.ts}:skill:${event.testId}`,
      caseId: event.testId,
      text: replace(labels.skillActivated, { caseId: event.testId, name: event.name }),
    }) };
  }
  if (event.type === 'memory_injected') {
    return { ...next, logs: appendLog(next, {
      id: `${event.ts}:memory:${event.testId}`,
      caseId: event.testId,
      text: replace(labels.memoryInjected, { caseId: event.testId }),
    }) };
  }
  if (event.type === 'subagent_spawned') {
    return { ...next, logs: appendLog(next, {
      id: `${event.ts}:collaborator:${event.testId}`,
      caseId: event.testId,
      text: replace(labels.subagentSpawned, { caseId: event.testId }),
    }) };
  }
  return next;
}

interface EvalRunProgressProps {
  run: EvalActiveRun;
  labels: EvalRunPanelLabels;
  onStop(): void;
}

export const EvalRunProgress: React.FC<EvalRunProgressProps> = ({ run, labels, onStop }) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const cases = run.plannedCaseIds.map((id) => run.cases[id] ?? {
    id,
    status: 'waiting' as const,
    result: labels.noResult,
  });
  const completed = cases.filter((item) => !['waiting', 'running'].includes(item.status)).length;
  const runningIndex = cases.findIndex((item) => item.status === 'running');
  const current = cases.length === 0 ? 0 : Math.min(
    cases.length,
    runningIndex >= 0 ? runningIndex + 1 : completed,
  );

  return (
    <section className="mx-3 mb-3 overflow-hidden rounded-lg bg-zinc-900 shadow-sm" data-testid="eval-run-active">
      <div className="flex items-center gap-3 bg-zinc-800/70 px-3 py-2 text-xs text-zinc-400">
        <span className="font-medium text-zinc-200">
          {replace(labels.runningSet, {
            set: splitLabel(run.split, labels),
            model: run.model,
            current,
            total: cases.length || '—',
            duration: formatDuration(run.lastTs - run.startTs),
          })}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto text-[var(--cc-error)]" onClick={onStop} disabled={run.stopping}>
          {run.stopping ? labels.stopping : labels.stop}
        </Button>
      </div>
      <div className="grid min-h-80 grid-cols-1 lg:grid-cols-[2fr_3fr]">
        <div className="max-h-96 overflow-y-auto border-b border-zinc-800 lg:border-b-0 lg:border-r">
          {cases.map((item) => (
            <div key={item.id} className={`flex items-center gap-2 border-b border-zinc-800/70 px-3 py-2 text-xs ${item.status === 'running' ? 'bg-zinc-800/60' : ''}`}>
              <CaseStatusIcon status={item.status} />
              <span className="w-36 truncate font-mono text-zinc-300">{item.displayId ?? item.id}</span>
              <span className={`min-w-0 flex-1 truncate ${item.status === 'failed' ? 'text-[var(--cc-error)]' : item.status === 'passed' ? 'text-[var(--cc-success)]' : 'text-zinc-500'}`}>
                {item.result}
              </span>
            </div>
          ))}
        </div>
        <div className="relative min-h-80 bg-zinc-950">
          <div className="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-400">{labels.logTitle}</div>
          <Virtuoso
            ref={virtuosoRef}
            role="log"
            aria-live="polite"
            data={run.logs}
            className="h-64 font-mono text-xs lg:h-80"
            itemContent={(_index, line) => (
              <div className="px-3 py-1.5 text-zinc-400">
                <span className="mr-2 text-zinc-600">{formatDuration(run.lastTs - run.startTs)}</span>
                {line.text}
              </div>
            )}
            followOutput={(atBottom) => atBottom ? 'auto' : false}
            atBottomStateChange={setIsAtBottom}
            atBottomThreshold={48}
          />
          <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
            <Check className="h-3 w-3" /> {labels.autoScroll}
          </div>
          {!isAtBottom && run.logs.length > 0 && (
            <button /* ds-allow:button: 虚拟日志回底悬浮按钮，IconButton 无绝对居中定位语义 */
              type="button"
              aria-label={labels.jumpToBottom}
              onClick={() => virtuosoRef.current?.scrollToIndex({ index: run.logs.length - 1, align: 'end' })}
              className="absolute bottom-10 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 shadow-lg"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

const CaseStatusIcon: React.FC<{ status: CasePresentationStatus }> = ({ status }) => {
  if (status === 'passed') return <Check className="h-3.5 w-3.5 text-[var(--cc-success)]" />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-[var(--cc-error)]" />;
  if (status === 'running') return <span className="w-3.5 animate-pulse font-mono text-[var(--cc-brand)]">⠋</span>;
  if (status === 'excluded') return <Minus className="h-3.5 w-3.5 text-[var(--cc-muted)]" />;
  return <Circle className="h-3.5 w-3.5 text-[var(--cc-gutter)]" />;
};
