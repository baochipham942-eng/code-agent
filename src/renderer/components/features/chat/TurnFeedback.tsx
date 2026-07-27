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

import React, { useCallback, useEffect, useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { TelemetryFeedbackRating } from '@shared/contract/telemetry';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';

interface Props {
  messageId: string;
  /** 差评时随附的完整回答，供离线复盘定位问题 */
  content: string;
}

// 评分早已持久化在 telemetry_feedback 表里，丢的是 UI 高亮（组件本地 state 重挂载即清零）。
// 这里按会话读回一次并在模块级缓存：同会话多个 TurnFeedback 共享一个请求，
// 提交成功时同步写缓存，切会话/重启后高亮仍在。
const sessionRatingsCache = new Map<string, Promise<Map<string, 1 | -1>>>();

function loadSessionRatings(sessionId: string): Promise<Map<string, 1 | -1>> {
  let cached = sessionRatingsCache.get(sessionId);
  if (!cached) {
    // Promise.resolve 包一层：测试环境的 ipcService mock 可能返回 undefined，别在 .then 上炸
    cached = Promise.resolve(ipcService.invoke(IPC_CHANNELS.TELEMETRY_GET_SESSION_FEEDBACK, sessionId))
      .then((rows) => new Map(((rows ?? []) as TelemetryFeedbackRating[]).map((r) => [r.messageId, r.rating])))
      .catch(() => {
        sessionRatingsCache.delete(sessionId); // 失败不缓存，下次重试
        return new Map<string, 1 | -1>();
      });
    sessionRatingsCache.set(sessionId, cached);
  }
  return cached;
}

export const TurnFeedback: React.FC<Props> = ({ messageId, content }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!currentSessionId || !messageId) return;
    let alive = true;
    loadSessionRatings(currentSessionId).then((map) => {
      if (alive && map.has(messageId)) setRating(map.get(messageId)!);
    });
    return () => { alive = false; };
  }, [currentSessionId, messageId]);

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
      // 同步进会话缓存：重挂载/切回会话时高亮不回退
      const cached = sessionRatingsCache.get(currentSessionId);
      if (cached) void cached.then((map) => map.set(messageId, next));
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
