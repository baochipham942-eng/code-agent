// ============================================================================
// DangerWarning - 危险操作警告组件
// ============================================================================

import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface DangerWarningProps {
  reason?: string;
}

export function DangerWarning({ reason }: DangerWarningProps) {
  return (
    <div
      className="
        flex items-start gap-3 p-3
        bg-red-900/20 border border-red-500/30 rounded-lg
      "
    >
      <AlertTriangle className="text-red-400 flex-shrink-0 mt-0.5" size={18} />
      <div className="text-sm">
        <div className="text-red-400 font-medium">这是一个危险命令</div>
        <div className="text-red-300/80 mt-1">
          {reason || '此操作可能导致数据丢失或系统损坏，请仔细确认后再执行。'}
        </div>
      </div>
    </div>
  );
}
