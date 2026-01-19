// ============================================================================
// Window Management - 窗口创建和管理
// ============================================================================

import { BrowserWindow } from 'electron';
import path from 'path';

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
  console.log('[Main] Creating window...');
  console.log('[Main] __dirname:', __dirname);
  // 路径说明：
  // - __dirname 在打包后是 app.asar/dist/main
  // - preload 在 app.asar/dist/preload/index.cjs (相对路径: ../preload/index.cjs)
  // - renderer 在 app.asar/dist/renderer/index.html (相对路径: ../renderer/index.html)
  const preloadPath = path.join(__dirname, '../preload/index.cjs');
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  console.log('[Main] preload path:', preloadPath);
  console.log('[Main] renderer path:', rendererPath);

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
    console.log('[Main] Window ready to show');
    mainWindow?.show();
  });

  // Log web contents events
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Main] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page finished loading');
  });

  // Load the app
  // Check for development mode: NODE_ENV or ELECTRON_IS_DEV or running from source
  const isDev = process.env.NODE_ENV === 'development' ||
    process.env.ELECTRON_IS_DEV === '1' ||
    !require('electron').app.isPackaged;

  if (isDev) {
    console.log('[Main] Loading development URL...');
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    console.log('[Main] Loading production file...');
    console.log('[Main] HTML path:', rendererPath);
    await mainWindow.loadFile(rendererPath);
  }

  console.log('[Main] Window created successfully');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}
