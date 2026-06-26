// 2b：监听 main 端 agent（如 ProposeSlidesOps）生成文档型产物后请求打开预览 tab。
// 全局常驻（App 顶层挂载），不依赖设计画布是否挂载。按当前会话过滤：仅当请求来自当前
// 会话才打开，避免背景会话的产物抢走前台焦点。
import { useEffect } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

/**
 * 是否允许打开预览（fail-closed）：
 * - 请求不带 sessionId（无会话上下文）→ 允许（无前台会话可保护）。
 * - 带 sessionId → 必须精确等于当前会话；current 为空或不同一律不开
 *   （防背景会话/null 前台时产物抢焦点，审计 M2）。
 */
export function shouldOpenPreview(
  payloadSessionId: string | undefined,
  currentSessionId: string | null | undefined,
): boolean {
  if (!payloadSessionId) return true;
  return payloadSessionId === currentSessionId;
}

export function useOpenPreviewBridge(): void {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.WORKSPACE_OPEN_PREVIEW,
      (payload: { filePath: string; sessionId?: string }) => {
        if (!payload?.filePath) return;
        const currentSessionId = useSessionStore.getState().currentSessionId;
        if (!shouldOpenPreview(payload.sessionId, currentSessionId)) return;
        useAppStore.getState().openPreview(payload.filePath);
      },
    );
    return unsubscribe;
  }, []);
}
