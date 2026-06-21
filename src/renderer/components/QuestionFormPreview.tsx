import React, { useEffect, useMemo, useState } from 'react';
import { Check, ImageDown, Palette } from 'lucide-react';
import {
  DESIGN_BRIEF_DIRECTION_LABELS,
  DESIGN_BRIEF_SURFACE_LABELS,
  type DesignBrief,
  type DesignBriefDirection,
  type DesignBriefSurface,
} from '@shared/contract/designBrief';
import type { WorkspacePreviewItem } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  parseQuestionForm,
  renderQuestionFormToDesignBrief,
  type QuestionForm,
} from '@/artifacts/question-form';
import { directionTokens, type DirectionTokens } from '@/design/direction-tokens';
import { useAppStore } from '../stores/appStore';
import { useMessageActionStore } from '../stores/messageActionStore';
import { useI18n } from '../hooks/useI18n';
import ipcService from '../services/ipcService';

export const DESIGN_BRIEF_SUBMIT_EVENT = 'design-brief:submit';

export interface DesignBriefSubmitDetail {
  previewItemId: string;
  brief: DesignBrief;
}

type BriefMode = 'direction' | 'reference';

const ALL_DIRECTIONS = Object.keys(DESIGN_BRIEF_DIRECTION_LABELS) as DesignBriefDirection[];

const SURFACE_OPTIONS = Object.entries(DESIGN_BRIEF_SURFACE_LABELS) as Array<
  [DesignBriefSurface, string]
>;

interface FormState {
  surface: DesignBriefSurface | '';
  direction: DesignBriefDirection | '';
  /** AI 精选的候选方向（最多 3）；为空时回退到全部 6 个。 */
  directions: DesignBriefDirection[];
  mode: BriefMode;
  intent: string;
  audience: string;
  constraints: string;
  references: string;
}

function multilineToList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listToMultiline(value: string[] | undefined): string {
  return value?.length ? value.join('\n') : '';
}

function firstFontName(stack: string): string {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .find(Boolean) || 'system-ui';
}

function appendReference(existing: string, reference: string): string {
  const lines = multilineToList(existing);
  if (lines.some((line) => line === reference || line.startsWith('DESIGN.md:'))) {
    return existing;
  }
  return [...lines, reference].join('\n');
}

const EMPTY_STATE: FormState = {
  surface: '',
  direction: '',
  directions: [],
  mode: 'direction',
  intent: '',
  audience: '',
  constraints: '',
  references: '',
};

function buildInitialState(item: WorkspacePreviewItem): FormState {
  const json = item.content?.json;
  if (!json) return { ...EMPTY_STATE };
  const parsed = parseQuestionForm(json);
  if (!parsed.ok) return { ...EMPTY_STATE };
  const form = parsed.form;
  return {
    surface: form.surface,
    direction: form.direction ?? '',
    directions: form.directions ?? [],
    mode: form.referenceScreenshot ? 'reference' : 'direction',
    intent: form.intent ?? '',
    audience: form.audience ?? '',
    constraints: listToMultiline(form.constraints),
    references: listToMultiline(form.references),
  };
}

export function QuestionFormPreview({ item }: { item: WorkspacePreviewItem }) {
  const { t } = useI18n();
  const tf = t.questionForm;
  const initial = useMemo(() => buildInitialState(item), [item.id, item.content?.json]);
  const workingDirectory = useAppStore((appState) => appState.workingDirectory);
  const [state, setState] = useState<FormState>(initial);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setState(initial);
    setSubmitted(false);
  }, [initial]);

  useEffect(() => {
    if (!workingDirectory || submitted) return;
    let cancelled = false;

    ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'getDesignMdSummary', {
      cwd: workingDirectory,
    })
      .then((summary) => {
        if (cancelled || !summary) return;
        setState((current) => ({
          ...current,
          references: appendReference(current.references, summary),
        }));
      })
      .catch(() => {
        // DESIGN.md is optional; absence or IPC fallback should not block the form.
      });

    return () => {
      cancelled = true;
    };
  }, [workingDirectory, item.id, submitted]);

  // 候选方向卡：AI 精选 3 个则只显示这 3 个，否则回退到全部 6 个。
  const directionOptions = state.directions.length > 0 ? state.directions : ALL_DIRECTIONS;
  const isReferenceMode = state.mode === 'reference';
  const ready = Boolean(state.surface) && (isReferenceMode || Boolean(state.direction));

  function buildForm(): QuestionForm | null {
    if (!state.surface) return null;
    const form: QuestionForm = { surface: state.surface };
    if (isReferenceMode) {
      form.referenceScreenshot = true;
    } else if (state.direction) {
      form.direction = state.direction;
    } else {
      return null;
    }
    const intent = state.intent.trim();
    const audience = state.audience.trim();
    const constraints = multilineToList(state.constraints);
    const references = multilineToList(state.references);
    if (intent) form.intent = intent;
    if (audience) form.audience = audience;
    if (constraints.length) form.constraints = constraints;
    if (references.length) form.references = references;
    return form;
  }

  function lockBrief(brief: DesignBrief) {
    const detail: DesignBriefSubmitDetail = { previewItemId: item.id, brief };
    window.dispatchEvent(new CustomEvent<DesignBriefSubmitDetail>(DESIGN_BRIEF_SUBMIT_EVENT, { detail }));
    setSubmitted(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || submitted) return;
    const form = buildForm();
    if (!form) return;

    lockBrief(renderQuestionFormToDesignBrief(form));

    // 方向模式：锁定后自动续发，让 AI 直接按 brief 出成品。
    // 参考截图模式：不自动续发——用户需要先在输入框附上参考截图再发送。
    if (!isReferenceMode) {
      void useMessageActionStore.getState().sendPrompt(tf.continueMessage);
    }
  }

  // 逃生口：跳过澄清，锁一个 inferred 空 brief（抑制本会话重复出表单）并直接让 AI 生成。
  function handleSkip() {
    if (submitted) return;
    const brief: DesignBrief = { source: 'inferred' };
    if (state.surface) brief.surface = state.surface;
    lockBrief(brief);
    void useMessageActionStore.getState().sendPrompt(tf.skipMessage);
  }

  const inputClass =
    'w-full rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1.5 text-xs text-zinc-100 outline-hidden focus:border-cyan-500/40';
  const labelClass = 'block text-[11px] font-medium uppercase tracking-wide text-zinc-400';

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.03] p-4 text-zinc-200"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-cyan-200">{tf.title}</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{tf.subtitle}</div>
        </div>
        {/* 逃生口：别学 Open Design 生成前 6 决策的摩擦 */}
        <button
          type="button"
          onClick={handleSkip}
          disabled={submitted}
          title={tf.skipHint}
          className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            submitted
              ? 'cursor-not-allowed border-white/[0.06] bg-zinc-800 text-zinc-500'
              : 'border-white/[0.1] bg-white/[0.03] text-zinc-300 hover:border-white/[0.2] hover:text-zinc-100'
          }`}
        >
          {tf.skip}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <label className="space-y-1">
          <span className={labelClass}>{tf.surface} *</span>
          <select
            className={inputClass}
            value={state.surface}
            onChange={(e) => setState((s) => ({ ...s, surface: e.target.value as DesignBriefSurface | '' }))}
            disabled={submitted}
          >
            <option value="">{tf.surfacePlaceholder}</option>
            {SURFACE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        {/* 模式切换：挑方向 vs 匹配参考截图 */}
        <div className="flex gap-1.5">
          <ModeTab
            active={!isReferenceMode}
            disabled={submitted}
            icon={<Palette className="h-3.5 w-3.5" />}
            label={tf.modeDirection}
            onClick={() => setState((s) => ({ ...s, mode: 'direction' }))}
          />
          <ModeTab
            active={isReferenceMode}
            disabled={submitted}
            icon={<ImageDown className="h-3.5 w-3.5" />}
            label={tf.modeReference}
            onClick={() => setState((s) => ({ ...s, mode: 'reference' }))}
          />
        </div>

        {isReferenceMode ? (
          <div className="rounded-lg border border-dashed border-cyan-500/25 bg-cyan-500/[0.04] p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-cyan-100">
              <ImageDown className="h-4 w-4" />
              {tf.referenceTitle}
            </div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-zinc-300">{tf.referenceHint}</div>
          </div>
        ) : (
          <div className="space-y-1">
            <span className={labelClass}>{tf.direction} *</span>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {directionOptions.map((value) => (
                <DirectionCard
                  key={value}
                  label={DESIGN_BRIEF_DIRECTION_LABELS[value]}
                  refsLabel={tf.refs}
                  sampleSerif={tf.sampleSerif}
                  sampleSans={tf.sampleSans}
                  tokens={directionTokens[value]}
                  selected={state.direction === value}
                  disabled={submitted}
                  onSelect={() => setState((s) => ({ ...s, direction: value }))}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <label className="block space-y-1">
        <span className={labelClass}>{tf.intent}</span>
        <input
          type="text"
          className={inputClass}
          placeholder={tf.intentPlaceholder}
          value={state.intent}
          onChange={(e) => setState((s) => ({ ...s, intent: e.target.value }))}
          disabled={submitted}
        />
      </label>

      <label className="block space-y-1">
        <span className={labelClass}>{tf.audience}</span>
        <input
          type="text"
          className={inputClass}
          placeholder={tf.audiencePlaceholder}
          value={state.audience}
          onChange={(e) => setState((s) => ({ ...s, audience: e.target.value }))}
          disabled={submitted}
        />
      </label>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className={labelClass}>{tf.constraints}</span>
          <textarea
            className={`${inputClass} min-h-[64px] resize-y`}
            placeholder={tf.constraintsPlaceholder}
            value={state.constraints}
            onChange={(e) => setState((s) => ({ ...s, constraints: e.target.value }))}
            disabled={submitted}
          />
        </label>

        <label className="space-y-1">
          <span className={labelClass}>{tf.references}</span>
          <textarea
            className={`${inputClass} min-h-[64px] resize-y`}
            placeholder={tf.referencesPlaceholder}
            value={state.references}
            onChange={(e) => setState((s) => ({ ...s, references: e.target.value }))}
            disabled={submitted}
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-[11px] text-zinc-500">
          {submitted
            ? (isReferenceMode ? tf.referenceLockedHint : tf.lockedHint)
            : tf.requiredHint}
        </div>
        <button
          type="submit"
          disabled={!ready || submitted}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            !ready || submitted
              ? 'cursor-not-allowed border border-white/[0.06] bg-zinc-800 text-zinc-500'
              : 'border border-cyan-500/30 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25'
          }`}
        >
          {submitted ? tf.submitted : tf.submit}
        </button>
      </div>
    </form>
  );
}

function ModeTab({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
        active
          ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100'
          : 'border-white/[0.08] bg-zinc-950/30 text-zinc-400 hover:border-white/[0.18] hover:text-zinc-200'
      } ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}
    >
      {icon}
      {label}
    </button>
  );
}

function DirectionCard({
  label,
  refsLabel,
  sampleSerif,
  sampleSans,
  tokens,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  refsLabel: string;
  sampleSerif: string;
  sampleSans: string;
  tokens: DirectionTokens;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`min-h-[142px] rounded-lg border p-3 text-left transition-all ${
        selected
          ? 'border-cyan-400/70 bg-cyan-500/[0.08] ring-1 ring-cyan-400/40'
          : 'border-white/[0.08] bg-zinc-950/30 hover:border-white/[0.18] hover:bg-white/[0.035]'
      } ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-zinc-100">{label}</div>
          <div className="mt-1 text-[10px] text-zinc-500">{firstFontName(tokens.fonts.sans)}</div>
        </div>
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
            selected ? 'border-cyan-300 bg-cyan-400 text-zinc-950' : 'border-zinc-700 text-transparent'
          }`}
        >
          <Check className="h-3.5 w-3.5" />
        </span>
      </div>
      <PaletteStrip tokens={tokens} className="mt-3 h-2" />
      <div className="mt-3 space-y-0.5">
        <div
          className="truncate text-[12px] text-zinc-100"
          style={{ fontFamily: tokens.fonts.serif }}
        >
          {sampleSerif}
        </div>
        <div
          className="truncate text-[12px] text-zinc-300"
          style={{ fontFamily: tokens.fonts.sans }}
        >
          {sampleSans}
        </div>
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-zinc-400">
        {tokens.posture}
      </div>
      {tokens.refs.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[9px] uppercase tracking-wide text-zinc-600">{refsLabel}</span>
          {tokens.refs.map((ref) => (
            <span
              key={ref}
              className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-zinc-400"
            >
              {ref}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function PaletteStrip({
  tokens,
  className = '',
}: {
  tokens: DirectionTokens;
  className?: string;
}) {
  const colors = [
    tokens.palette.primary,
    tokens.palette.surface,
    tokens.palette.accent,
    tokens.palette.muted,
    tokens.palette.contrast,
  ];
  return (
    <div className={`flex overflow-hidden rounded ${className}`}>
      {colors.map((color, index) => (
        <span
          key={`${color}-${index}`}
          className="flex-1"
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}
