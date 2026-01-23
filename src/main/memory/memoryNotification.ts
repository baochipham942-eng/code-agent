// ============================================================================
// Memory Notification Service - Phase 3 学习通知
// 当 AI 学到新记忆时通知前端
// ============================================================================

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { MemoryLearnedEvent, MemoryConfirmRequest } from '../../shared/types/memory';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MemoryNotification');

// 低置信度阈值 - 低于此值需要用户确认
const LOW_CONFIDENCE_THRESHOLD = 0.8;

// 待确认的记忆请求
const pendingConfirmations = new Map<string, {
  content: string;
  category: string;
  type: string;
  confidence: number;
  resolve: (confirmed: boolean) => void;
}>();

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 获取主窗口
 */
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

/**
 * 发送学习通知到前端
 * @param content 学习的内容
 * @param category 分类
 * @param type 学习类型
 * @param confidence 置信度
 */
export function notifyMemoryLearned(
  content: string,
  category: string,
  type: string,
  confidence: number = 1.0
): void {
  const mainWindow = getMainWindow();
  if (!mainWindow) {
    logger.debug('No main window, skip notification');
    return;
  }

  const needsConfirmation = confidence < LOW_CONFIDENCE_THRESHOLD;

  const event: MemoryLearnedEvent = {
    id: generateId(),
    content,
    category,
    type,
    confidence,
    needsConfirmation,
    timestamp: Date.now(),
  };

  mainWindow.webContents.send(IPC_CHANNELS.MEMORY_LEARNED, event);
  logger.info('Memory learned notification sent', { type, category, confidence });
}

/**
 * 请求用户确认低置信度记忆
 * 返回 Promise，在用户确认或拒绝后 resolve
 * @param content 内容
 * @param category 分类
 * @param type 类型
 * @param confidence 置信度
 * @returns 用户是否确认
 */
export function requestMemoryConfirmation(
  content: string,
  category: string,
  type: string,
  confidence: number
): Promise<boolean> {
  const mainWindow = getMainWindow();
  if (!mainWindow) {
    logger.debug('No main window, auto-approve');
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const id = generateId();

    // 存储待确认请求
    pendingConfirmations.set(id, {
      content,
      category,
      type,
      confidence,
      resolve,
    });

    const request: MemoryConfirmRequest = {
      id,
      content,
      category,
      type,
      confidence,
      timestamp: Date.now(),
    };

    mainWindow.webContents.send(IPC_CHANNELS.MEMORY_CONFIRM_REQUEST, request);
    logger.info('Memory confirmation requested', { id, type, category });

    // 设置超时，30 秒后自动拒绝
    setTimeout(() => {
      if (pendingConfirmations.has(id)) {
        pendingConfirmations.delete(id);
        resolve(false);
        logger.warn('Memory confirmation timeout', { id });
      }
    }, 30000);
  });
}

/**
 * 处理用户确认响应
 * @param id 请求 ID
 * @param confirmed 是否确认
 */
export function handleMemoryConfirmResponse(id: string, confirmed: boolean): void {
  const pending = pendingConfirmations.get(id);
  if (!pending) {
    logger.warn('Unknown confirmation response', { id });
    return;
  }

  pendingConfirmations.delete(id);
  pending.resolve(confirmed);
  logger.info('Memory confirmation response', { id, confirmed });
}

/**
 * 检查是否需要用户确认
 */
export function needsUserConfirmation(confidence: number): boolean {
  return confidence < LOW_CONFIDENCE_THRESHOLD;
}

/**
 * 获取低置信度阈值
 */
export function getLowConfidenceThreshold(): number {
  return LOW_CONFIDENCE_THRESHOLD;
}
