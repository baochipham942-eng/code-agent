// ============================================================================
// MessageCounter - 统计当前会话的消息数量
// ============================================================================

import React from 'react';
import { MessageSquare } from 'lucide-react';
import type { MessageCounterProps } from './types';

export function MessageCounter({ count }: MessageCounterProps) {
  return (
    <span className="flex items-center gap-1 text-gray-400" title={`${count} messages in this session`}>
      <MessageSquare size={12} />
      <span>{count}</span>
      <span className="text-gray-600">msgs</span>
    </span>
  );
}
