// ============================================================================
// EffortSelector - 推理强度选择器
// 4 档 pill 按钮: Low / Med / High / Max
// ============================================================================

import React from 'react';
import { Zap, ZapOff, Flame, Rocket } from 'lucide-react';
import type { EffortLevel } from '../../../../../shared/types/agent';

// ============================================================================
// 配置
// ============================================================================

interface EffortOption {
  value: EffortLevel;
  label: string;
  icon: React.ReactNode;
  color: string;        // 选中时文字/图标颜色
  bgColor: string;      // 选中时背景色
}

const EFFORT_OPTIONS: EffortOption[] = [
  {
    value: 'low',
    label: 'Low',
    icon: <ZapOff className="w-3 h-3" />,
    color: 'text-zinc-400',
    bgColor: 'bg-zinc-700/60',
  },
  {
    value: 'medium',
    label: 'Med',
    icon: <Zap className="w-3 h-3" />,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/20',
  },
  {
    value: 'high',
    label: 'High',
    icon: <Flame className="w-3 h-3" />,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
  },
  {
    value: 'max',
    label: 'Max',
    icon: <Rocket className="w-3 h-3" />,
    color: 'text-red-400',
    bgColor: 'bg-red-500/20',
  },
];

// ============================================================================
// Props
// ============================================================================

interface EffortSelectorProps {
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  disabled?: boolean;
}

// ============================================================================
// 组件
// ============================================================================

export const EffortSelector: React.FC<EffortSelectorProps> = ({
  value,
  onChange,
  disabled,
}) => {
  return (
    <div className="flex items-center gap-0.5 p-0.5 bg-white/[0.03] rounded-lg border border-white/[0.06]">
      {EFFORT_OPTIONS.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            title={`推理强度: ${option.label}`}
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
