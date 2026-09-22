import React, { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useAppStore } from '../../../stores/appStore';
import { create } from 'zustand';
import { ipcService } from '../../../services/ipcService';

interface DoomLoopHandbackState {
  sessionId: string | null;
  offer: (sessionId: string) => void;
  clear: () => void;
}

export const useDoomLoopHandbackStore = create<DoomLoopHandbackState>((set) => ({
  sessionId: null,
  offer: (sessionId) => set({ sessionId }),
  clear: () => set({ sessionId: null }),
}));

export const DoomLoopHandbackBar: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const offered = useDoomLoopHandbackStore((state) => state.sessionId);
  const clear = useDoomLoopHandbackStore((state) => state.clear);
  const language = useAppStore((state) => state.language);
  const visible = Boolean(offered && sessionId && offered === sessionId);
  const zh = language !== 'en';
  const choose = useCallback(async (choice: 'retry' | 'stop') => {
    if (!offered) return;
    clear();
    if (!ipcService.isAvailable()) return;
    await ipcService.invoke(IPC_CHANNELS.AGENT_DOOM_LOOP_HANDBACK, offered, choice);
  }, [clear, offered]);
  if (!visible) return null;
  return (
    <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-badge-warning/30 bg-amber-500/5 px-3 py-2 text-sm">
      <AlertTriangle className="h-4 w-4 text-badge-warning" />
      <span className="text-zinc-200">
        {zh ? '同一操作反复出现。换个方法，还是停止这次运行？' : 'The same action is repeating. Try another method, or stop this run?'}
      </span>
      <button /* ds-allow:button: 卡死交还的紧凑操作行沿用 GoalNoticeMessage 小按钮 */
        type="button" className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200" onClick={() => { void choose('retry'); }}>
        {zh ? '换个方法试试' : 'Try another method'}
      </button>
      <button /* ds-allow:button: 卡死交还的紧凑操作行沿用 GoalNoticeMessage 小按钮 */
        type="button" className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200" onClick={() => { void choose('stop'); }}>
        {zh ? '停止这次运行' : 'Stop this run'}
      </button>
    </div>
  );
};
