// 2b：监听 main 端 agent（如 ProposeSlidesOps）生成文档型产物后请求打开预览 tab。
// 全局常驻（App 顶层挂载），不依赖设计画布是否挂载。按当前会话过滤：仅当请求来自当前
// 会话才打开，避免背景会话的产物抢走前台焦点。
import { useEffect } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

export function useOpenPreviewBridge(): void {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.WORKSPACE_OPEN_PREVIEW,
      (payload: { filePath: string; sessionId?: string }) => {
        if (!payload?.filePath) return;
        // 背景会话产物不抢前台焦点：带 sessionId 且非当前会话则忽略（文件已生成，用户可手动打开）。
        if (payload.sessionId) {
          const currentSessionId = useSessionStore.getState().currentSessionId;
          if (currentSessionId && payload.sessionId !== currentSessionId) return;
        }
        useAppStore.getState().openPreview(payload.filePath);
      },
    );
    return unsubscribe;
  }, []);
}
