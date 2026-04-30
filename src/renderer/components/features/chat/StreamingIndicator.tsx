// ============================================================================
// StreamingIndicator - Phase-based streaming status with elapsed timer
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Brain, AlertTriangle, StopCircle } from 'lucide-react';
import type { TraceNode } from '@shared/contract/trace';

interface StreamingIndicatorProps {
  startTime: number;
  runningToolStartTime?: number;
  onForceStop?: () => void;
}

// Phase thresholds (seconds) and their display config
// 默认态 0-30s 保持 Codex 式克制：dots + 灰字；30s+ 再升级图标和颜色
const PHASES = [
  { threshold: 0,  label: '思考中...',       color: 'text-zinc-400', icon: null },
  { threshold: 30, label: '深度分析中...',    color: 'text-zinc-300', icon: Brain },
  { threshold: 60, label: '处理时间较长...',  color: 'text-amber-400', icon: AlertTriangle },
  { threshold: 90, label: '工具可能卡住',    color: 'text-red-400', icon: AlertTriangle },
] as const;

const STUCK_THRESHOLD_SECONDS = 90;

function getPhase(elapsedSeconds: number) {
  for (let i = PHASES.length - 1; i >= 0; i--) {
    if (elapsedSeconds >= PHASES[i].threshold) return PHASES[i];
  }
  return PHASES[0];
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getStreamingIndicatorState(
  elapsedSeconds: number,
  runningToolElapsedSeconds?: number,
) {
  const safeElapsed = Math.max(0, elapsedSeconds);
  const toolStuck =
    typeof runningToolElapsedSeconds === 'number' &&
    runningToolElapsedSeconds >= STUCK_THRESHOLD_SECONDS;
  const phaseElapsed = toolStuck
    ? safeElapsed
    : Math.min(safeElapsed, STUCK_THRESHOLD_SECONDS - 1);

  return {
    phase: getPhase(phaseElapsed),
    isStuck: toolStuck,
  };
}

export function getRunningToolStartTime(nodes: TraceNode[]): number | undefined {
  const runningStarts = nodes
    .filter((node) => {
      const toolCall = node.toolCall;
      if (!toolCall) return false;
      if (toolCall._streaming) return false;
      return toolCall.success === undefined && toolCall.result === undefined;
    })
    .map((node) => node.timestamp);

  return runningStarts.length > 0 ? Math.min(...runningStarts) : undefined;
}

export const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({ startTime, runningToolStartTime, onForceStop }) => {
  const [elapsed, setElapsed] = useState(0);
  const [runningToolElapsed, setRunningToolElapsed] = useState<number | undefined>(undefined);

  useEffect(() => {
    const updateElapsed = () => {
      const now = Date.now();
      setElapsed(Math.floor((now - startTime) / 1000));
      setRunningToolElapsed(
        runningToolStartTime !== undefined
          ? Math.floor((now - runningToolStartTime) / 1000)
          : undefined,
      );
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [startTime, runningToolStartTime]);

  const { phase, isStuck } = getStreamingIndicatorState(elapsed, runningToolElapsed);
  const Icon = phase.icon;

  return (
    <div className="flex items-center gap-2 py-1">
      {/* Phase icon or pulsing dots for initial phase */}
      {Icon ? (
        <Icon className={`w-3.5 h-3.5 ${phase.color} ${phase.color.includes('amber') || phase.color.includes('red') ? '' : 'animate-pulse'}`} />
      ) : (
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '300ms' }} />
        </div>
      )}

      {/* Phase label */}
      <span className={`text-xs ${phase.color}`}>{phase.label}</span>

      {/* Elapsed timer */}
      <span className="text-xs font-mono text-zinc-500">已运行 {formatElapsed(elapsed)}</span>

      {/* Force stop button for stuck state */}
      {isStuck && onForceStop && (
        <button
          onClick={onForceStop}
          className="flex items-center gap-1 px-2 py-0.5 text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded transition-colors"
        >
          <StopCircle className="w-3 h-3" />
          Force Stop
        </button>
      )}
    </div>
  );
};
