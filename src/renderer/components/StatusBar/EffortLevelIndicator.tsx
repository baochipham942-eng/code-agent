// ============================================================================
// EffortLevelIndicator - StatusBar 推理 effort 切换器
// ============================================================================
// 点击循环切换 low → medium → high → low。只暴露当前 runtime 真正支持的档位。
// ============================================================================

import React from 'react';
import { useModeStore } from '../../stores/modeStore';
import type { EffortLevel } from '../../../shared/contract/agent';
import { normalizeAgentEffortLevel, SUPPORTED_AGENT_EFFORT_LEVELS } from '../../../shared/effortLevels';

const ORDER: EffortLevel[] = [...SUPPORTED_AGENT_EFFORT_LEVELS];

const SHORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  max: 'High',
};

const COLOR: Record<EffortLevel, string> = {
  low: 'text-zinc-500',
  medium: 'text-blue-400',
  high: 'text-amber-400',
  max: 'text-amber-400',
};

export function EffortLevelIndicator() {
  const effortLevel = useModeStore((s) => s.effortLevel);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);

  const cycle = () => {
    const normalized = normalizeAgentEffortLevel(effortLevel);
    const idx = ORDER.indexOf(normalized);
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
