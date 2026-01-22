// ============================================================================
// SendButton - 发送按钮组件（含加载状态和停止功能）
// ============================================================================

import React from 'react';
import { Send, Loader2, Square } from 'lucide-react';
import { IconButton } from '../../../primitives';

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
}) => {
  // 处理中时显示停止按钮（柔和样式，白色图标 + 浅灰背景）
  if (isProcessing) {
    return (
      <IconButton
        icon={<Square className="w-full h-full fill-current" />}
        aria-label="停止"
        type="button"
        variant="default"
        size="lg"
        onClick={onStop}
        className="flex-shrink-0 mr-2 !rounded-xl !text-zinc-300 transition-all duration-200 bg-zinc-700 hover:bg-zinc-600 hover:!text-white"
      />
    );
  }

  const isDisabled = disabled || !hasContent;
  const showActiveState = hasContent && !disabled;

  return (
    <IconButton
      icon={
        <Send
          className={`w-5 h-5 transition-transform duration-200 ${
            hasContent ? '-rotate-45' : ''
          }`}
        />
      }
      aria-label="发送消息"
      type={type}
      disabled={isDisabled}
      variant={showActiveState ? 'default' : 'ghost'}
      size="lg"
      onClick={onClick}
      className={`flex-shrink-0 mr-2 !rounded-xl !text-white transition-all duration-300 ${
        showActiveState
          ? 'bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-500 hover:to-primary-400 shadow-lg shadow-primary-500/20 hover:shadow-primary-500/30 scale-100 hover:scale-105'
          : 'bg-zinc-700/50 cursor-not-allowed scale-95 opacity-60'
      }`}
    />
  );
};

export default SendButton;
