// ============================================================================
// Code Agent - Main Process Entry
// ============================================================================

import { app, BrowserWindow, ipcMain } from 'electron';
import {
  initializeCoreServices,
  initializeBackgroundServices,
  getConfigServiceInstance,
  getAgentOrchestrator,
  getGenerationManagerInstance,
  getCurrentSessionId,
  setCurrentSessionId,
  getPlanningServiceInstance,
} from './app/bootstrap';
import { createWindow, getMainWindow } from './app/window';
import { setupAllIpcHandlers } from './ipc';

// ----------------------------------------------------------------------------
// App Lifecycle
// ----------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    const appVersion = app.getVersion();
    console.log(`[App] Code Agent v${appVersion} starting...`);

    // 1. Initialize core services
    await initializeCoreServices();
    console.log('[App] Core services initialized');

    // 2. Setup IPC handlers
    setupAllIpcHandlers(ipcMain, {
      getMainWindow,
      getOrchestrator: getAgentOrchestrator,
      getGenerationManager: getGenerationManagerInstance,
      getConfigService: getConfigServiceInstance,
      getPlanningService: getPlanningServiceInstance,
      getCurrentSessionId,
      setCurrentSessionId,
    });
    console.log('[App] IPC handlers set up');

    // 3. Create window
    await createWindow();
    console.log('[App] Window created');

    // 4. Initialize background services (non-blocking)
    initializeBackgroundServices().catch((error) => {
      console.error('[App] Background services initialization failed:', error);
    });
  } catch (error) {
    console.error('[App] FATAL ERROR during startup:', error);
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
  console.log('Cleaning up before quit...');

  try {
    const { getMemoryService } = await import('./memory/MemoryService');
    const memoryService = getMemoryService();
    await memoryService.cleanup();
    console.log('Memory service cleaned up');
  } catch (error) {
    console.error('Error cleaning up memory service:', error);
  }

  try {
    const { getMCPClient } = await import('./mcp/MCPClient');
    const mcpClient = getMCPClient();
    await mcpClient.disconnectAll();
    console.log('MCP clients disconnected');
  } catch (error) {
    console.error('Error disconnecting MCP clients:', error);
  }

  try {
    const { getDatabase } = await import('./services');
    const db = getDatabase();
    db.close();
    console.log('Database closed');
  } catch (error) {
    console.error('Error closing database:', error);
  }

  try {
    const { getLangfuseService } = await import('./services');
    const langfuseService = getLangfuseService();
    await langfuseService.cleanupAll();
    await langfuseService.shutdown();
    console.log('Langfuse cleaned up');
  } catch (error) {
    console.error('Error cleaning up Langfuse:', error);
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
