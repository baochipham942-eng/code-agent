import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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
      <div className="max-h-[60vh] overflow-y-auto px-4 pb-3">
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
