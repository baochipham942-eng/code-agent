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
  console.log('[Main] preload path:', path.join(__dirname, '../../preload/index.cjs'));
  console.log('[Main] renderer path:', path.join(__dirname, '../../renderer/index.html'));

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
      preload: path.join(__dirname, '../../preload/index.cjs'),
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
  if (process.env.NODE_ENV === 'development') {
    console.log('[Main] Loading development URL...');
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    console.log('[Main] Loading production file...');
    const htmlPath = path.join(__dirname, '../../renderer/index.html');
    console.log('[Main] HTML path:', htmlPath);
    await mainWindow.loadFile(htmlPath);
  }

  console.log('[Main] Window created successfully');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}
