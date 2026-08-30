import React, { useEffect, useState } from 'react';
import type { AiReviewDimension, EvalAnnotation } from '@shared/contract/evaluation';
import { Button } from '@renderer/components/primitives/Button';
import { Textarea } from '@renderer/components/primitives/Textarea';
import { toast } from '@renderer/hooks/useToast';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import { invokeEvaluation } from '../evaluationRunIpc';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';

interface EvalCaseAnnotationProps {
  target: { experimentId: string; caseId: string };
}

function relativeTime(timestamp: number, language: string): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60],
  ];
  const [unit, divisor] = ranges.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1];
  return new Intl.RelativeTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' })
    .format(Math.round(seconds / divisor), unit);
}

export const EvalCaseAnnotation: React.FC<EvalCaseAnnotationProps> = ({ target }) => {
  const { language, t } = useEvaluationI18n();
  const labels = t.evalCenter.annotations;
  const dimensionLabels = t.evalCenter.scorers.dimensions;
  const dimensions = Object.entries(dimensionLabels) as Array<[AiReviewDimension, string]>;
  const [overall, setOverall] = useState<'up' | 'down'>();
  const [note, setNote] = useState('');
  const [dims, setDims] = useState<Partial<Record<AiReviewDimension, 'yes' | 'no'>>>({});
  const [mine, setMine] = useState<EvalAnnotation>();
  const [others, setOthers] = useState<EvalAnnotation[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setState('loading');
    setError('');
    void invokeEvaluation(EVALUATION_CHANNELS.LIST_ANNOTATIONS, target)
      .then((result) => {
        if (!active) return;
        const latest = result?.latestByReviewer ?? [];
        const own = latest.find((annotation) => annotation.mine);
        setMine(own);
        setOthers(latest.filter((annotation) => !annotation.mine));
        setOverall(own?.overall);
        setNote(own?.note ?? '');
        setDims(own?.dims ?? {});
        setState('ready');
      })
      .catch(() => {
        if (!active) return;
        setError(labels.loadFailed);
        setState('error');
      });
    return () => { active = false; };
  }, [labels.loadFailed, target]);

  const toggleDimension = (dimension: AiReviewDimension, value: 'yes' | 'no') => {
    setDims((current) => {
      const next = { ...current };
      if (next[dimension] === value) delete next[dimension];
      else next[dimension] = value;
      return next;
    });
  };

  const save = async () => {
    setState('saving');
    setError('');
    try {
      const result = await invokeEvaluation(EVALUATION_CHANNELS.SAVE_ANNOTATION, {
        experimentId: target.experimentId,
        caseId: target.caseId,
        overall,
        note: note || undefined,
        dims,
        supersedesId: mine?.id,
      });
      setMine(result.annotation);
      setState('ready');
      toast.success(labels.written);
    } catch {
      setError(labels.saveFailed);
      setState('error');
    }
  };

  const tooLong = note.length > 2000;
  const pressed = 'bg-[var(--bg-active)] text-zinc-100 ring-1 ring-primary-500';
  return (
    <section className="border-b border-zinc-800 px-4 py-4" data-testid="eval-case-annotation">
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-xs font-medium text-zinc-300">{labels.title}</h3>
        {mine && <span className="text-[10px] text-zinc-600">{labels.last} {relativeTime(mine.createdAt, language)} · {labels.me}</span>}
      </div>
      <div className="mb-4 flex gap-2">
        {([['up', '👍', labels.overallUp], ['down', '👎', labels.overallDown]] as const).map(([value, icon, label]) => (
          <Button key={value} size="sm" variant="secondary" aria-pressed={overall === value}
            aria-label={label} className={overall === value ? pressed : ''}
            onClick={() => setOverall((current) => current === value ? undefined : value)}>
            {icon} {label}
          </Button>
        ))}
      </div>
      <label className="mb-1 block text-[11px] text-zinc-400" htmlFor="eval-annotation-note">{labels.note}</label>
      <Textarea id="eval-annotation-note" value={note} minRows={1} maxRows={4} autoResize
        placeholder={labels.notePlaceholder} onChange={(event) => setNote(event.target.value)} />
      <p className="mt-1 text-[10px] text-zinc-600">{labels.noteHelp}</p>
      {tooLong && <p className="mt-1 text-[10px] text-badge-danger">{labels.noteTooLong}</p>}
      <div className="mt-4 divide-y divide-zinc-800">
        {dimensions.map(([dimension, label]) => (
          <div key={dimension} className="flex items-center gap-2 py-2">
            <span className="min-w-0 flex-1 text-[11px] text-zinc-300">{label}</span>
            {(['yes', 'no'] as const).map((value) => (
              <Button key={value} size="sm" variant="ghost" aria-pressed={dims[dimension] === value}
                aria-label={`${label} · ${labels[value]}`} className={dims[dimension] === value ? pressed : ''}
                onClick={() => toggleDimension(dimension, value)}>{labels[value]}</Button>
            ))}
          </div>
        ))}
      </div>
      <p className="mb-3 text-[10px] text-zinc-600">{labels.dimensionHelp}</p>
      <Button size="sm" disabled={state === 'loading' || state === 'saving' || tooLong}
        loading={state === 'saving'} onClick={() => void save()}>{state === 'saving' ? labels.saving : labels.save}</Button>
      {error && <p className="mt-2 text-[11px] text-badge-danger">{error}</p>}
      {others.length > 0 && (
        <div className="mt-4 space-y-1 text-[10px] text-zinc-500">
          {others.map((annotation) => (
            <p key={annotation.id}>{labels.others}：{annotation.reviewerId} {annotation.overall === 'up' ? '👍' : annotation.overall === 'down' ? '👎' : ''} · {labels.dimensions.replace('{count}', String(Object.keys(annotation.dims).length))}</p>
          ))}
        </div>
      )}
    </section>
  );
};
