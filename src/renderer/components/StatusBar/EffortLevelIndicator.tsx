// ============================================================================
// EffortLevelIndicator - StatusBar 推理 effort 切换器
// ============================================================================
// 点击循环切换 low → medium → high → max → low。Codex 是下拉式（"5.5 Extra
// High ⌄"），CA StatusBar 高度 28px 紧凑，cycle 比 dropdown 更轻量。
// ============================================================================

import React from 'react';
import { useModeStore } from '../../stores/modeStore';
import type { EffortLevel } from '../../../shared/contract/agent';

const ORDER: EffortLevel[] = ['low', 'medium', 'high', 'max'];

const SHORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  max: 'Max',
};

const COLOR: Record<EffortLevel, string> = {
  low: 'text-zinc-500',
  medium: 'text-blue-400',
  high: 'text-amber-400',
  max: 'text-pink-400',
};

export function EffortLevelIndicator() {
  const effortLevel = useModeStore((s) => s.effortLevel);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);

  const cycle = () => {
    const idx = ORDER.indexOf(effortLevel);
    const next = ORDER[(idx + 1) % ORDER.length];
    setEffortLevel(next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      className={`${COLOR[effortLevel]} hover:opacity-80 transition-opacity`}
      title={`Reasoning effort：${effortLevel}（点击切换）`}
    >
      ⚡{SHORT_LABEL[effortLevel]}
    </button>
  );
}
