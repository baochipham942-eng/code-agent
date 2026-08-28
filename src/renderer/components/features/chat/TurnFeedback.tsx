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
import { TELEMETRY_TRUNCATION } from '@shared/constants';
import type { TelemetryFeedbackRating } from '@shared/contract/telemetry';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives';

interface Props {
  messageId: string;
  /** 用户显式勾选后随差评附上的完整回答，供离线复盘定位问题 */
  content: string;
}

type WhyState = 'hidden' | 'editing' | 'received';

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
  const [whyState, setWhyState] = useState<WhyState>('hidden');
  const [comment, setComment] = useState('');
  const [includeAnswer, setIncludeAnswer] = useState(false);
  const [whySubmitting, setWhySubmitting] = useState(false);

  useEffect(() => {
    if (!currentSessionId || !messageId) return;
    let alive = true;
    loadSessionRatings(currentSessionId).then((map) => {
      if (alive && map.has(messageId)) setRating(map.get(messageId)!);
    });
    return () => { alive = false; };
  }, [currentSessionId, messageId]);

  const submitRating = useCallback(async (next: 1 | -1) => {
    if (!currentSessionId || !messageId || submitting) return;
    setSubmitting(true);
    setRating(next);
    try {
      await ipcService.invoke(IPC_CHANNELS.TELEMETRY_SUBMIT_FEEDBACK, {
        sessionId: currentSessionId,
        turnId: messageId,
        messageId,
        rating: next,
      });
      // 同步进会话缓存：重挂载/切回会话时高亮不回退
      const cached = sessionRatingsCache.get(currentSessionId);
      if (cached) void cached.then((map) => map.set(messageId, next));
      setWhyState(next === -1 ? 'editing' : 'hidden');
      if (next === 1) {
        setComment('');
        setIncludeAnswer(false);
      }
    } catch {
      setRating(null);
    } finally {
      setSubmitting(false);
    }
  }, [currentSessionId, messageId, submitting]);

  const handleRatingClick = useCallback((next: 1 | -1) => {
    // 已有点踩只负责重新展开输入，避免一次无 comment 的重复 upsert 清掉旧理由。
    if (next === -1 && rating === -1) {
      setWhyState('editing');
      return;
    }
    void submitRating(next);
  }, [rating, submitRating]);

  const submitWhy = useCallback(async () => {
    const nextComment = comment.trim();
    if (!currentSessionId || !messageId || !nextComment || whySubmitting) return;
    setWhySubmitting(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.TELEMETRY_SUBMIT_FEEDBACK, {
        sessionId: currentSessionId,
        turnId: messageId,
        messageId,
        rating: -1,
        comment: nextComment,
        ...(includeAnswer
          ? { fullContent: { messageId, assistantResponse: content } }
          : {}),
      });
      setComment('');
      setIncludeAnswer(false);
      setWhyState('received');
    } catch {
      // 保留文字和勾选态，用户可以直接重试。
    } finally {
      setWhySubmitting(false);
    }
  }, [comment, content, currentSessionId, includeAnswer, messageId, whySubmitting]);

  const skipWhy = useCallback(() => {
    setComment('');
    setIncludeAnswer(false);
    setWhyState('hidden');
  }, []);

  if (!currentSessionId || !messageId) return null;

  return (
    <div className="flex flex-col items-start gap-2" data-testid="turn-feedback">
      <div className="flex items-center justify-start gap-1">
        <button
          type="button"
          onClick={() => handleRatingClick(1)}
          disabled={submitting}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
            rating === 1
              ? 'border-badge-success/30 bg-emerald-400/10 text-badge-success'
              : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:bg-neutral-100 hover:text-neutral-700 dark:text-zinc-500 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-300'
          }`}
          title={t.turnFeedback.helpful}
          aria-label={t.turnFeedback.helpful}
          aria-pressed={rating === 1}
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => handleRatingClick(-1)}
          disabled={submitting}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
            rating === -1
              ? 'border-badge-danger/30 bg-rose-400/10 text-badge-danger'
              : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:bg-neutral-100 hover:text-neutral-700 dark:text-zinc-500 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-300'
          }`}
          title={t.turnFeedback.problem}
          aria-label={t.turnFeedback.problem}
          aria-pressed={rating === -1}
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </div>

      {whyState === 'editing' && (
        <div
          className="w-full max-w-xl rounded-lg border border-neutral-200 bg-white/70 p-2.5 dark:border-zinc-700/70 dark:bg-zinc-900/35"
          data-testid="turn-feedback-why"
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={comment}
              maxLength={TELEMETRY_TRUNCATION.EVENT_SUMMARY}
              disabled={whySubmitting}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitWhy();
                }
              }}
              placeholder={t.turnFeedbackWhy.placeholder}
              aria-label={t.turnFeedbackWhy.placeholder}
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 outline-none placeholder:text-neutral-500 focus:border-neutral-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-200 dark:placeholder:text-zinc-600 dark:focus:border-zinc-500"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void submitWhy()}
              disabled={whySubmitting || !comment.trim()}
            >
              {t.turnFeedbackWhy.send}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={skipWhy}
              disabled={whySubmitting}
            >
              {t.turnFeedbackWhy.skip}
            </Button>
          </div>
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-neutral-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={includeAnswer}
              disabled={whySubmitting}
              onChange={(event) => setIncludeAnswer(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-neutral-400 bg-white accent-neutral-800 dark:border-zinc-600 dark:bg-zinc-900 dark:accent-zinc-200"
            />
            <span>{t.turnFeedbackWhy.includeAnswer}</span>
          </label>
          <p className="mt-1.5 text-[11px] leading-4 text-neutral-500 dark:text-zinc-500">{t.turnFeedbackWhy.uploadNotice}</p>
        </div>
      )}

      {whyState === 'received' && (
        <p className="text-xs text-neutral-500 dark:text-zinc-500" data-testid="turn-feedback-received">
          {t.turnFeedbackWhy.received}
        </p>
      )}
    </div>
  );
};
