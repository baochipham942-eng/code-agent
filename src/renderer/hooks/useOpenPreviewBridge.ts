// 2b：监听 main 端 agent（如 ProposeSlidesOps）生成文档型产物后请求打开预览 tab。
// 全局常驻（App 顶层挂载），不依赖设计画布是否挂载。按当前会话过滤：仅当请求来自当前
// 会话才打开，避免背景会话的产物抢走前台焦点。
import { useEffect } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { openSurfaceForArtifact } from '../services/surfaceIntentDispatcher';
import { decideSurfaceIntent } from '../utils/surfaceIntent';

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
  return decideSurfaceIntent({
    artifact: { kind: 'file-preview', filePath: '<preview>' },
    artifactSessionId: payloadSessionId,
    currentSessionId,
    hasAutoFocusedThisTurn: false,
    userSwitchedAwayThisTurn: false,
  }) !== null;
}

export function useOpenPreviewBridge(): void {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.WORKSPACE_OPEN_PREVIEW,
      (payload: { filePath: string; sessionId?: string }) => {
        if (!payload?.filePath) return;
        openSurfaceForArtifact({
          artifact: { kind: 'file-preview', filePath: payload.filePath },
          artifactSessionId: payload.sessionId,
        });
      },
    );
    return unsubscribe;
  }, []);
}
