// ============================================================================
// Window Management - 窗口创建和管理
// ============================================================================

import { BrowserWindow, shell } from 'electron';
import path from 'path';
import { createLogger } from '../services/infra/logger';
import { initContextHealthService } from '../context/contextHealthService';
import { initSessionStateManager } from '../session/sessionStateManager';

const logger = createLogger('Window');

let mainWindow: BrowserWindow | null = null;

/**
 * 获取主窗口实例
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * 设置主窗口实例（内部使用）
 */
export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

/**
 * 创建主窗口
 */
export async function createWindow(): Promise<void> {
  logger.info('Creating window...');
  logger.debug('__dirname', { __dirname });
  // 路径说明：
  // - __dirname 在打包后是 app.asar/dist/main
  // - preload 在 app.asar/dist/preload/index.cjs (相对路径: ../preload/index.cjs)
  // - renderer 在 app.asar/dist/renderer/index.html (相对路径: ../renderer/index.html)
  const preloadPath = path.join(__dirname, '../preload/index.cjs');
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  logger.debug('Paths', { preloadPath, rendererPath });

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#18181b',
    show: false, // Don't show until ready
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Show window when ready to prevent flicker
  mainWindow.once('ready-to-show', () => {
    logger.info('Window ready to show');
    mainWindow?.show();
  });

  // Log web contents events
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logger.error('Failed to load', new Error(errorDescription), { errorCode });
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('Page finished loading');
  });

  // Handle external links - open in default browser instead of new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Check if it's an external URL (http/https)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      logger.info('Opening external URL in browser', { url: url.substring(0, 100) });
      shell.openExternal(url);
      return { action: 'deny' }; // Prevent Electron from opening a new window
    }
    return { action: 'allow' };
  });

  // Load the app
  // Check for development mode: NODE_ENV or ELECTRON_IS_DEV or running from source
  const isDev = process.env.NODE_ENV === 'development' ||
    process.env.ELECTRON_IS_DEV === '1' ||
    !require('electron').app.isPackaged;

  if (isDev) {
    logger.info('Loading development URL...');
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    logger.info('Loading production file...', { rendererPath });
    await mainWindow.loadFile(rendererPath);
  }

  logger.info('Window created successfully');

  // Initialize context health service with main window for IPC events
  initContextHealthService(mainWindow);
  logger.info('Context health service initialized');

  // Initialize session state manager for multi-session parallel support
  initSessionStateManager(mainWindow);
  logger.info('Session state manager initialized');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}
