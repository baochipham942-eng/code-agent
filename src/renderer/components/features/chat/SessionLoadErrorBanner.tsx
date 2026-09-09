import React, { useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { Message } from '@shared/contract';
import { redactCredentialText } from '@shared/security/secretPatterns';
import { useSessionStore } from '../../../stores/sessionStore';
import { hydrateToolCallResults } from '../../../utils/messageHydration';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';

/** Viewing the authorized saved projection never restores a runnable session. */
export const SessionLoadErrorBanner: React.FC = () => {
  const { t } = useI18n();
  const error = useSessionStore((state) => state.error);
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  if (!error || !sessionId) return null;
  const c = t.deliveryExperience;
  const viewSaved = async () => {
    setLoading(true);
    setReadError(null);
    try {
      // This existing host endpoint checks session ownership before reading messages.
      const response = await window.domainAPI?.invoke<Message[]>(IPC_DOMAINS.SESSION, 'getMessages', { sessionId });
      if (!response?.success) throw new Error(response?.error?.message || c.historyReadFailed);
      const state = useSessionStore.getState();
      if (state.currentSessionId !== sessionId || state.error !== error) return;
      state.setMessages(hydrateToolCallResults(response.data ?? []));
      // Keep the load error: reading history must not unlock task execution.
    } catch (cause) {
      setReadError(cause instanceof Error ? cause.message : c.historyReadFailed);
    } finally { setLoading(false); }
  };
  return <div role="alert" className="my-2 rounded-lg border border-badge-warning/30 bg-surface-subtle px-4 py-3 text-xs leading-5 text-zinc-300">
    <p className="font-medium">{c.sessionLoadFailed}</p>
    <p className="mt-1 text-zinc-400">{c.savedHistoryNotice}</p>
    <div className="mt-2 flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={loading} onClick={() => void viewSaved()}>{c.viewSavedHistory}</Button>
      <Button size="sm" variant="ghost" onClick={() => void useSessionStore.getState().switchSession(sessionId, { force: true })}>{c.retrySessionLoad}</Button>
    </div>
    <details className="mt-2 text-zinc-500"><summary className="cursor-pointer">{c.loadDetails}</summary><p className="whitespace-pre-wrap break-words">{redactCredentialText(readError || error)}</p></details>
  </div>;
};
