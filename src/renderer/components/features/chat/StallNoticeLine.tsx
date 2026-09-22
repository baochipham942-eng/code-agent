import React, { useEffect, useRef, useState } from 'react';
import { ipcService } from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useSessionStore } from '../../../stores/sessionStore';

interface StallNotice {
  sessionId?: string;
  level?: 'hint' | 'escalated';
  phase?: 'tool' | 'model';
  detail?: string;
  clear?: boolean;
}

export const StallNoticeLine: React.FC<{ hidden?: boolean }> = ({ hidden = false }) => {
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const [notice, setNotice] = useState<StallNotice | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.STALL_NOTICE, (payload: StallNotice) => {
      if (payload.sessionId && payload.sessionId !== useSessionStore.getState().currentSessionId) return;
      if (hiddenRef.current && !payload.clear) return;
      if (payload.clear || !payload.level) {
        setNotice(null);
        return;
      }
      setNotice(payload);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    setNotice(null);
  }, [sessionId]);

  useEffect(() => {
    if (hidden) setNotice(null);
  }, [hidden]);

  if (!notice || hidden || !notice.level) return null;
  const stuckOn = notice.phase === 'tool' ? notice.detail : '等模型回响';
  return (
    <div
      data-testid="stall-notice"
      className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-500"
    >
      <span>{notice.level === 'escalated' ? '还是卡住' : '卡住了'}：{stuckOn}</span>
      <button
        type="button"
        className="text-zinc-300 underline-offset-2 hover:underline"
        onClick={() => {
          void ipcService.invoke(IPC_CHANNELS.AGENT_CANCEL, { sessionId: notice.sessionId ?? sessionId ?? undefined });
          setNotice(null);
        }}
      >
        先停下
      </button>
    </div>
  );
};
