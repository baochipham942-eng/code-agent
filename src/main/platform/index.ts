// ============================================================================
// Platform Module - 统一导出，替代所有 'electron' 导入
// ============================================================================
//
// 用法：
//   import { app, BrowserWindow, shell } from '../platform';
//   import type { IpcMain } from '../platform';
//
// ============================================================================

// App paths & lifecycle
export { app, getPath, getUserDataPath, getHomePath, getTempPath, getAppDataPath,
  getDocumentsPath, getDesktopPath, getDownloadsPath, getLogsPath,
  getAppVersion, getAppName, isPackaged, getAppPath, getLocale } from './appPaths';

// IPC types
export type { IpcMain, IpcMainInvokeEvent, IpcMainEvent, HandlerFn } from './ipcTypes';
export { type Electron } from './ipcTypes';

// IPC runtime (handler registry)
export { ipcMain, handlers, eventListeners } from './ipcRegistry';

// Window bridge
export { BrowserWindow, broadcastToRenderer, onRendererPush } from './windowBridge';
export type { WindowLike, WebContentsSender } from './windowBridge';

// Shell
export { shell, openExternal, openPath, showItemInFolder } from './nativeShell';

// Clipboard
export { clipboard, nativeImage, readText as clipboardReadText, writeText as clipboardWriteText } from './nativeClipboard';

// Notifications
export { Notification } from './notifications';

// Global shortcuts
export { globalShortcut } from './globalShortcuts';

// Misc compat (dialog, safeStorage, screen, etc.)
export { dialog, safeStorage, screen, desktopCapturer, nativeTheme,
  Menu, MenuItem, Tray, session, net, autoUpdater, powerMonitor,
  systemPreferences, contentTracing, protocol, crashReporter,
  webContents, contextBridge, webUtils, ipcRenderer } from './miscCompat';
