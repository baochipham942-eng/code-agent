// ============================================================================
// SendButton - 发送按钮组件（含加载状态和停止功能）
// ============================================================================

import React from 'react';
import { Send, Square } from 'lucide-react';

export interface SendButtonProps {
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否正在处理（显示停止按钮） */
  isProcessing?: boolean;
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
 * 发送按钮 - 处理中变为停止按钮
 */
export const SendButton: React.FC<SendButtonProps> = ({
  disabled = false,
  isProcessing = false,
  hasContent = false,
  type = 'submit',
  onClick,
  onStop,
  label,
}) => {
  // 处理中时显示停止按钮（柔和样式，白色图标 + 浅灰背景）
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
            hasContent ? '-rotate-45' : ''
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
          hasContent ? '-rotate-45' : ''
        }`}
      />
    </button>
  );
};

export default SendButton;
