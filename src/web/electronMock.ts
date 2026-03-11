// ============================================================================
// Electron Shim - 完整的 electron 模块 mock
// ============================================================================
//
// 当 esbuild 使用 --alias:electron=./src/web/electronMock.ts 构建时，
// 所有 `import { xxx } from 'electron'` 都会被解析到这个文件。
// 不再需要 Module._resolveFilename hack。
//
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerFn = (event: any, ...args: any[]) => any;

/** 所有通过 ipcMain.handle() 注册的 handler */
export const handlers = new Map<string, HandlerFn>();

/** 所有通过 ipcMain.on() 注册的 listener */
export const eventListeners = new Map<string, HandlerFn>();

// ── ipcMain ──────────────────────────────────────────────────────────

export const ipcMain = {
  handle(channel: string, handler: HandlerFn): void {
    handlers.set(channel, handler);
  },
  on(channel: string, handler: HandlerFn): void {
    eventListeners.set(channel, handler);
  },
  once(_channel: string, _handler: HandlerFn): void {
    // no-op in web mode
  },
  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
  removeAllListeners(channel?: string): void {
    if (channel) {
      eventListeners.delete(channel);
    } else {
      eventListeners.clear();
    }
  },
};

// ── Type exports (IpcMain, IpcMainInvokeEvent, etc.) ─────────────────

/** Type alias so `import type { IpcMain } from 'electron'` works */
export type IpcMain = typeof ipcMain;

/** Stub for Electron.IpcMainInvokeEvent — used as first arg in ipcMain.handle callbacks */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcMainInvokeEvent = any;

/** Stub for Electron.IpcMainEvent */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcMainEvent = any;

// ── Electron namespace (for `Electron.BrowserWindow`, `Electron.IpcMainInvokeEvent`, etc.) ──

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Electron {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type IpcMainInvokeEvent = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type IpcMainEvent = any;
  // Re-export BrowserWindow type under namespace
  export type BrowserWindow = InstanceType<typeof import('./electronMock').BrowserWindow>;
}

// ── ipcRenderer ──────────────────────────────────────────────────────

export const ipcRenderer = {
  invoke: async () => undefined,
  on: () => ipcRenderer,
  once: () => ipcRenderer,
  send: () => {},
  removeListener: () => ipcRenderer,
  removeAllListeners: () => ipcRenderer,
};

// ── app ──────────────────────────────────────────────────────────────

export const app = {
  getPath: (name: string) => {
    switch (name) {
      case 'userData': return process.env.CODE_AGENT_DATA_DIR || '/tmp/code-agent';
      case 'home': return process.env.HOME || '/tmp';
      case 'temp': return '/tmp';
      case 'appData': return process.env.HOME || '/tmp';
      case 'documents': return `${process.env.HOME || '/tmp'}/Documents`;
      case 'desktop': return `${process.env.HOME || '/tmp'}/Desktop`;
      case 'downloads': return `${process.env.HOME || '/tmp'}/Downloads`;
      case 'logs': return '/tmp/code-agent/logs';
      default: return '/tmp';
    }
  },
  getVersion: () => '0.0.0-web',
  getName: () => 'code-agent-web',
  isReady: () => true,
  isPackaged: false,
  commandLine: { appendSwitch: (..._args: any[]) => {} },
  on: (..._args: any[]) => app,
  once: (..._args: any[]) => app,
  off: (..._args: any[]) => app,
  removeListener: (..._args: any[]) => app,
  removeAllListeners: (..._args: any[]) => app,
  emit: (..._args: any[]) => false,
  quit: () => {},
  exit: () => {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId: (..._args: any[]) => {},
  setAsDefaultProtocolClient: (..._args: any[]) => false as boolean,
  setPath: (..._args: any[]) => {},
  getAppPath: () => process.cwd(),
  getLocale: () => 'en-US',
  whenReady: () => Promise.resolve(),
};

// ── SSE Bridge ──────────────────────────────────────────────────────
// BrowserWindow.webContents.send() → broadcastSSE()
// 延迟导入避免循环依赖，在首次调用时解析
let _broadcastSSE: (channel: string, args: unknown) => void = () => {};
function getBroadcastSSE(): (channel: string, args: unknown) => void {
  if (_broadcastSSE === getBroadcastSSE._noop) {
    try {
      const { broadcastSSE } = require('./webServer');
      _broadcastSSE = broadcastSSE;
    } catch {
      // webServer 未加载时静默丢弃
    }
  }
  return _broadcastSSE;
}
getBroadcastSSE._noop = _broadcastSSE; // 标记初始空函数

// ── BrowserWindow ────────────────────────────────────────────────────

export class BrowserWindow {
  id = 0;
  webContents = {
    send: (channel: string, ...args: unknown[]) => {
      // 将 Electron IPC 事件转发到 SSE 客户端
      getBroadcastSSE()(channel, args.length === 1 ? args[0] : args);
    },
    on: (..._args: any[]) => {},
    once: (..._args: any[]) => {},
    openDevTools: (..._args: any[]) => {},
    session: { clearCache: async () => {} },
    getURL: () => '',
    isDestroyed: () => false, // Web 模式下窗口始终"存在"
    setWindowOpenHandler: (..._args: any[]) => {},
  };

  constructor(_options?: Record<string, any>) {}

  loadURL(..._args: any[]) { return Promise.resolve(); }
  loadFile(..._args: any[]) { return Promise.resolve(); }
  show() {}
  hide() {}
  close() {}
  destroy() {}
  focus() {}
  blur() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  restore() {}
  isMinimized() { return false; }
  isMaximized() { return false; }
  isVisible() { return false; }
  isDestroyed() { return true; }
  setTitle(..._args: any[]) {}
  getTitle() { return ''; }
  setBounds(..._args: any[]) {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  setSize(..._args: any[]) {}
  getSize() { return [800, 600]; }
  on(..._args: any[]) { return this; }
  once(..._args: any[]) { return this; }
  removeListener(..._args: any[]) { return this; }

  static getAllWindows(): BrowserWindow[] { return []; }
  static getFocusedWindow(): BrowserWindow | null { return null; }
  static fromWebContents(..._args: any[]): BrowserWindow | null { return null; }
  static fromId(..._args: any[]): BrowserWindow | null { return null; }
}

// ── dialog ───────────────────────────────────────────────────────────

export const dialog = {
  showOpenDialog: async (..._args: any[]) => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async (..._args: any[]) => ({ canceled: true, filePath: undefined }),
  showMessageBox: async (..._args: any[]) => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (..._args: any[]) => {},
  showOpenDialogSync: (..._args: any[]) => undefined,
  showSaveDialogSync: (..._args: any[]) => undefined,
  showMessageBoxSync: (..._args: any[]) => 0,
};

// ── shell ────────────────────────────────────────────────────────────

export const shell = {
  openExternal: async (..._args: any[]) => {},
  openPath: async (..._args: any[]) => '',
  showItemInFolder: (..._args: any[]) => {},
  beep: () => {},
  moveItemToTrash: (..._args: any[]) => false,
  readShortcutLink: (..._args: any[]) => ({}),
  writeShortcutLink: (..._args: any[]) => false,
};

// ── clipboard ────────────────────────────────────────────────────────

export const clipboard = {
  readText: () => '',
  writeText: (..._args: any[]) => {},
  readHTML: () => '',
  writeHTML: (..._args: any[]) => {},
  readImage: () => nativeImage.createEmpty(),
  writeImage: (..._args: any[]) => {},
  readRTF: () => '',
  writeRTF: (..._args: any[]) => {},
  clear: () => {},
  availableFormats: () => [] as string[],
  has: (..._args: any[]) => false,
  read: (..._args: any[]) => '',
  readBookmark: () => ({ title: '', url: '' }),
  readFindText: () => '',
  writeFindText: (..._args: any[]) => {},
  writeBookmark: (..._args: any[]) => {},
};

// ── nativeTheme ──────────────────────────────────────────────────────

export const nativeTheme = {
  themeSource: 'system' as string,
  shouldUseDarkColors: false,
  on: (..._args: any[]) => nativeTheme,
  once: (..._args: any[]) => nativeTheme,
  off: (..._args: any[]) => nativeTheme,
  removeListener: (..._args: any[]) => nativeTheme,
  removeAllListeners: (..._args: any[]) => nativeTheme,
};

// ── screen ───────────────────────────────────────────────────────────

export const screen = {
  getPrimaryDisplay: () => ({
    workAreaSize: { width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  }),
  getAllDisplays: () => [],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on: (..._args: any[]) => screen,
};

// ── safeStorage ──────────────────────────────────────────────────────

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (plainText: string) => Buffer.from(plainText),
  decryptString: (encrypted: Buffer) => encrypted.toString(),
};

// ── nativeImage ──────────────────────────────────────────────────────

const emptyImage = {
  toPNG: () => Buffer.alloc(0),
  toJPEG: (_quality?: number) => Buffer.alloc(0),
  toBitmap: () => Buffer.alloc(0),
  toDataURL: () => '',
  getSize: () => ({ width: 0, height: 0 }),
  isEmpty: () => true,
  resize: (..._args: any[]) => emptyImage,
  crop: (..._args: any[]) => emptyImage,
  getBitmap: () => Buffer.alloc(0),
  getNativeHandle: () => Buffer.alloc(0),
  isTemplateImage: () => false,
  setTemplateImage: (..._args: any[]) => {},
  addRepresentation: (..._args: any[]) => {},
  getAspectRatio: () => 1,
  getScaleFactors: () => [1],
  toRGBA: () => ({ data: Buffer.alloc(0), width: 0, height: 0 }),
};

export const nativeImage = {
  createEmpty: () => ({ ...emptyImage }),
  createFromPath: (..._args: any[]) => ({ ...emptyImage }),
  createFromBuffer: (..._args: any[]) => ({ ...emptyImage }),
  createFromDataURL: (..._args: any[]) => ({ ...emptyImage }),
  createThumbnailFromPath: async (..._args: any[]) => ({ ...emptyImage }),
};

// ── desktopCapturer ──────────────────────────────────────────────────

export const desktopCapturer = {
  getSources: async (..._args: any[]) => [] as Array<{ id: string; name: string; thumbnail: ReturnType<typeof nativeImage.createEmpty> }>,
};

// ── globalShortcut ───────────────────────────────────────────────────

export const globalShortcut = {
  register: (..._args: any[]) => false,
  registerAll: (..._args: any[]) => {},
  unregister: (..._args: any[]) => {},
  unregisterAll: () => {},
  isRegistered: (..._args: any[]) => false,
};

// ── Menu / MenuItem / Tray ───────────────────────────────────────────

export class Menu {
  items: unknown[] = [];
  static setApplicationMenu(..._args: any[]) {}
  static getApplicationMenu() { return null; }
  static buildFromTemplate(..._args: any[]) { return new Menu(); }
  popup(..._args: any[]) {}
  closePopup() {}
  append(..._args: any[]) {}
  insert(..._args: any[]) {}
}

export class MenuItem {
  constructor(_options?: any) {}
}

export class Tray {
  constructor(_image?: any) {}
  setToolTip(..._args: any[]) {}
  setContextMenu(..._args: any[]) {}
  on(..._args: any[]) { return this; }
  destroy() {}
}

// ── Notification ─────────────────────────────────────────────────────

export class Notification {
  constructor(_options?: { title?: string; body?: string; icon?: any; [key: string]: any }) {}
  show() {}
  close() {}
  on(..._args: any[]) { return this; }
  static isSupported() { return false; }
}

// ── session ──────────────────────────────────────────────────────────

const mockSession = {
  clearCache: async () => {},
  clearStorageData: async () => {},
  setProxy: async (..._args: any[]) => {},
  resolveProxy: async (..._args: any[]) => 'DIRECT',
  on: (..._args: any[]) => mockSession,
  webRequest: {
    onBeforeRequest: (..._args: any[]) => {},
    onBeforeSendHeaders: (..._args: any[]) => {},
    onHeadersReceived: (..._args: any[]) => {},
    onCompleted: (..._args: any[]) => {},
  },
  protocol: {
    registerFileProtocol: (..._args: any[]) => false,
    registerStringProtocol: (..._args: any[]) => false,
    registerHttpProtocol: (..._args: any[]) => false,
    interceptFileProtocol: (..._args: any[]) => false,
  },
  cookies: {
    get: async (..._args: any[]) => [],
    set: async (..._args: any[]) => {},
    remove: async (..._args: any[]) => {},
  },
};

export const session = {
  defaultSession: mockSession,
  fromPartition: (..._args: any[]) => mockSession,
};

// ── net ──────────────────────────────────────────────────────────────

export const net = {
  request: (..._args: any[]) => ({
    on: (..._args2: any[]) => {},
    end: () => {},
    write: (..._args2: any[]) => {},
    abort: () => {},
  }),
  isOnline: () => true,
};

// ── autoUpdater ──────────────────────────────────────────────────────

export const autoUpdater = {
  checkForUpdates: () => {},
  checkForUpdatesAndNotify: async () => null,
  downloadUpdate: async () => {},
  quitAndInstall: (..._args: any[]) => {},
  on: (..._args: any[]) => autoUpdater,
  once: (..._args: any[]) => autoUpdater,
  removeListener: (..._args: any[]) => autoUpdater,
  setFeedURL: (..._args: any[]) => {},
  getFeedURL: () => '',
  currentVersion: { version: '0.0.0-web' },
};

// ── powerMonitor ─────────────────────────────────────────────────────

export const powerMonitor = {
  getSystemIdleState: (..._args: any[]) => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false,
  on: (..._args: any[]) => powerMonitor,
  once: (..._args: any[]) => powerMonitor,
  removeListener: (..._args: any[]) => powerMonitor,
};

// ── systemPreferences ────────────────────────────────────────────────

export const systemPreferences = {
  isDarkMode: () => false,
  getAccentColor: () => '0078d7',
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  getMediaAccessStatus: (..._args: any[]) => 'not-determined',
  askForMediaAccess: async (..._args: any[]) => false,
  on: (..._args: any[]) => systemPreferences,
};

// ── contentTracing ───────────────────────────────────────────────────

export const contentTracing = {
  startRecording: async (..._args: any[]) => {},
  stopRecording: async (..._args: any[]) => '',
  getCategories: async () => [],
  getTraceBufferUsage: async () => ({ value: 0, percentage: 0 }),
};

// ── protocol ─────────────────────────────────────────────────────────

export const protocol = {
  registerSchemesAsPrivileged: (..._args: any[]) => {},
  registerFileProtocol: (..._args: any[]) => false,
  registerStringProtocol: (..._args: any[]) => false,
  registerHttpProtocol: (..._args: any[]) => false,
  interceptFileProtocol: (..._args: any[]) => false,
};

// ── crashReporter ────────────────────────────────────────────────────

export const crashReporter = {
  start: (..._args: any[]) => {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  setUploadToServer: (..._args: any[]) => {},
};

// ── webContents ──────────────────────────────────────────────────────

export const webContents = {
  getAllWebContents: () => [],
  getFocusedWebContents: () => null,
  fromId: (..._args: any[]) => null,
};

// Preload API mocks
export const contextBridge = {
  exposeInMainWorld: (apiKey: string, api: Record<string, unknown>) => {
    (globalThis as Record<string, unknown>)[apiKey] = api;
  },
};

export const webUtils = {
  getPathForFile: async (file: File) => (file as unknown as { path?: string }).path ?? file.name,
};

// ── default export (full module) ──────────────────────────────────────
// electron-store 等模块使用 `import electron from 'electron'` 然后
// 解构 `{ app, ipcMain, shell } = electron`，所以 default export 必须
// 包含所有命名导出，而非仅导出 app。

const electronModule = {
  app,
  ipcMain,
  ipcRenderer,
  BrowserWindow,
  dialog,
  shell,
  clipboard,
  nativeTheme,
  screen,
  safeStorage,
  nativeImage,
  desktopCapturer,
  globalShortcut,
  Menu,
  MenuItem,
  Tray,
  Notification,
  session,
  net,
  autoUpdater,
  powerMonitor,
  systemPreferences,
  contentTracing,
  protocol,
  crashReporter,
  webContents,
  contextBridge,
  webUtils,
};

export default electronModule;
