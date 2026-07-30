import { useEffect, useState } from 'react';
import { createSwarmTraceStorageId } from '@shared/contract/swarm';
import type { SwarmRunDetail } from '@shared/contract/swarmTrace';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useSwarmStore } from '../stores/swarmStore';

/**
 * 子任务可见状态只从持久化 API 读取。Swarm stream 仅提供作用域与刷新信号，
 * 不直接决定胶囊、成员条或侧栏里的 running/terminal 状态。
 */
export function useDurableSwarmRunDetail(sessionId: string | null): SwarmRunDetail | null {
  const activeSessionId = useSwarmStore((state) => state.activeSessionId);
  const activeRunId = useSwarmStore((state) => state.activeRunId);
  const activeTreeId = useSwarmStore((state) => state.activeTreeId);
  const refreshSignal = useSwarmStore((state) => state.lastEventAt);
  const [detail, setDetail] = useState<SwarmRunDetail | null>(null);

  useEffect(() => {
    let current = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setDetail(null);
    if (!sessionId) return () => { current = false; };

    const load = async (): Promise<void> => {
      let storageRunId: string | undefined;
      const isActiveScope = activeSessionId === sessionId && Boolean(activeRunId && activeTreeId);
      if (isActiveScope && activeRunId && activeTreeId) {
        storageRunId = createSwarmTraceStorageId({
          sessionId,
          runId: activeRunId,
          treeId: activeTreeId,
        });
      } else {
        const runs = await ipcService.invoke(IPC_CHANNELS.SWARM_LIST_TRACE_RUNS, {
          sessionId,
          limit: 1,
        });
        storageRunId = runs[0]?.id;
      }
      if (!storageRunId) return;
      const next = await ipcService.invoke(IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL, {
        sessionId,
        runId: storageRunId,
      });
      if (!current) return;
      setDetail(next);
      // stream 只负责提醒“可能有新事实”。持久化写入与 IPC 通知可能有极短竞态，
      // 因此活跃且仍 running 时继续从 API 轮询，直到账本给出终态。
      if (isActiveScope && next?.run.status === 'running') {
        refreshTimer = setTimeout(() => {
          void load().catch(() => {
            if (current) setDetail(null);
          });
        }, 500);
      }
    };

    void load().catch(() => {
      if (current) setDetail(null);
    });
    return () => {
      current = false;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [activeRunId, activeSessionId, activeTreeId, refreshSignal, sessionId]);

  return detail;
}
