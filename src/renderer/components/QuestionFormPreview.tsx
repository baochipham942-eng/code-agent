import React, { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
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
import ipcService from '../services/ipcService';

export const DESIGN_BRIEF_SUBMIT_EVENT = 'design-brief:submit';

export interface DesignBriefSubmitDetail {
  previewItemId: string;
  brief: DesignBrief;
}

const SURFACE_OPTIONS = Object.entries(DESIGN_BRIEF_SURFACE_LABELS) as Array<
  [DesignBriefSurface, string]
>;

const DIRECTION_OPTIONS = Object.entries(DESIGN_BRIEF_DIRECTION_LABELS) as Array<
  [DesignBriefDirection, string]
>;

interface FormState {
  surface: DesignBriefSurface | '';
  direction: DesignBriefDirection | '';
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

function buildInitialState(item: WorkspacePreviewItem): FormState {
  const json = item.content?.json;
  if (!json) {
    return {
      surface: '',
      direction: '',
      intent: '',
      audience: '',
      constraints: '',
      references: '',
    };
  }
  const parsed = parseQuestionForm(json);
  if (!parsed.ok) {
    return {
      surface: '',
      direction: '',
      intent: '',
      audience: '',
      constraints: '',
      references: '',
    };
  }
  const form = parsed.form;
  return {
    surface: form.surface,
    direction: form.direction,
    intent: form.intent ?? '',
    audience: form.audience ?? '',
    constraints: listToMultiline(form.constraints),
    references: listToMultiline(form.references),
  };
}

export function QuestionFormPreview({ item }: { item: WorkspacePreviewItem }) {
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

    ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'summarizeDesignMd', {
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

  const ready = Boolean(state.surface && state.direction);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || submitted) return;
    if (!state.surface || !state.direction) return;

    const form: QuestionForm = {
      surface: state.surface,
      direction: state.direction,
    };
    const intent = state.intent.trim();
    const audience = state.audience.trim();
    const constraints = multilineToList(state.constraints);
    const references = multilineToList(state.references);
    if (intent) form.intent = intent;
    if (audience) form.audience = audience;
    if (constraints.length) form.constraints = constraints;
    if (references.length) form.references = references;

    const brief = renderQuestionFormToDesignBrief(form);
    const detail: DesignBriefSubmitDetail = {
      previewItemId: item.id,
      brief,
    };
    window.dispatchEvent(new CustomEvent<DesignBriefSubmitDetail>(DESIGN_BRIEF_SUBMIT_EVENT, { detail }));
    setSubmitted(true);
  }

  const inputClass =
    'w-full rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-cyan-500/40';
  const labelClass = 'block text-[11px] font-medium uppercase tracking-wide text-zinc-400';

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.03] p-4 text-zinc-200"
    >
      <div>
        <div className="text-sm font-semibold text-cyan-200">补齐 design brief</div>
        <div className="mt-0.5 text-[11px] text-zinc-400">
          选定 surface 和 direction，我会把它锁进当前会话，下一条 artifact 直接按 brief 出。
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className={labelClass}>Surface *</span>
          <select
            className={inputClass}
            value={state.surface}
            onChange={(e) => setState((s) => ({ ...s, surface: e.target.value as DesignBriefSurface | '' }))}
            disabled={submitted}
          >
            <option value="">— 选一个 —</option>
            {SURFACE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <div className="space-y-1 md:col-span-2">
          <span className={labelClass}>Direction *</span>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {DIRECTION_OPTIONS.map(([value, label]) => (
              <DirectionCard
                key={value}
                label={label}
                tokens={directionTokens[value]}
                selected={state.direction === value}
                disabled={submitted}
                onSelect={() => setState((s) => ({ ...s, direction: value }))}
              />
            ))}
          </div>
        </div>
      </div>

      <label className="block space-y-1">
        <span className={labelClass}>Intent</span>
        <input
          type="text"
          className={inputClass}
          placeholder="一句话目标，例如：新功能发布页 / Q4 增长报告"
          value={state.intent}
          onChange={(e) => setState((s) => ({ ...s, intent: e.target.value }))}
          disabled={submitted}
        />
      </label>

      <label className="block space-y-1">
        <span className={labelClass}>Audience</span>
        <input
          type="text"
          className={inputClass}
          placeholder="给谁看，例如：现有付费用户 / 投资人 / 内部团队"
          value={state.audience}
          onChange={(e) => setState((s) => ({ ...s, audience: e.target.value }))}
          disabled={submitted}
        />
      </label>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className={labelClass}>Constraints</span>
          <textarea
            className={`${inputClass} min-h-[64px] resize-y`}
            placeholder="一行一条，例如&#10;品牌色锁死&#10;不要英文标题"
            value={state.constraints}
            onChange={(e) => setState((s) => ({ ...s, constraints: e.target.value }))}
            disabled={submitted}
          />
        </label>

        <label className="space-y-1">
          <span className={labelClass}>References</span>
          <textarea
            className={`${inputClass} min-h-[64px] resize-y`}
            placeholder="一行一条，参考站点 URL"
            value={state.references}
            onChange={(e) => setState((s) => ({ ...s, references: e.target.value }))}
            disabled={submitted}
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-[11px] text-zinc-500">
          {submitted ? '已锁定，等待下一条 artifact 应用 brief。' : 'Surface 和 Direction 必填。'}
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
          {submitted ? '已提交' : '锁定 brief'}
        </button>
      </div>
    </form>
  );
}

function DirectionCard({
  label,
  tokens,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
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
          Design system sample
        </div>
        <div
          className="truncate text-[12px] text-zinc-300"
          style={{ fontFamily: tokens.fonts.sans }}
        >
          中文字体样例
        </div>
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-zinc-400">
        {tokens.posture}
      </div>
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
