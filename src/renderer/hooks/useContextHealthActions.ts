// ============================================================================
// useContextHealthActions - ContextUsagePill 明细弹层的 compact handler
// 仅保留弹层需要的压缩动作与反馈状态。
// ============================================================================

import { useCallback } from 'react';
import { toast } from './useToast';
import { useI18n } from './useI18n';
import ipcService from '../services/ipcService';
import { useSessionStore } from '../stores/sessionStore';
import { useContextCompactionStore } from '../stores/contextCompactionStore';
import { IPC_CHANNELS } from '@shared/ipc';

export interface ContextHealthActions {
  handleCompact: () => Promise<void>;
  isCompacting: boolean;
}

export function useContextHealthActions(): ContextHealthActions {
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const compactionStatus = useContextCompactionStore((s) => s.status);
  const startCompaction = useContextCompactionStore((s) => s.start);
  const succeedCompaction = useContextCompactionStore((s) => s.succeed);
  const failCompaction = useContextCompactionStore((s) => s.fail);

  // 与 ContextUsagePill.tsx 的 handleCompact 同一套路：useContextCompactionStore 单例
  // 守重入（'active' 直接 return），跟 pill 天然互斥，两处入口不会并发触发两次压缩。
  const handleCompact = useCallback(async () => {
    if (compactionStatus === 'active') return;
    const sessionId = useSessionStore.getState().currentSessionId;
    startCompaction();
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPACT_CURRENT, sessionId ?? undefined);
      if (result.success) {
        succeedCompaction(result);
        if (sessionId) {
          void useSessionStore.getState().refreshContextHealth(sessionId);
        }
      } else {
        failCompaction(ch.compactFailed);
        toast.error(ch.compactFailedToast);
      }
    } catch {
      failCompaction(ch.compactFailed);
      toast.error(ch.compactFailedToast);
    }
  }, [ch, compactionStatus, failCompaction, startCompaction, succeedCompaction]);

  return {
    handleCompact,
    isCompacting: compactionStatus === 'active',
  };
}
