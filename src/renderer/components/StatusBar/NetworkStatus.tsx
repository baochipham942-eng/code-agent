// ============================================================================
// NetworkStatus - 网络状态指示器
// ============================================================================

import React from 'react';
import type { NetworkStatusProps } from './types';

const STATUS_COLORS = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  slow: 'bg-yellow-500',
};

const STATUS_TOOLTIPS = {
  online: 'Network: Online',
  offline: 'Network: Offline',
  slow: 'Network: Slow connection',
};

export function NetworkStatus({ status }: NetworkStatusProps) {
  return (
    <span
      className={`w-2 h-2 rounded-full ${STATUS_COLORS[status]}`}
      title={STATUS_TOOLTIPS[status]}
    />
  );
}
