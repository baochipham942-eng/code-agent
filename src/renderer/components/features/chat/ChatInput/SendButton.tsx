// ============================================================================
// SendButton - 发送按钮组件（含加载状态）
// ============================================================================

import React from 'react';
import { Send, Loader2 } from 'lucide-react';
import { IconButton } from '../../../primitives';

export interface SendButtonProps {
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否正在加载 */
  loading?: boolean;
  /** 是否有内容可发送 */
  hasContent?: boolean;
  /** 表单提交类型 */
  type?: 'submit' | 'button';
  /** 点击回调 */
  onClick?: () => void;
}

/**
 * 发送按钮 - 支持加载状态和内容状态的视觉反馈
 */
export const SendButton: React.FC<SendButtonProps> = ({
  disabled = false,
  loading = false,
  hasContent = false,
  type = 'submit',
  onClick,
}) => {
  const isDisabled = disabled || loading || !hasContent;
  const showActiveState = hasContent && !loading && !disabled;

  return (
    <IconButton
      icon={
        loading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Send
            className={`w-5 h-5 transition-transform duration-200 ${
              hasContent ? '-rotate-45' : ''
            }`}
          />
        )
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
