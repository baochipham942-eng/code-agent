import { useDesignCanvasStore } from './designCanvasStore';

/**
 * 设计画布会话的统一激活判据。
 *
 * per-session 设计态与画布属主必须同时命中；画布无主或属于其他会话时一律
 * fail-closed，避免跨会话读取画布上下文或把付费生成结果写入错误画布。
 */
export function isDesignCanvasActiveForSession(
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const canvas = useDesignCanvasStore.getState();
  return canvas.isSessionDesignActive(sessionId) && canvas.ownerSessionId === sessionId;
}
