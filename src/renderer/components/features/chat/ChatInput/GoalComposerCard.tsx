import React, { useMemo, useState } from 'react';
import { Loader2, Target, X } from 'lucide-react';
import type { GoalComposerDraft } from './parseGoalCommand';

interface GoalComposerCardProps {
  submitting: boolean;
  onSubmit: (draft: GoalComposerDraft) => void;
  onDismiss: () => void;
}

function parsePositiveInteger(raw: string): number | undefined {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const GoalComposerCard: React.FC<GoalComposerCardProps> = ({
  submitting,
  onSubmit,
  onDismiss,
}) => {
  const [goal, setGoal] = useState('');
  const [verify, setVerify] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [boundaries, setBoundaries] = useState('只修改与目标直接相关的文件和配置，避免无关重构、无关功能和破坏性操作。');
  const [pauseConditions, setPauseConditions] = useState('需要凭证、付费、生产数据、破坏性操作、范围扩大，或连续 2 轮验证失败且没有新证据时暂停。');
  const [maxTurns, setMaxTurns] = useState('');
  const [budget, setBudget] = useState('');
  const [maxTime, setMaxTime] = useState('');

  const draft = useMemo<GoalComposerDraft>(() => ({
    goal,
    verify,
    acceptance,
    boundaries,
    pauseConditions,
    maxTurns: parsePositiveInteger(maxTurns),
    budget: parsePositiveInteger(budget),
    wallClockMinutes: parsePositiveInteger(maxTime),
  }), [acceptance, boundaries, budget, goal, maxTime, maxTurns, pauseConditions, verify]);

  const canStart = goal.trim().length > 0 && !submitting;

  return (
    <div
      data-goal-composer
      className="mb-2 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-3 animate-fadeIn"
    >
      <div className="flex items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sky-300">目标合同</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="p-0.5 text-zinc-500 transition-colors hover:text-zinc-300"
          title="取消"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5 space-y-2">
        <label className="block">
          <span className="mb-1 block text-[10px] text-sky-200/60">目标</span>
          <textarea
            data-goal-field="goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="交付什么结果"
            rows={2}
            autoFocus
            className="w-full resize-none rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] text-sky-200/60">验证命令</span>
          <input
            data-goal-field="verify"
            type="text"
            value={verify}
            onChange={(e) => setVerify(e.target.value)}
            placeholder="npm test、npm run typecheck、或留空"
            className="w-full rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] text-sky-200/60">软验收</span>
          <textarea
            data-goal-field="acceptance"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            placeholder="结果需要满足哪些条件"
            rows={2}
            className="w-full resize-none rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] text-sky-200/60">边界</span>
          <textarea
            data-goal-field="boundaries"
            value={boundaries}
            onChange={(e) => setBoundaries(e.target.value)}
            rows={2}
            className="w-full resize-none rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] text-sky-200/60">暂停条件</span>
          <textarea
            data-goal-field="pause"
            value={pauseConditions}
            onChange={(e) => setPauseConditions(e.target.value)}
            rows={2}
            className="w-full resize-none rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
          />
        </label>

        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] text-sky-200/60">轮次上限</span>
            <input
              data-goal-field="max-turns"
              type="number"
              min={1}
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              placeholder="默认"
              className="w-full rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-sky-200/60">Token 预算</span>
            <input
              data-goal-field="budget"
              type="number"
              min={1}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="默认"
              className="w-full rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-sky-200/60">时间上限(分)</span>
            <input
              data-goal-field="max-time"
              type="number"
              min={1}
              value={maxTime}
              onChange={(e) => setMaxTime(e.target.value)}
              placeholder="不限"
              className="w-full rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
            />
          </label>
        </div>

        <div className="flex items-center justify-end pt-0.5">
          <button
            type="button"
            data-goal-start
            onClick={() => canStart && onSubmit(draft)}
            disabled={!canStart}
            className="flex items-center gap-1 rounded bg-sky-500/20 px-3 py-1 text-xs text-sky-100 transition-colors hover:bg-sky-500/30 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Target className="h-3 w-3" />}
            启动目标
          </button>
        </div>
      </div>
    </div>
  );
};
