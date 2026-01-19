// ============================================================================
// Lifecycle - App 生命周期管理
// ============================================================================

import { app, BrowserWindow } from 'electron';
import { getDatabase, getLangfuseService } from '../services';
import { getMemoryService } from '../memory/memoryService';
import { getMCPClient } from '../mcp/mcpClient';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('Lifecycle');

/**
 * 清理资源，在退出前调用
 */
export async function cleanup(): Promise<void> {
  logger.info('Cleaning up before quit...');

  // Cleanup memory service (saves vector store, clears caches)
  try {
    const memoryService = getMemoryService();
    await memoryService.cleanup();
    logger.info('Memory service cleaned up');
  } catch (error) {
    logger.error('Error cleaning up memory service', error);
  }

  // Disconnect MCP clients
  try {
    const mcpClient = getMCPClient();
    await mcpClient.disconnectAll();
    logger.info('MCP clients disconnected');
  } catch (error) {
    logger.error('Error disconnecting MCP clients', error);
  }

  // Close database
  try {
    const db = getDatabase();
    db.close();
    logger.info('Database closed');
  } catch (error) {
    logger.error('Error closing database', error);
  }

  // Cleanup Langfuse (flush remaining events)
  try {
    const langfuseService = getLangfuseService();
    await langfuseService.cleanupAll();
    await langfuseService.shutdown();
    logger.info('Langfuse cleaned up');
  } catch (error) {
    logger.error('Error cleaning up Langfuse', error);
  }
}

/**
 * 设置应用生命周期事件处理
 */
export function setupLifecycleHandlers(
  onActivate: () => Promise<void>
): void {
  // Handle window-all-closed
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Handle activate (macOS dock click)
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await onActivate();
    }
  });

  // Cleanup before quitting
  app.on('before-quit', async () => {
    await cleanup();
  });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', reason instanceof Error ? reason : new Error(String(reason)), { promise: String(promise) });
  });
}
