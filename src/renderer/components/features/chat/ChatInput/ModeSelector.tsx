// ============================================================================
// ModeSelector - 交互模式选择器
// 3 档 pill 按钮: Code / Plan / Ask
// ============================================================================

import React from 'react';
import { Terminal, ClipboardList, MessageCircleQuestion } from 'lucide-react';
import type { InteractionMode } from '../../../../../shared/types/agent';

// ============================================================================
// 配置
// ============================================================================

interface ModeOption {
  value: InteractionMode;
  label: string;
  icon: React.ReactNode;
  color: string;        // 选中时文字/图标颜色
  bgColor: string;      // 选中时背景色
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'code',
    label: 'Code',
    icon: <Terminal className="w-3 h-3" />,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: <ClipboardList className="w-3 h-3" />,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
  },
  {
    value: 'ask',
    label: 'Ask',
    icon: <MessageCircleQuestion className="w-3 h-3" />,
    color: 'text-green-400',
    bgColor: 'bg-green-500/20',
  },
];

// ============================================================================
// Props
// ============================================================================

interface ModeSelectorProps {
  value: InteractionMode;
  onChange: (mode: InteractionMode) => void;
  disabled?: boolean;
}

// ============================================================================
// 组件
// ============================================================================

export const ModeSelector: React.FC<ModeSelectorProps> = ({
  value,
  onChange,
  disabled,
}) => {
  return (
    <div className="flex items-center gap-0.5 p-0.5 bg-white/[0.03] rounded-lg border border-white/[0.06]">
      {MODE_OPTIONS.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            title={`交互模式: ${option.label}`}
            className={`
              flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium
              transition-all duration-150
              ${isActive
                ? `${option.bgColor} ${option.color}`
                : 'text-zinc-500 hover:text-zinc-400 hover:bg-white/[0.04]'
              }
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
};
