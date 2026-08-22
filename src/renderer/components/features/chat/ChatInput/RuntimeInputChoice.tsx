import React from 'react';
import { useI18n } from '../../../../hooks/useI18n';

export type RuntimeInputChoiceValue = 'queue' | 'redirect';

export interface RuntimeInputChoiceProps {
  value: RuntimeInputChoiceValue;
  onChange: (value: RuntimeInputChoiceValue) => void;
}

export function RuntimeInputChoice({ value, onChange }: RuntimeInputChoiceProps) {
  const { t } = useI18n();
  const options = [
    { value: 'queue' as const, label: t.chatInputSubmit.queueChoice, title: t.chatInputSubmit.queueChoiceHint },
    { value: 'redirect' as const, label: t.chatInputSubmit.redirectChoice, title: t.chatInputSubmit.redirectChoiceHint },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={t.chatInputSubmit.runtimeInputChoiceAria}
      className="flex h-7 items-center rounded-full bg-surface-faint p-0.5 ring-1 ring-border-faint"
      data-testid="runtime-input-choice"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`h-6 rounded-full px-2.5 text-[11px] transition-colors ${selected
              ? 'bg-zinc-700 text-zinc-100 shadow-sm'
              : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
