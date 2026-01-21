// ============================================================================
// Code Agent - Main Process Entry
// ============================================================================

import { app, BrowserWindow, ipcMain } from 'electron';
import { createLogger } from './services/infra/logger';

const logger = createLogger('Main');
import {
  initializeCoreServices,
  initializeBackgroundServices,
  getConfigServiceInstance,
  getAgentOrchestrator,
  getGenerationManagerInstance,
  getCurrentSessionId,
  setCurrentSessionId,
  getPlanningServiceInstance,
  getTaskManagerInstance,
} from './app/bootstrap';
import { createWindow, getMainWindow } from './app/window';
import { setupAllIpcHandlers } from './ipc';

// ----------------------------------------------------------------------------
// App Lifecycle
// ----------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    const appVersion = app.getVersion();
    logger.info(`Code Agent v${appVersion} starting...`);

    // 1. Initialize core services
    await initializeCoreServices();
    logger.info('Core services initialized');

    // 2. Setup IPC handlers
    setupAllIpcHandlers(ipcMain, {
      getMainWindow,
      getOrchestrator: getAgentOrchestrator,
      getGenerationManager: getGenerationManagerInstance,
      getConfigService: getConfigServiceInstance,
      getPlanningService: getPlanningServiceInstance,
      getTaskManager: getTaskManagerInstance,
      getCurrentSessionId,
      setCurrentSessionId,
    });
    logger.info('IPC handlers set up');

    // 3. Create window
    await createWindow();
    logger.info('Window created');

    // 4. Initialize background services (non-blocking)
    initializeBackgroundServices().catch((error) => {
      logger.error('Background services initialization failed', error);
    });
  } catch (error) {
    logger.error('FATAL ERROR during startup', error);
    app.quit();
    return;
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup before quitting
app.on('before-quit', async () => {
  logger.info('Cleaning up before quit...');

  // Shutdown TaskManager first (cancel all running tasks)
  try {
    const { getTaskManager } = await import('./task');
    const taskManager = getTaskManager();
    await taskManager.shutdown();
    logger.info('TaskManager shut down');
  } catch (error) {
    logger.error('Error shutting down TaskManager', error);
  }

  try {
    const { getMemoryService } = await import('./memory/memoryService');
    const memoryService = getMemoryService();
    await memoryService.cleanup();
    logger.info('Memory service cleaned up');
  } catch (error) {
    logger.error('Error cleaning up memory service', error);
  }

  try {
    const { getMCPClient } = await import('./mcp/mcpClient');
    const mcpClient = getMCPClient();
    await mcpClient.disconnectAll();
    logger.info('MCP clients disconnected');
  } catch (error) {
    logger.error('Error disconnecting MCP clients', error);
  }

  try {
    const { getDatabase } = await import('./services');
    const db = getDatabase();
    db.close();
    logger.info('Database closed');
  } catch (error) {
    logger.error('Error closing database', error);
  }

  try {
    const { getLangfuseService } = await import('./services');
    const langfuseService = getLangfuseService();
    await langfuseService.cleanupAll();
    await langfuseService.shutdown();
    logger.info('Langfuse cleaned up');
  } catch (error) {
    logger.error('Error cleaning up Langfuse', error);
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', reason instanceof Error ? reason : new Error(String(reason)), { promise: String(promise) });
});
