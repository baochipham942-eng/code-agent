// ============================================================================
// InteractionModeIndicator - StatusBar 交互模式切换器
// ============================================================================
// Codex 把 access mode（Full / Read only / Plan）放在底部状态栏作为一等公民。
// CA 的 InteractionMode（code / plan / ask）语义对应：
//   code = 全权执行（Codex 的 Full access）
//   plan = 只规划不动手（Codex 的 Plan）
//   ask = 只回答问题（read-only 风味）
// 点击循环切换。
// ============================================================================

import React from 'react';
import { useModeStore } from '../../stores/modeStore';
import type { InteractionMode } from '../../../shared/contract/agent';

const ORDER: InteractionMode[] = ['code', 'plan', 'ask'];

const LABEL: Record<InteractionMode, string> = {
  code: 'Code',
  plan: 'Plan',
  ask: 'Ask',
};

const COLOR: Record<InteractionMode, string> = {
  code: 'text-emerald-400',
  plan: 'text-purple-400',
  ask: 'text-cyan-400',
};

const HINT: Record<InteractionMode, string> = {
  code: '全权执行：调用工具、修改文件、运行命令',
  plan: '只规划：列计划但不动手',
  ask: '只问答：纯文字回复，不调工具',
};

export function InteractionModeIndicator() {
  const interactionMode = useModeStore((s) => s.interactionMode);
  const setInteractionMode = useModeStore((s) => s.setInteractionMode);

  const cycle = () => {
    const idx = ORDER.indexOf(interactionMode);
    const next = ORDER[(idx + 1) % ORDER.length];
    setInteractionMode(next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      className={`${COLOR[interactionMode]} hover:opacity-80 transition-opacity`}
      title={`${HINT[interactionMode]}（点击切换）`}
    >
      ◆{LABEL[interactionMode]}
    </button>
  );
}
