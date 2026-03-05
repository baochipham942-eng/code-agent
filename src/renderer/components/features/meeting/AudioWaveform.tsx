// ============================================================================
// AudioWaveform - 音频波形可视化（借鉴 Otter.ai / Voice Memos 风格）
// 9 根竖条 + 渐变色 + 流畅动画
// ============================================================================

import React, { useMemo } from 'react';

interface AudioWaveformProps {
  audioLevel: number; // 0-1
  isActive: boolean;
  color?: 'red' | 'blue' | 'green';
}

// 9 bars with symmetric multipliers for natural wave shape
const BAR_MULTIPLIERS = [0.4, 0.6, 0.8, 0.95, 1.0, 0.95, 0.8, 0.6, 0.4];
const MAX_HEIGHT = 40;
const MIN_HEIGHT = 4;

export const AudioWaveform: React.FC<AudioWaveformProps> = ({
  audioLevel,
  isActive,
  color = 'red',
}) => {
  const barHeights = useMemo(() => {
    if (!isActive) {
      return BAR_MULTIPLIERS.map(() => MIN_HEIGHT);
    }
    return BAR_MULTIPLIERS.map((multiplier) => {
      const height = Math.max(MIN_HEIGHT, audioLevel * multiplier * MAX_HEIGHT);
      return Math.min(height, MAX_HEIGHT);
    });
  }, [audioLevel, isActive]);

  const colorClass = {
    red: 'bg-red-500',
    blue: 'bg-blue-500',
    green: 'bg-emerald-500',
  }[color];

  const glowClass = {
    red: 'shadow-red-500/30',
    blue: 'shadow-blue-500/30',
    green: 'shadow-emerald-500/30',
  }[color];

  return (
    <div className="flex items-center justify-center gap-[3px] h-12">
      {barHeights.map((height, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-full transition-all ${
            isActive
              ? `duration-75 ${colorClass} shadow-sm ${glowClass}`
              : 'duration-500 bg-zinc-700'
          }`}
          style={{
            height: `${height}px`,
            opacity: isActive ? 0.7 + (height / MAX_HEIGHT) * 0.3 : 0.4,
          }}
        />
      ))}
    </div>
  );
};
