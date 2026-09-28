import React, { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { toast } from '../../../hooks/useToast';

export function useDurableResumeContinuation(sessionId?: string | null): () => Promise<void> {
  return useCallback(async () => {
    if (!sessionId) return;
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.AGENT, 'continue', { sessionId });
      void useSessionStore.getState().loadSessions({ silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId]);
}

export const DurableResumeNotice: React.FC<{ text: string }> = ({ text }) => (
  <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-4 text-xs text-zinc-400" data-testid="durable-resume-notice">
    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true" />
    <span>{text}</span>
  </div>
);
