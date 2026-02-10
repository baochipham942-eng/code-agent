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
// Deep Link Protocol Handler
// ----------------------------------------------------------------------------

const PROTOCOL = 'code-agent';

// Register deep link protocol (must be before app.whenReady)
if (process.defaultApp) {
  // Development: need to pass the script path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]]);
  }
} else {
  // Production
  app.setAsDefaultProtocolClient(PROTOCOL);
}

/**
 * Handle deep link URL
 * Expected format: code-agent://auth/reset-callback#access_token=xxx&refresh_token=xxx
 */
function handleDeepLink(url: string): void {
  logger.info('Handling deep link:', url);

  try {
    const parsed = new URL(url);

    // Handle password reset callback
    if (parsed.host === 'auth' && parsed.pathname === '/reset-callback') {
      // Supabase puts tokens in the hash fragment
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');

      if (accessToken && refreshToken) {
        // Send to renderer to handle password reset UI
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send('auth:password-reset-callback', {
            accessToken,
            refreshToken,
          });
          // Focus the window
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      } else {
        logger.error('Missing tokens in password reset callback');
      }
    }
  } catch (error) {
    logger.error('Failed to parse deep link URL:', error);
  }
}

// macOS: Handle open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows/Linux: Handle second-instance event (single instance lock)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Someone tried to run a second instance, focus our window
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }

    // Handle deep link from argv (Windows/Linux)
    const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url) {
      handleDeepLink(url);
    }
  });
}

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

    // 5. Delayed start WeChat watcher (avoid slowing startup)
    setTimeout(async () => {
      try {
        const { getWeChatWatcher } = await import('./services/wechatWatcher');
        await getWeChatWatcher().start();
      } catch (error) {
        logger.warn('WeChat watcher failed to start', error);
      }
    }, 5000);
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

  // Stop WeChat watcher
  try {
    const { getWeChatWatcher } = await import('./services/wechatWatcher');
    await getWeChatWatcher().stop();
    logger.info('WeChat watcher stopped');
  } catch (error) {
    logger.error('Error stopping WeChat watcher', error);
  }

  // Shutdown Channel Manager (disconnect all channels)
  try {
    const { getChannelManager } = await import('./channels');
    const channelManager = getChannelManager();
    await channelManager.shutdown();
    logger.info('Channel manager shut down');
  } catch (error) {
    logger.error('Error shutting down Channel manager', error);
  }

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

// Handle SIGTERM/SIGINT for graceful shutdown (container/Linux environments)
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, initiating graceful shutdown...');
  app.quit();
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, initiating graceful shutdown...');
  app.quit();
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', reason instanceof Error ? reason : new Error(String(reason)), { promise: String(promise) });
});
