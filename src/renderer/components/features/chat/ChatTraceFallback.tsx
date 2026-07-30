// ============================================================================
// ChatTraceFallback - 消息区渲染失败时的会话级降级面
// ============================================================================

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';

/**
 * 消息区（TurnBasedTraceView）渲染失败时就地显示的降级面。
 *
 * 语义是「这一个会话的消息列表画不出来」，不是「应用挂了」——侧栏、输入框、
 * 其余会话都还能用，用户可以切到别的会话继续干活。
 */
export const ChatTraceFallback: React.FC = () => {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
      <p className="text-sm text-zinc-300">{t.traceView.renderFailedTitle}</p>
      <p className="text-xs text-zinc-500">{t.traceView.renderFailedHint}</p>
    </div>
  );
};
