import React, { useState } from 'react';
import { Loader2, Target, X } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';

export type SeedComposerKind = 'team' | 'role';

interface SeedComposerCardProps {
  title: string;
  placeholder: string;
  hint?: string;
  submitting: boolean;
  onSubmit: (text: string) => void;
  onDismiss: () => void;
  initialText?: string;
}

export function buildSeedComposerCommand(kind: SeedComposerKind, text: string): string {
  return `/create-${kind} ${text.trim()}`;
}

export function getBareSeedComposerKind(raw: string): SeedComposerKind | null {
  const match = raw.trim().match(/^\/create-(team|role)$/);
  return match ? match[1] as SeedComposerKind : null;
}

export const SeedComposerCard: React.FC<SeedComposerCardProps> = ({
  title,
  placeholder,
  hint,
  submitting,
  onSubmit,
  onDismiss,
  initialText = '',
}) => {
  const { t } = useI18n();
  const [text, setText] = useState(initialText);
  const canStart = text.trim().length > 0 && !submitting;
  const submit = () => {
    if (canStart) onSubmit(text.trim());
  };

  return (
    <div data-seed-composer className="mb-2 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-3 animate-fadeIn">
      <div className="flex items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1 text-xs font-medium text-sky-300">{title}</div>
        <button /* ds-allow:button: 种子确认卡关闭图标，primitive 最小尺寸会破坏紧凑卡片 */ type="button" onClick={onDismiss} className="p-0.5 text-zinc-500 transition-colors hover:text-zinc-300" title={t.seedComposer.cancel}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2.5 space-y-2">
        <textarea
          data-seed-composer-field
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={2}
          autoFocus
          className="w-full resize-none rounded border border-sky-500/30 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-sky-500/50"
        />
        {hint && <div className="text-[10px] text-sky-200/60">{hint}</div>}
        <div className="flex items-center justify-end gap-2 pt-0.5">
          <button /* ds-allow:button: 种子确认卡取消动作，紧凑文本按钮 */ type="button" onClick={onDismiss} disabled={submitting} className="px-2 py-1 text-xs text-sky-200/60 transition-colors hover:text-sky-200 disabled:opacity-50">
            {t.seedComposer.cancel}
          </button>
          <button /* ds-allow:button: 种子确认卡启动动作，紧凑确认按钮 */ type="button" data-seed-composer-start onClick={submit} disabled={!canStart} className="flex items-center gap-1 rounded bg-sky-500/20 px-3 py-1 text-xs text-sky-100 transition-colors hover:bg-sky-500/30 disabled:opacity-50">
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Target className="h-3 w-3" />}
            {t.seedComposer.start}
          </button>
        </div>
      </div>
    </div>
  );
};
