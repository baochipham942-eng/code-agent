// ============================================================================
// ModeSwitch - 聊天模式切换组件
// 支持正常模式和深度研究模式切换
// ============================================================================

import React from 'react';
import { MessageSquare, Microscope } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export type ChatMode = 'normal' | 'deep-research';

interface ModeSwitchProps {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  disabled?: boolean;
}

// ============================================================================
// 组件
// ============================================================================

export const ModeSwitch: React.FC<ModeSwitchProps> = ({
  mode,
  onModeChange,
  disabled,
}) => {
  return (
    <div className="flex items-center gap-1 p-1 bg-surface-800 rounded-lg">
      {/* 正常模式 */}
      <button
        type="button"
        onClick={() => onModeChange('normal')}
        disabled={disabled}
        className={`
          flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
          transition-all duration-200
          ${mode === 'normal'
            ? 'bg-surface-700 text-white shadow-sm'
            : 'text-zinc-400 hover:text-zinc-300 hover:bg-surface-700/50'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        <MessageSquare className="w-4 h-4" />
        <span>正常</span>
      </button>

      {/* 深度研究模式 */}
      <button
        type="button"
        onClick={() => onModeChange('deep-research')}
        disabled={disabled}
        className={`
          flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
          transition-all duration-200
          ${mode === 'deep-research'
            ? 'bg-primary-500/20 text-primary-400 shadow-sm'
            : 'text-zinc-400 hover:text-zinc-300 hover:bg-surface-700/50'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        <Microscope className="w-4 h-4" />
        <span>深度研究</span>
      </button>
    </div>
  );
};
