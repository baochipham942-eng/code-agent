// ============================================================================
// ApprovalOptionsCompact - 水平排列的审批选项（用于 PermissionCard）
// ============================================================================

import React from 'react';
import { Check, X, Clock, Shield, Ban } from 'lucide-react';
import type { ApprovalLevel } from './types';

interface ApprovalOptionsCompactProps {
  onApproval: (level: ApprovalLevel) => void;
  isDangerous: boolean;
}

export function ApprovalOptionsCompact({ onApproval, isDangerous }: ApprovalOptionsCompactProps) {
  return (
    <div className="border-t border-border-default px-4 py-2.5">
      {/* 第一行: Allow once / Deny / Session */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onApproval('once')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            isDangerous
              ? 'text-orange-400 hover:bg-orange-500/20'
              : 'text-green-400 hover:bg-green-500/20'
          }`}
        >
          <Check size={12} />
          <span>允许</span>
          <kbd className="ml-1 px-1 py-0.5 rounded bg-active text-text-secondary text-2xs font-mono">y</kbd>
        </button>

        <button
          onClick={() => onApproval('deny')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium text-text-secondary hover:bg-active/20 transition-colors"
        >
          <X size={12} />
          <span>拒绝</span>
          <kbd className="ml-1 px-1 py-0.5 rounded bg-active text-text-secondary text-2xs font-mono">n</kbd>
        </button>

        {!isDangerous && (
          <button
            onClick={() => onApproval('session')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium text-blue-400 hover:bg-blue-500/20 transition-colors"
          >
            <Clock size={12} />
            <span>会话</span>
            <kbd className="ml-1 px-1 py-0.5 rounded bg-active text-text-secondary text-2xs font-mono">s</kbd>
          </button>
        )}

        {/* 分隔 */}
        <div className="flex-1" />

        {/* 第二行变为右侧: Always / Never */}
        {!isDangerous && (
          <button
            onClick={() => onApproval('always')}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-purple-400 hover:bg-purple-500/20 transition-colors"
            title="始终允许 (Shift+A)"
          >
            <Shield size={12} />
            <span>始终</span>
          </button>
        )}

        <button
          onClick={() => onApproval('never')}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-red-400 hover:bg-red-500/20 transition-colors"
          title="永不允许 (Shift+N)"
        >
          <Ban size={12} />
          <span>永不</span>
        </button>
      </div>
    </div>
  );
}
