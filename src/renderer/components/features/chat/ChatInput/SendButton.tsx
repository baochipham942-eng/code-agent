// ============================================================================
// SendButton - 发送按钮组件（含加载状态、停止功能和运行中排队发送）
// ============================================================================

import React from 'react';
import { ArrowUp, Square, Loader2 } from 'lucide-react';

export interface SendButtonProps {
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否正在处理（显示停止按钮或排队发送按钮） */
  isProcessing?: boolean;
  /** 运行中输入正在接入（显示旋转加载图标） */
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
 * 3. 处理中 + 有内容：显示排队发送按钮
 * 4. 运行中输入接入中：显示旋转加载图标
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
  const baseIconButtonClass = 'flex-shrink-0 h-9 w-9 rounded-xl grid place-items-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20';

  // 运行中输入接入中：显示旋转加载图标
  if (isInterrupting) {
    return (
      <button
        type="button"
        disabled
        className={`${baseIconButtonClass} bg-white/[0.08] text-zinc-200 cursor-wait`}
        aria-label="正在处理运行中输入"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
      </button>
    );
  }

  // 处理中 + 有内容：显示排队到下一轮按钮
  if (isProcessing && hasContent) {
    return (
      <button
        type={type}
        onClick={onClick}
        className={`${baseIconButtonClass} bg-zinc-100 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),0_10px_24px_rgba(0,0,0,0.28)] hover:bg-white active:scale-95`}
        aria-label="排队到下一轮"
        title="排队到下一轮"
      >
        <ArrowUp className="h-4 w-4 stroke-[2.4]" />
      </button>
    );
  }

  // 处理中 + 无内容：显示停止按钮
  if (isProcessing) {
    return (
      <button
        type="button"
        onClick={onStop}
        className={`${baseIconButtonClass} bg-zinc-700/90 text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-zinc-600 active:scale-95`}
        aria-label="停止"
      >
        <Square className="h-3.5 w-3.5 fill-current stroke-[2.2]" />
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
            : 'bg-zinc-700 text-zinc-400 cursor-not-allowed scale-95 opacity-60'
        }`}
      >
        <ArrowUp className="w-4 h-4 stroke-[2.4]" />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      type={type}
      disabled={isDisabled}
      onClick={onClick}
      className={`${baseIconButtonClass} disabled:cursor-not-allowed ${
        showActiveState
          ? 'bg-zinc-100 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),0_10px_24px_rgba(0,0,0,0.28)] hover:bg-white active:scale-95'
          : 'bg-zinc-800/80 text-zinc-500 ring-1 ring-white/[0.04] opacity-70'
      }`}
      aria-label="发送消息"
    >
      <ArrowUp className="h-4 w-4 stroke-[2.4]" />
    </button>
  );
};

export default SendButton;
