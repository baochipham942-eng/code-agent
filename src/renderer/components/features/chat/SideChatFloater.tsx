import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X as XIcon } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { askSideChat, SideChatRequestError } from '../../../services/sideChatClient';
import type { SideChatFailureCause } from '@shared/ipc';
import {
  dismissSideChat,
  getSideChatRequest,
  subscribeSideChat,
  type SideChatRequest,
} from './sideChatFloaterState';

const SHELL_CLASS = 'absolute bottom-full right-0 z-30 mb-2 w-[440px] max-w-[calc(100vw-2rem)] rounded-xl border border-border-hover bg-zinc-900/95 shadow-md dark:shadow-2xl backdrop-blur';

// 正文高度帽：锚点（输入区容器）上方的可用空间 = 视口高 − 输入区高，与 60vh（相对
// 视口）是两个口径。输入区随草稿长高（textarea cap 200px）后，长答案会把标题行连同
// 关闭 X 顶出视口顶（实测 1280×600 + 高输入区：浮层 top −73.5px、X 完全不可点）。
// 所以正文帽取 min(60vh, 可用空间)，量不到布局（jsdom）时维持 60vh class 兜底。
// 视口顶预留：TitleBar（TitleBar.tsx 的 h-12 标题条，48px，透明背景但层叠在浮层之上）
// 盖着浮层的嵌套层叠上下文——标题行顶进这 48px 时 X 看得见但点不中。预留 = 48 + 8 呼吸。
const BODY_VIEWPORT_GAP_PX = 56;
const BODY_MIN_HEIGHT_PX = 64; // 极矮视口下正文至少保留的高度（再小整块塌成只剩标题行）

function causeLine(copy: { error: string; errorAuth: string; errorTimeout: string }, cause: SideChatFailureCause): string {
  if (cause === 'auth') return copy.errorAuth;
  if (cause === 'timeout') return copy.errorTimeout;
  return copy.error;
}

function SideChatFloaterPanel({ request }: { request: SideChatRequest }) {
  const { t } = useI18n();
  const copy = t.sideChat;
  const [phase, setPhase] = useState<'loading' | 'answer' | 'error'>('loading');
  const [answer, setAnswer] = useState('');
  const [cause, setCause] = useState<SideChatFailureCause>('unknown');
  // 重试 = 同一问题重发一次：attempt 变化让 effect 重跑（cleanup 会 abort 上一次）。
  const [attempt, setAttempt] = useState(0);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [bodyMaxHeight, setBodyMaxHeight] = useState<number | null>(null);

  const remeasureBodyCap = useCallback(() => {
    const shell = shellRef.current;
    const anchor = shell?.offsetParent;
    if (!shell || !(anchor instanceof HTMLElement)) return;
    const anchorTop = anchor.getBoundingClientRect().top;
    if (anchorTop <= 0) return; // 无布局（jsdom）或锚点不在视口内：维持 60vh class 兜底
    const header = shell.firstElementChild;
    const headerHeight = header instanceof HTMLElement ? header.getBoundingClientRect().height : 0;
    const vhCap = window.innerHeight * 0.6; // 与 max-h-[60vh] 同口径
    // 锚点上沿到视口顶，减 mb-2（8px）、视口顶呼吸、标题行高，就是正文能占的高度。
    const available = anchorTop - 8 - BODY_VIEWPORT_GAP_PX - headerHeight;
    setBodyMaxHeight(Math.max(Math.floor(Math.min(vhCap, available)), BODY_MIN_HEIGHT_PX));
  }, []);

  useLayoutEffect(() => {
    remeasureBodyCap();
    window.addEventListener('resize', remeasureBodyCap);
    // 答案展示中用户会继续打草稿：输入区长高必须实时重算正文帽（浮层是 absolute，不影响锚点尺寸，无环）
    const anchor = shellRef.current?.offsetParent instanceof HTMLElement ? shellRef.current.offsetParent : null;
    let observer: ResizeObserver | undefined;
    if (anchor && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(remeasureBodyCap);
      observer.observe(anchor);
    }
    return () => {
      window.removeEventListener('resize', remeasureBodyCap);
      observer?.disconnect();
    };
  }, [remeasureBodyCap]);

  const handleSideChatAnswer = useCallback((text: string) => {
    setAnswer(text);
    setPhase('answer');
  }, []);

  useEffect(() => {
    setPhase('loading');
    const controller = new AbortController();
    let active = true;
    void askSideChat(
      { sessionId: request.sessionId, question: request.question },
      controller.signal,
    ).then((text) => {
      if (!active || controller.signal.aborted || getSideChatRequest()?.id !== request.id) return;
      handleSideChatAnswer(text);
    }).catch((err: unknown) => {
      if (!active || controller.signal.aborted || getSideChatRequest()?.id !== request.id) return;
      setCause(err instanceof SideChatRequestError ? err.cause : 'unknown');
      setPhase('error');
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [handleSideChatAnswer, attempt, request.id, request.question, request.sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismissSideChat();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      ref={shellRef}
      className={SHELL_CLASS}
      data-testid="side-chat-floater"
      role="dialog"
      aria-label={copy.dialogLabel}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-xs font-medium text-zinc-300">{copy.title}</span>
        <button // ds-allow:button
          type="button"
          onClick={dismissSideChat}
          aria-label={copy.closeAria}
          className="inline-flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-zinc-300"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* 60vh class 是量不到布局时的兜底；量到后由内联 maxHeight（min(60vh, 锚点上方可用空间)）接管 */}
      <div
        className="max-h-[60vh] overflow-y-auto px-4 pb-3"
        style={bodyMaxHeight === null ? undefined : { maxHeight: bodyMaxHeight }}
      >
        <p className="text-[11px] text-zinc-400 whitespace-pre-wrap">{request.question}</p>
        {phase === 'loading' ? <p className="text-[11px] text-zinc-400">{copy.loading}</p> : null}
        {phase === 'answer' ? <p className="text-xs text-zinc-300 whitespace-pre-wrap">{answer}</p> : null}
        {phase === 'error' ? (
          <div className="mt-1">
            <p className="text-[11px] text-zinc-400">{causeLine(copy, cause)}</p>
            <button // ds-allow:button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border-muted bg-surface-hover px-3 py-1.5 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/[0.1]"
            >
              {copy.retry}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SideChatFloater({ activeSessionId }: { activeSessionId: string | null }) {
  const request = useSyncExternalStore(subscribeSideChat, getSideChatRequest, getSideChatRequest);

  useEffect(() => {
    if (request && request.sessionId !== activeSessionId) dismissSideChat();
  }, [activeSessionId, request]);

  if (request?.sessionId !== activeSessionId) return null;
  return <SideChatFloaterPanel key={request.id} request={request} />;
}
