// ============================================================================
// Electron Mock - 为 CLI 模式提供 Electron API 的 mock 实现
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * 获取 CLI 数据目录
 */
function getCLIDataDir(): string {
  const dataDir = process.env.CODE_AGENT_DATA_DIR || path.join(os.homedir(), '.code-agent');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * Mock app 对象
 */
export const app = {
  getPath: (name: string): string => {
    switch (name) {
      case 'userData':
        return getCLIDataDir();
      case 'appData':
        return path.join(os.homedir(), '.config');
      case 'temp':
        return os.tmpdir();
      case 'home':
        return os.homedir();
      case 'desktop':
        return path.join(os.homedir(), 'Desktop');
      case 'documents':
        return path.join(os.homedir(), 'Documents');
      case 'downloads':
        return path.join(os.homedir(), 'Downloads');
      default:
        return getCLIDataDir();
    }
  },
  getAppPath: () => process.cwd(),
  isPackaged: false,
  getVersion: () => process.env.npm_package_version || '0.0.0-cli',
  getName: () => 'code-agent-cli',
  on: () => app,
  once: () => app,
  off: () => app,
  removeListener: () => app,
  removeAllListeners: () => app,
  emit: () => false,
  quit: () => process.exit(0),
  exit: (code?: number) => process.exit(code),
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  setAsDefaultProtocolClient: () => true,
  dock: {
    bounce: () => 0,
    cancelBounce: () => {},
    downloadFinished: () => {},
    setBadge: () => {},
    getBadge: () => '',
    hide: () => {},
    show: () => Promise.resolve(),
    isVisible: () => false,
    setMenu: () => {},
    setIcon: () => {},
  },
};

/**
 * Mock BrowserWindow 类
 */
export class BrowserWindow {
  webContents = {
    send: () => {},
    on: () => {},
    once: () => {},
    executeJavaScript: () => Promise.resolve(),
    openDevTools: () => {},
    closeDevTools: () => {},
  };

  constructor() {}

  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  show() {}
  hide() {}
  close() {}
  destroy() {}
  focus() {}
  blur() {}
  isMinimized() { return false; }
  isMaximized() { return false; }
  isFullScreen() { return false; }
  isVisible() { return false; }
  restore() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  setFullScreen() {}
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  on() { return this; }
  once() { return this; }

  static getAllWindows() { return []; }
  static getFocusedWindow() { return null; }
}

/**
 * Mock ipcMain
 */
export const ipcMain = {
  on: () => ipcMain,
  once: () => ipcMain,
  handle: () => {},
  handleOnce: () => {},
  removeHandler: () => {},
  removeListener: () => ipcMain,
  removeAllListeners: () => ipcMain,
};

/**
 * Mock ipcRenderer
 */
export const ipcRenderer = {
  on: () => ipcRenderer,
  once: () => ipcRenderer,
  send: () => {},
  sendSync: () => {},
  invoke: () => Promise.resolve(),
  removeListener: () => ipcRenderer,
  removeAllListeners: () => ipcRenderer,
};

/**
 * Mock shell
 */
export const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: () => {},
  beep: () => {},
  trashItem: () => Promise.resolve(),
};

/**
 * Mock dialog
 */
export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
  showMessageBox: () => Promise.resolve({ response: 0, checkboxChecked: false }),
  showErrorBox: () => {},
};

/**
 * Mock nativeTheme
 */
export const nativeTheme = {
  themeSource: 'system' as 'system' | 'light' | 'dark',
  shouldUseDarkColors: true,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  on: () => nativeTheme,
  once: () => nativeTheme,
  removeListener: () => nativeTheme,
};

/**
 * Mock clipboard
 */
export const clipboard = {
  readText: () => '',
  writeText: () => {},
  readHTML: () => '',
  writeHTML: () => {},
  readImage: () => ({ isEmpty: () => true, toDataURL: () => '' }),
  writeImage: () => {},
  clear: () => {},
  availableFormats: () => [],
  has: () => false,
  read: () => '',
  write: () => {},
  readBookmark: () => ({ title: '', url: '' }),
  writeBookmark: () => {},
  readFindText: () => '',
  writeFindText: () => {},
};

/**
 * Mock Notification 类
 */
export class Notification {
  constructor() {}
  show() {}
  close() {}
  on() { return this; }
  once() { return this; }

  static isSupported() { return false; }
}

/**
 * Mock screen
 */
export const screen = {
  getPrimaryDisplay: () => ({
    workAreaSize: { width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    rotation: 0,
  }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on: () => screen,
  once: () => screen,
  removeListener: () => screen,
};

/**
 * Mock Menu
 */
export class Menu {
  constructor() {}
  popup() {}
  closePopup() {}
  append() {}
  insert() {}

  static setApplicationMenu() {}
  static getApplicationMenu() { return null; }
  static buildFromTemplate() { return new Menu(); }
}

/**
 * Mock MenuItem
 */
export class MenuItem {
  constructor() {}
}

/**
 * Mock Tray
 */
export class Tray {
  constructor() {}
  setImage() {}
  setToolTip() {}
  setContextMenu() {}
  on() { return this; }
  destroy() {}
}

/**
 * Mock systemPreferences
 */
export const systemPreferences = {
  isDarkMode: () => true,
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  getAccentColor: () => '#0078d4',
  getColor: () => '#000000',
  isAeroGlassEnabled: () => false,
  getAnimationSettings: () => ({ shouldRenderRichAnimation: true }),
};

/**
 * Mock globalShortcut
 */
export const globalShortcut = {
  register: () => false,
  registerAll: () => {},
  unregister: () => {},
  unregisterAll: () => {},
  isRegistered: () => false,
};

/**
 * Mock powerMonitor
 */
export const powerMonitor = {
  on: () => powerMonitor,
  once: () => powerMonitor,
  removeListener: () => powerMonitor,
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
};

/**
 * Mock session
 */
export const session = {
  defaultSession: {
    clearCache: () => Promise.resolve(),
    clearStorageData: () => Promise.resolve(),
    cookies: {
      get: () => Promise.resolve([]),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
};

/**
 * 默认导出所有 mock
 */
export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  shell,
  dialog,
  nativeTheme,
  clipboard,
  Notification,
  screen,
  Menu,
  MenuItem,
  Tray,
  systemPreferences,
  globalShortcut,
  powerMonitor,
  session,
};
