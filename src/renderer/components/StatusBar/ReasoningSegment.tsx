// ============================================================================
// ReasoningSegment - 模型选择弹窗里的思考档位段
// ============================================================================
// 从 ModelSwitcher 拆出（god-file max-lines 守门）。只呈现传入的数据：
// active 与拆出前的可点选段一致；disabled_external 同布局但按钮全部不可点、不选中。

import React from 'react';
import { Brain } from 'lucide-react';
import type { ReasoningSegmentMode, ThinkingSegmentOption } from './modelSwitcherHelpers';

export function ReasoningSegment({
  mode,
  sectionLabel,
  note,
  options,
}: {
  mode: ReasoningSegmentMode;
  sectionLabel: string;
  note: string;
  options: readonly ThinkingSegmentOption[];
}): React.ReactElement | null {
  if (mode === 'hidden') return null;
  const disabled = mode === 'disabled_external';
  return (
    <div
      className="px-2 pt-1.5 pb-1.5 border-b border-zinc-700/50"
      title={disabled ? note : undefined}
    >
      <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
        <Brain className="w-3 h-3" />
        <span>{sectionLabel}</span>
      </div>
      <div className="grid grid-cols-5 gap-1" data-native-reasoning-segment>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-disabled={disabled ? true : undefined}
            onClick={disabled ? undefined : option.onSelect}
            className={disabled
              ? `
                inline-flex h-7 items-center justify-center rounded px-2 text-[10px] transition-colors
                text-zinc-500 opacity-50 cursor-not-allowed
              `
              : `
                inline-flex h-7 items-center justify-center rounded px-2 text-[10px] transition-colors
                ${option.selected
                  ? `${option.color} ${option.tint} font-medium ring-1 ring-zinc-600/70`
                  : 'text-zinc-500 hover:bg-zinc-700/50'}
              `}
            title={disabled ? undefined : `${sectionLabel}: ${option.label}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {disabled && (
        <p className="mt-1 px-1 text-[10px] text-zinc-500">{note}</p>
      )}
    </div>
  );
}
