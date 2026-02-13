// ============================================================================
// SendButton - 发送按钮组件（含加载状态、停止功能和中断功能）
// Claude Code 风格：处理中时可以继续输入，发送会中断当前任务
// ============================================================================

import React from 'react';
import { Send, Square, Loader2 } from 'lucide-react';

export interface SendButtonProps {
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否正在处理（显示停止按钮或中断发送按钮） */
  isProcessing?: boolean;
  /** 是否正在中断（显示旋转加载图标） */
  isInterrupting?: boolean;
  /** 是否有内容可发送 */
  hasContent?: boolean;
  /** 表单提交类型 */
  type?: 'submit' | 'button';
  /** 点击回调（发送或停止） */
  onClick?: () => void;
  /** 停止回调 */
  onStop?: () => void;
  /** 自定义按钮文字（如 "开始研究"），传入后按钮会显示文字 */
  label?: string;
}

/**
 * 发送按钮 - 支持三种状态：
 * 1. 空闲时：显示发送按钮
 * 2. 处理中 + 无内容：显示停止按钮
 * 3. 处理中 + 有内容：显示中断发送按钮（橙色，表示会中断当前任务）
 * 4. 中断中：显示旋转加载图标
 */
export const SendButton: React.FC<SendButtonProps> = ({
  disabled = false,
  isProcessing = false,
  isInterrupting = false,
  hasContent = false,
  type = 'submit',
  onClick,
  onStop,
  label,
}) => {
  // 中断中：显示旋转加载图标
  if (isInterrupting) {
    return (
      <button
        type="button"
        disabled
        className="flex-shrink-0 mr-2 w-9 h-9 rounded-xl flex items-center justify-center text-amber-400 transition-all duration-200 bg-amber-500/20 cursor-wait"
        aria-label="正在中断..."
      >
        <Loader2 className="w-4 h-4 animate-spin" />
      </button>
    );
  }

  // 处理中 + 有内容：显示中断发送按钮（橙色警告色，表示会中断当前任务）
  if (isProcessing && hasContent) {
    return (
      <button
        type={type}
        onClick={onClick}
        className="flex-shrink-0 mr-2 w-9 h-9 rounded-xl flex items-center justify-center text-white transition-all duration-300 bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 scale-100 hover:scale-105"
        aria-label="中断并发送新指令"
        title="中断当前任务并发送新指令"
      >
        <Send className="w-4 h-4 -rotate-45 translate-x-[0.5px] -translate-y-[0.5px]" />
      </button>
    );
  }

  // 处理中 + 无内容：显示停止按钮（柔和样式，白色图标 + 浅灰背景）
  if (isProcessing) {
    return (
      <button
        type="button"
        onClick={onStop}
        className="flex-shrink-0 mr-2 w-9 h-9 rounded-xl flex items-center justify-center text-zinc-300 transition-all duration-200 bg-zinc-700 hover:bg-zinc-600 hover:text-white"
        aria-label="停止"
      >
        <Square className="w-4 h-4 fill-current" />
      </button>
    );
  }

  const isDisabled = disabled || !hasContent;
  const showActiveState = hasContent && !disabled;

  // 如果有 label，显示带文字的按钮
  if (label) {
    return (
      <button
        type={type}
        disabled={isDisabled}
        onClick={onClick}
        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300 mr-2 ${
          showActiveState
            ? 'bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-500 hover:to-primary-400 text-white shadow-lg shadow-primary-500/20 hover:shadow-primary-500/30 scale-100 hover:scale-105'
            : 'bg-zinc-700/50 text-zinc-400 cursor-not-allowed scale-95 opacity-60'
        }`}
      >
        <Send
          className={`w-4 h-4 transition-transform duration-200 ${
            hasContent ? '-rotate-45 translate-x-[0.5px] -translate-y-[0.5px]' : ''
          }`}
        />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      type={type}
      disabled={isDisabled}
      onClick={onClick}
      className={`flex-shrink-0 mr-2 w-9 h-9 rounded-xl flex items-center justify-center text-white transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed ${
        showActiveState
          ? 'bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-500 hover:to-primary-400 shadow-lg shadow-primary-500/20 hover:shadow-primary-500/30 scale-100 hover:scale-105'
          : 'bg-zinc-700/50 cursor-not-allowed scale-95 opacity-60'
      }`}
      aria-label="发送消息"
    >
      <Send
        className={`w-4 h-4 transition-transform duration-200 ${
          hasContent ? '-rotate-45 translate-x-[0.5px] -translate-y-[0.5px]' : ''
        }`}
      />
    </button>
  );
};

export default SendButton;
