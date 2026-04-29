import React, { useEffect, useMemo, useState } from 'react';
import {
  DESIGN_BRIEF_DIRECTION_LABELS,
  DESIGN_BRIEF_SURFACE_LABELS,
  type DesignBrief,
  type DesignBriefDirection,
  type DesignBriefSurface,
} from '@shared/contract/designBrief';
import type { WorkspacePreviewItem } from '@shared/contract';
import {
  parseQuestionForm,
  renderQuestionFormToDesignBrief,
  type QuestionForm,
} from '@/artifacts/question-form';

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
  const [state, setState] = useState<FormState>(initial);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setState(initial);
    setSubmitted(false);
  }, [initial]);

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

      <div className="grid grid-cols-2 gap-3">
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

        <label className="space-y-1">
          <span className={labelClass}>Direction *</span>
          <select
            className={inputClass}
            value={state.direction}
            onChange={(e) => setState((s) => ({ ...s, direction: e.target.value as DesignBriefDirection | '' }))}
            disabled={submitted}
          >
            <option value="">— 选一个 —</option>
            {DIRECTION_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
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

      <div className="grid grid-cols-2 gap-3">
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
