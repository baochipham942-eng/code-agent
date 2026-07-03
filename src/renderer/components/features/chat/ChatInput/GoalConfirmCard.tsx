import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Target, X } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import type { GoalComposerDraft } from './parseGoalCommand';

// ============================================================================
// /goal 安静确认卡 —— 主路径落点
// ----------------------------------------------------------------------------
// 默认只有三件事：目标（预填用户原话，可改）、验证命令（项目探测候选下拉，
// fail-closed：只能从真实候选选或留空）、启动。其余合同字段折叠在「高级编辑」，
// 高级编辑里的自定义验证命令由用户手输，延续「用户写的=已授权」前提。
// ============================================================================

/** 下拉里"留空"选项的哨兵值 */
const VERIFY_NONE = '';

interface GoalConfirmCardProps {
  /** 预填目标（/goal 后面的自然语言原话；空串 = 引导态） */
  initialGoal: string;
  /** 项目探测出的验证命令候选（package.json scripts），可为空 */
  verifyCandidates: string[];
  submitting: boolean;
  onSubmit: (draft: GoalComposerDraft) => void;
  onDismiss: () => void;
  /** 初始展开高级编辑（默认折叠） */
  initialAdvancedOpen?: boolean;
}

function parsePositiveInteger(raw: string): number | undefined {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const GoalConfirmCard: React.FC<GoalConfirmCardProps> = ({
  initialGoal,
  verifyCandidates,
  submitting,
  onSubmit,
  onDismiss,
  initialAdvancedOpen = false,
}) => {
  const { t } = useI18n();
  const [goal, setGoal] = useState(initialGoal);
  const [verifySelected, setVerifySelected] = useState(
    verifyCandidates.length > 0 ? verifyCandidates[0] : VERIFY_NONE,
  );
  const [advancedOpen, setAdvancedOpen] = useState(initialAdvancedOpen);
  const [verifyCustom, setVerifyCustom] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [boundaries, setBoundaries] = useState(t.goalConfirm.defaultBoundaries);
  const [pauseConditions, setPauseConditions] = useState(t.goalConfirm.defaultPauseConditions);
  const [maxTurns, setMaxTurns] = useState('');
  const [budget, setBudget] = useState('');
  const [maxTime, setMaxTime] = useState('');

  // 自定义命令（用户手输，已授权）优先于候选下拉
  const effectiveVerify = verifyCustom.trim() || verifySelected;

  const draft = useMemo<GoalComposerDraft>(() => ({
    goal,
    verify: effectiveVerify,
    acceptance,
    boundaries,
    pauseConditions,
    maxTurns: parsePositiveInteger(maxTurns),
    budget: parsePositiveInteger(budget),
    wallClockMinutes: parsePositiveInteger(maxTime),
  }), [acceptance, boundaries, budget, effectiveVerify, goal, maxTime, maxTurns, pauseConditions]);

  const canStart = goal.trim().length > 0 && !submitting;

  const fieldClass = 'w-full rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50';
  const labelClass = 'mb-1 block text-[10px] text-sky-200/60';

  return (
    <div
      data-goal-composer
      className="mb-2 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-3 animate-fadeIn"
    >
      <div className="flex items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sky-300">{t.goalConfirm.title}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="p-0.5 text-zinc-500 transition-colors hover:text-zinc-300"
          title={t.goalConfirm.cancel}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5 space-y-2">
        <label className="block">
          <span className={labelClass}>{t.goalConfirm.goalLabel}</span>
          <textarea
            data-goal-field="goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t.goalConfirm.goalPlaceholder}
            rows={2}
            autoFocus
            className={`${fieldClass} resize-none`}
          />
        </label>

        <label className="block">
          <span className={labelClass}>{t.goalConfirm.verifyLabel}</span>
          <select
            data-goal-field="verify-select"
            value={verifySelected}
            onChange={(e) => setVerifySelected(e.target.value)}
            disabled={verifyCustom.trim().length > 0}
            className={fieldClass}
          >
            <option value={VERIFY_NONE}>{t.goalConfirm.verifyEmpty}</option>
            {verifyCandidates.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          data-goal-advanced-toggle
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex items-center gap-1 text-[10px] text-sky-200/60 transition-colors hover:text-sky-200"
        >
          {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {t.goalConfirm.advancedToggle}
        </button>

        {advancedOpen && (
          <div className="space-y-2 border-l border-sky-500/20 pl-2">
            <label className="block">
              <span className={labelClass}>{t.goalConfirm.verifyCustomLabel}</span>
              <input
                data-goal-field="verify"
                type="text"
                value={verifyCustom}
                onChange={(e) => setVerifyCustom(e.target.value)}
                placeholder={t.goalConfirm.verifyCustomPlaceholder}
                className={fieldClass}
              />
            </label>

            <label className="block">
              <span className={labelClass}>{t.goalConfirm.acceptanceLabel}</span>
              <textarea
                data-goal-field="acceptance"
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
                placeholder={t.goalConfirm.acceptancePlaceholder}
                rows={2}
                className={`${fieldClass} resize-none`}
              />
            </label>

            <label className="block">
              <span className={labelClass}>{t.goalConfirm.boundariesLabel}</span>
              <textarea
                data-goal-field="boundaries"
                value={boundaries}
                onChange={(e) => setBoundaries(e.target.value)}
                rows={2}
                className={`${fieldClass} resize-none`}
              />
            </label>

            <label className="block">
              <span className={labelClass}>{t.goalConfirm.pauseLabel}</span>
              <textarea
                data-goal-field="pause"
                value={pauseConditions}
                onChange={(e) => setPauseConditions(e.target.value)}
                rows={2}
                className={`${fieldClass} resize-none`}
              />
            </label>

            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className={labelClass}>{t.goalConfirm.maxTurnsLabel}</span>
                <input
                  data-goal-field="max-turns"
                  type="number"
                  min={1}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  placeholder={t.goalConfirm.defaultPlaceholder}
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>{t.goalConfirm.budgetLabel}</span>
                <input
                  data-goal-field="budget"
                  type="number"
                  min={1}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder={t.goalConfirm.defaultPlaceholder}
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>{t.goalConfirm.maxTimeLabel}</span>
                <input
                  data-goal-field="max-time"
                  type="number"
                  min={1}
                  value={maxTime}
                  onChange={(e) => setMaxTime(e.target.value)}
                  placeholder={t.goalConfirm.noLimitPlaceholder}
                  className={fieldClass}
                />
              </label>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end pt-0.5">
          <button
            type="button"
            data-goal-start
            onClick={() => canStart && onSubmit(draft)}
            disabled={!canStart}
            className="flex items-center gap-1 rounded bg-sky-500/20 px-3 py-1 text-xs text-sky-100 transition-colors hover:bg-sky-500/30 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Target className="h-3 w-3" />}
            {t.goalConfirm.start}
          </button>
        </div>
      </div>
    </div>
  );
};
