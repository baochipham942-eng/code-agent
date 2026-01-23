// ============================================================================
// SessionDuration - 显示会话持续时间
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import type { SessionDurationProps } from './types';

/**
 * 格式化持续时间为人类可读格式
 * - 小于 1 分钟: Xs
 * - 1 分钟到 1 小时: Xm
 * - 大于 1 小时: Xh Ym
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

export function SessionDuration({ startTime }: SessionDurationProps) {
  const [duration, setDuration] = useState(Date.now() - startTime);

  useEffect(() => {
    // 每秒更新一次
    const interval = setInterval(() => {
      setDuration(Date.now() - startTime);
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span
      className="flex items-center gap-1 text-gray-400"
      title={`Session started at ${new Date(startTime).toLocaleTimeString()}`}
    >
      <Clock size={12} />
      {formatDuration(duration)}
    </span>
  );
}
