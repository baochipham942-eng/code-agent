// ============================================================================
// Lifecycle - App 生命周期管理
// ============================================================================

import { app, BrowserWindow } from '../platform';
import { getDatabase, getLangfuseService } from '../services';
import { getMCPClient } from '../mcp/mcpClient';
import { cleanupSessionStateManager } from '../session/sessionStateManager';
import { disposeAgentRegistry } from '../agent/agentRegistry';
import { createLogger } from '../services/infra/logger';
import { captureException } from '../observability/sentryNode';

const logger = createLogger('Lifecycle');

/**
 * 清理资源，在退出前调用
 */
export async function cleanup(): Promise<void> {
  logger.info('Cleaning up before quit...');

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

  // Cleanup session state manager timer
  try {
    cleanupSessionStateManager();
    logger.info('Session state manager cleaned up');
  } catch (error) {
    logger.error('Error cleaning up session state manager', error);
  }

  // Dispose agent registry watcher
  try {
    await disposeAgentRegistry();
    logger.info('Agent registry disposed');
  } catch (error) {
    logger.error('Error disposing agent registry', error);
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
    captureException(error, { tags: { surface: 'node', source: 'uncaughtException' } });
  });

  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled Rejection', err, { promise: String(promise) });
    captureException(err, { tags: { surface: 'node', source: 'unhandledRejection' } });
  });
}
