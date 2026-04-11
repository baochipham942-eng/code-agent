// ============================================================================
// StreamingIndicator - Phase-based streaming status with elapsed timer
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Brain, FileText, AlertTriangle, StopCircle } from 'lucide-react';

interface StreamingIndicatorProps {
  startTime: number;
  onForceStop?: () => void;
}

// Phase thresholds (seconds) and their display config
const PHASES = [
  { threshold: 0,  label: '思考中...',       color: 'text-zinc-400', icon: null },
  { threshold: 5,  label: '深度分析中...',    color: 'text-zinc-300', icon: Brain },
  { threshold: 15, label: '组织回复中...',    color: 'text-zinc-300', icon: FileText },
  { threshold: 60, label: '处理时间较长...',  color: 'text-amber-400', icon: AlertTriangle },
  { threshold: 90, label: '工具可能卡住',    color: 'text-red-400', icon: AlertTriangle },
] as const;

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

export const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({ startTime, onForceStop }) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    // Initialize with current elapsed time
    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  const phase = getPhase(elapsed);
  const Icon = phase.icon;
  const isStuck = elapsed >= PHASES[PHASES.length - 1].threshold;

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
