import React from 'react';
import type {
  ModelThinkingCapability,
  ModelThinkingPreference,
  ModelReasoningEffort,
} from '@shared/contract';
import { Input, Select, Toggle } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';

export interface ModelThinkingControlProps {
  capability: ModelThinkingCapability;
  preference?: ModelThinkingPreference;
  onChange: (preference: ModelThinkingPreference) => void;
}

export function ModelThinkingControl({
  capability,
  preference,
  onChange,
}: ModelThinkingControlProps) {
  const { t } = useI18n();
  const text = t.settings.model.models.thinking;

  if (capability.kind === 'none' || capability.kind === 'unknown') return null;

  if (capability.kind === 'budget') {
    const value = preference?.budgetTokens ?? capability.defaultBudgetTokens ?? capability.minBudgetTokens;
    return (
      <label className="mt-2 flex max-w-xs items-center gap-2 text-xs text-zinc-400">
        <span className="shrink-0">{text.budgetLabel}</span>
        <Input
          type="number"
          inputSize="sm"
          fullWidth={false}
          className="w-28"
          min={capability.minBudgetTokens}
          max={capability.maxBudgetTokens}
          step={1}
          value={value}
          aria-label={text.budgetAriaLabel}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed)) return;
            const bounded = Math.max(
              capability.minBudgetTokens,
              capability.maxBudgetTokens === undefined
                ? parsed
                : Math.min(capability.maxBudgetTokens, parsed),
            );
            onChange({ enabled: true, budgetTokens: bounded });
          }}
        />
        <span className="text-zinc-500">{text.tokensUnit}</span>
      </label>
    );
  }

  if (capability.kind === 'effort') {
    const value = preference?.effort && capability.levels.includes(preference.effort)
      ? preference.effort
      : capability.defaultEffort ?? capability.levels[0];
    return (
      <label className="mt-2 flex max-w-xs items-center gap-2 text-xs text-zinc-400">
        <span className="shrink-0">{text.effortLabel}</span>
        <Select
          selectSize="sm"
          fullWidth={false}
          className="w-32"
          value={value}
          aria-label={text.effortAriaLabel}
          options={capability.levels.map((level) => ({
            value: level,
            label: text.effortLevels[level],
          }))}
          onChange={(event) => onChange({
            enabled: true,
            effort: event.target.value as ModelReasoningEffort,
          })}
        />
      </label>
    );
  }

  const enabled = preference?.enabled ?? capability.defaultEnabled ?? false;
  return (
    <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
      <span>{text.toggleLabel}</span>
      <Toggle
        checked={enabled}
        aria-label={text.toggleAriaLabel}
        onChange={(checked) => onChange({ enabled: checked })}
      />
    </label>
  );
}
