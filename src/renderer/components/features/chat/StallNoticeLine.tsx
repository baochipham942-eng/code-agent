import React, { useEffect, useState } from 'react';
import { ipcService } from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useSessionStore } from '../../../stores/sessionStore';

interface StallNotice {
  level: 'hint' | 'escalated';
  phase: 'tool' | 'model';
  detail: string;
}

export const StallNoticeLine: React.FC<{ hidden?: boolean }> = ({ hidden = false }) => {
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const [notice, setNotice] = useState<StallNotice | null>(null);

  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.STALL_NOTICE, (payload: StallNotice) => {
      setNotice(payload);
    });
    return () => unsubscribe?.();
  }, []);

  if (!notice || hidden) return null;
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
          void ipcService.invoke(IPC_CHANNELS.AGENT_CANCEL, { sessionId: sessionId ?? undefined });
          setNotice(null);
        }}
      >
        先停下
      </button>
    </div>
  );
};
