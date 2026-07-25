// ============================================================================
// TurnFeedback - 一轮的好评/差评，锚在整轮末尾
// ============================================================================
// 原来这两个按钮挂在「最后一个助手正文节点」内部渲染，于是会插在正文和文件变更卡
// 之间——评价对象看起来是上面那一句话（dogfood 里正好是「已创建 x.txt。」），
// 而且把答案和它产出的东西切成了两段。
//
// 评价的对象是这一轮的回答，不是其中某个文本片段，所以位置就该在整轮最后。
// 锚点仍用那个 eligible 节点的 messageId，后端契约不变。
// ============================================================================

import React, { useCallback, useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';

interface Props {
  messageId: string;
  /** 差评时随附的完整回答，供离线复盘定位问题 */
  content: string;
}

export const TurnFeedback: React.FC<Props> = ({ messageId, content }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async (next: 1 | -1) => {
    if (!currentSessionId || !messageId || submitting) return;
    setSubmitting(true);
    setRating(next);
    try {
      await ipcService.invoke(IPC_CHANNELS.TELEMETRY_SUBMIT_FEEDBACK, {
        sessionId: currentSessionId,
        turnId: messageId,
        messageId,
        rating: next,
        fullContent: next === -1
          ? { messageId, assistantResponse: content }
          : undefined,
      });
    } catch {
      setRating(null);
    } finally {
      setSubmitting(false);
    }
  }, [content, currentSessionId, messageId, submitting]);

  if (!currentSessionId || !messageId) return null;

  return (
    <div className="mt-2 flex items-center justify-start gap-1" data-testid="turn-feedback">
      <button
        type="button"
        onClick={() => submit(1)}
        disabled={submitting}
        className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
          rating === 1
            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
            : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300'
        }`}
        title={t.turnFeedback.helpful}
        aria-label={t.turnFeedback.helpful}
        aria-pressed={rating === 1}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => submit(-1)}
        disabled={submitting}
        className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
          rating === -1
            ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
            : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300'
        }`}
        title={t.turnFeedback.problem}
        aria-label={t.turnFeedback.problem}
        aria-pressed={rating === -1}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
