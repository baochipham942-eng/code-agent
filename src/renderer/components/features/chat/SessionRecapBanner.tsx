// ============================================================================
// SessionRecapBanner —— 回会话追赶提示（A6）
// ============================================================================
//
// 隔天/隔小时回到一个会话（尤其 agent 在后台跑完了活的会话）时，顶部给一句话
// "你不在的时候产出发生了什么"。文案由 host 侧 sessionRecapService 生成，素材只来自
// 产物快照 + 任务账本，不读聊天流水。
//
// "不打扰连续使用中的会话"靠 lastViewed 自然实现：进入会话时先读上次进入的时间戳、
// 再把它刷成现在。你人在会话里看着跑完的轮次，下次进来时已在时间戳之前，不会再追赶
// 一遍；离开后跑完的轮次才会被算进来。
//
// 在场持续推进水位（X5.5-B4）：原来 lastViewed 只在挂载时写一次，人全程在场盯着
// 跑完、视图一重挂载就拿「切入时刻」当基准误报追赶。现在可见且聚焦期间每 30s
// 心跳推进一次，离开/失焦与回来/复焦的当下也各刷一次——屏幕上渲染过的变化不进
// 追赶摘要；离开期间心跳停写，那段空窗的变化才会被算作「你不在的时候」。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';

interface SessionRecapView {
  text: string;
  degraded: boolean;
  completedCount: number;
  blockedCount: number;
}

const STORAGE_PREFIX = 'neo:recap:lastViewed:';
// 可见期心跳粒度：工单拍板 30s——误报窗口最多 30s 内已上屏的变化，可接受
const PRESENCE_HEARTBEAT_MS = 30_000;

function readLastViewed(sessionId: string): number {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${sessionId}`);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeLastViewed(sessionId: string, timestamp: number): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${sessionId}`, String(timestamp));
  } catch {
    // 隐私模式 / 配额满：追赶提示不值得为此报错，静默跳过
  }
}

export const SessionRecapBanner: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const [recap, setRecap] = useState<SessionRecapView | null>(null);

  useEffect(() => {
    setRecap(null);
    if (!sessionId) return;

    const since = readLastViewed(sessionId);
    const advance = () => writeLastViewed(sessionId, Date.now());
    advance();
    // 第一次进这个会话没有"上次"可比，不追赶
    const shouldFetchRecap = Boolean(since);

    // 在场（可见且聚焦）持续推进已看水位：可见期 30s 心跳 + 切走/回来即时刷。
    // 切走前一刻也算"看过"——屏幕上渲染过的变化不进下次追赶摘要；
    // 离开期间心跳停写，空窗里的变化才进追赶。
    const isPresent = () => document.visibilityState === 'visible' && document.hasFocus();
    const heartbeat = window.setInterval(() => {
      if (isPresent()) advance();
    }, PRESENCE_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', advance);
    window.addEventListener('focus', advance);
    window.addEventListener('blur', advance);

    let cancelled = false;
    if (shouldFetchRecap) {
      void window.domainAPI
        ?.invoke<SessionRecapView | null>(IPC_DOMAINS.SESSION, 'getRecap', { sessionId, since })
        .then((response) => {
          if (cancelled || !response?.success || !response.data) return;
          setRecap(response.data);
        })
        .catch(() => {
          // 追赶提示是锦上添花，拿不到就不显示
        });
    }

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', advance);
      window.removeEventListener('focus', advance);
      window.removeEventListener('blur', advance);
    };
  }, [sessionId]);

  if (!recap) return null;

  return (
    <div
      role="status"
      className="mx-4 mt-2 flex items-start gap-2 rounded-lg border border-badge-info/60 bg-sky-950/30 px-3 py-2 text-xs text-zinc-300"
    >
      <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-badge-info" />
      <span className="min-w-0 flex-1">
        <span className="text-zinc-500">{t.sessionRecap.prefix}</span>
        {recap.text}
      </span>
      <button
        type="button"
        onClick={() => setRecap(null)}
        aria-label={t.sessionRecap.dismissLabel}
        className="flex-shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
