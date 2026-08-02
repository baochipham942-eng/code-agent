// 会话终态留影帧的清理：内存半与落盘半在这里同源，别在 sessionStore 里各写各的。
import { deletePersistedSurfaceTerminalFrames } from '../services/surfaceExecutionClient';
import { createLogger } from '../utils/logger';
import { useSurfaceExecutionStore } from './surfaceExecutionStore';

const logger = createLogger('SessionTerminalFrames');

/** 内存半：帧随会话从 store 清掉。盘上那半由 host 的会话删除收敛点负责。 */
export function forgetConversationFramesInMemory(conversationId: string): void {
  useSurfaceExecutionStore.getState().clearConversation(conversationId);
}

/**
 * 「清空当前对话」的两半清理：先删盘上的帧，删成了才清内存。
 *
 * 返回错误文案；`null` 表示清干净了。**调用方拿到非 null 必须中止**——盘上的帧还在
 * 却把界面清空，就是「用户以为删了其实还在」，比不做持久化更糟。
 */
export async function clearConversationTerminalFrames(
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    await deletePersistedSurfaceTerminalFrames({ version: 1, conversationId });
    forgetConversationFramesInMemory(conversationId);
    return null;
  } catch (error) {
    logger.error('Failed to clear persisted terminal frames', error);
    return error instanceof Error ? error.message : 'Failed to clear conversation';
  }
}
