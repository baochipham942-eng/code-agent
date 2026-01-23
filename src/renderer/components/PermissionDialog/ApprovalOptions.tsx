// ============================================================================
// ApprovalOptions - 审批选项组件
// ============================================================================

import React from 'react';
import { Check, X, Clock, Shield, Ban } from 'lucide-react';
import type { ApprovalLevel, ApprovalOption } from './types';

interface ApprovalOptionsProps {
  onApproval: (level: ApprovalLevel) => void;
  isDangerous: boolean;
}

export function ApprovalOptions({ onApproval, isDangerous }: ApprovalOptionsProps) {
  const options: ApprovalOption[] = [
    {
      level: 'once',
      label: '允许一次',
      shortcut: 'y',
      icon: <Check size={14} />,
      color: isDangerous
        ? 'text-orange-400 hover:bg-orange-500/20'
        : 'text-green-400 hover:bg-green-500/20',
      show: true,
    },
    {
      level: 'deny',
      label: '拒绝',
      shortcut: 'n',
      icon: <X size={14} />,
      color: 'text-zinc-400 hover:bg-zinc-500/20',
      show: true,
    },
    {
      level: 'session',
      label: '本次会话允许',
      shortcut: 's',
      icon: <Clock size={14} />,
      color: 'text-blue-400 hover:bg-blue-500/20',
      show: !isDangerous, // 危险命令不允许会话级批准
    },
    {
      level: 'always',
      label: '始终允许',
      shortcut: 'Shift+A',
      icon: <Shield size={14} />,
      color: 'text-purple-400 hover:bg-purple-500/20',
      show: !isDangerous, // 危险命令不允许持久批准
    },
    {
      level: 'never',
      label: '永不允许',
      shortcut: 'Shift+N',
      icon: <Ban size={14} />,
      color: 'text-red-400 hover:bg-red-500/20',
      show: true,
    },
  ];

  return (
    <div className="border-t border-zinc-700 p-3">
      <div className="space-y-1">
        {options
          .filter((opt) => opt.show)
          .map((opt) => (
            <button
              key={opt.level}
              onClick={() => onApproval(opt.level)}
              className={`
                w-full flex items-center justify-between
                px-3 py-2 rounded
                text-sm
                transition-colors
                ${opt.color}
              `}
            >
              <span className="flex items-center gap-2">
                {opt.icon}
                {opt.label}
              </span>
              <kbd
                className="
                  px-1.5 py-0.5 rounded
                  bg-zinc-700 text-zinc-400 text-xs
                  font-mono
                "
              >
                {opt.shortcut}
              </kbd>
            </button>
          ))}
      </div>

      {/* 提示文字 */}
      <div className="mt-3 text-xs text-zinc-500 text-center">
        按快捷键可快速选择
      </div>
    </div>
  );
}
