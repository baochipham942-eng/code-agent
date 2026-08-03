// 监听 host 侧 terminal_open 工具请求「把终端亮出来」。全局常驻（App 顶层挂载），
// 不依赖终端面板是否已挂载——这正是它存在的理由：面板没开的时候也要能开出来。
// 抢焦点的节制（会话不匹配 fail-closed / 每轮一次 / 用户手动切走不抢回）全部复用
// surfaceIntent 既有礼仪，这里不另造判断。
import { useEffect } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { openSurfaceForArtifact } from '../services/surfaceIntentDispatcher';

export function useTerminalRevealBridge(): void {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.TERMINAL_REVEAL,
      (payload: { sessionId: string }) => {
        if (!payload?.sessionId) return;
        openSurfaceForArtifact({
          artifact: { kind: 'terminal' },
          artifactSessionId: payload.sessionId,
        });
      },
    );
    return unsubscribe;
  }, []);
}
