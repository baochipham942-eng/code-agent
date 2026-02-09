// ============================================================================
// EvaluationTrigger - 评测触发按钮组件（打开评测中心）
// ============================================================================

import React from 'react';
import { useAppStore } from '../../../stores/appStore';

interface EvaluationTriggerProps {
  sessionId: string | null;
}

export function EvaluationTrigger({ sessionId }: EvaluationTriggerProps) {
  const setShowEvalCenter = useAppStore(s => s.setShowEvalCenter);

  if (!sessionId) {
    return null;
  }

  return (
    <button
      onClick={() => setShowEvalCenter(true, undefined, sessionId)}
      className="
        flex items-center gap-1 px-2 py-0.5
        text-gray-400 hover:text-yellow-400
        transition-colors
        group
      "
      title="会话评测"
    >
      <svg
        className="w-3.5 h-3.5 group-hover:text-yellow-400 transition-colors"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
      <span className="text-xs">评测</span>
    </button>
  );
}
