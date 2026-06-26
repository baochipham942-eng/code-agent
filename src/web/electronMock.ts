// ============================================================================
// Electron Shim - 完整的 electron 模块 mock
// ============================================================================
//
// 当 esbuild 使用 --alias:electron=./src/web/electronMock.ts 构建时，
// 所有 `import { xxx } from 'electron'` 都会被解析到这个文件。
// 不再需要 Module._resolveFilename hack。
//
// ============================================================================

export type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

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
export type IpcMainInvokeEvent = unknown;

/** Stub for Electron.IpcMainEvent */
export type IpcMainEvent = unknown;

// ── Electron namespace (for `Electron.BrowserWindow`, `Electron.IpcMainInvokeEvent`, etc.) ──

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Electron {
  export type IpcMainInvokeEvent = unknown;
  export type IpcMainEvent = unknown;
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
  commandLine: { appendSwitch: (..._args: unknown[]) => {} },
  on: (..._args: unknown[]) => app,
  once: (..._args: unknown[]) => app,
  off: (..._args: unknown[]) => app,
  removeListener: (..._args: unknown[]) => app,
  removeAllListeners: (..._args: unknown[]) => app,
  emit: (..._args: unknown[]) => false,
  quit: () => {},
  exit: () => {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId: (..._args: unknown[]) => {},
  setAsDefaultProtocolClient: (..._args: unknown[]) => false as boolean,
  setPath: (..._args: unknown[]) => {},
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
    on: (..._args: unknown[]) => {},
    once: (..._args: unknown[]) => {},
    openDevTools: (..._args: unknown[]) => {},
    session: { clearCache: async () => {} },
    getURL: () => '',
    isDestroyed: () => false, // Web 模式下窗口始终"存在"
    setWindowOpenHandler: (..._args: unknown[]) => {},
  };

  constructor(_options?: Record<string, unknown>) {}

  loadURL(..._args: unknown[]) { return Promise.resolve(); }
  loadFile(..._args: unknown[]) { return Promise.resolve(); }
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
  setTitle(..._args: unknown[]) {}
  getTitle() { return ''; }
  setBounds(..._args: unknown[]) {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  setSize(..._args: unknown[]) {}
  getSize() { return [800, 600]; }
  on(..._args: unknown[]) { return this; }
  once(..._args: unknown[]) { return this; }
  removeListener(..._args: unknown[]) { return this; }

  static getAllWindows(): BrowserWindow[] { return []; }
  static getFocusedWindow(): BrowserWindow | null { return null; }
  static fromWebContents(..._args: unknown[]): BrowserWindow | null { return null; }
  static fromId(..._args: unknown[]): BrowserWindow | null { return null; }
}

// ── dialog ───────────────────────────────────────────────────────────

export const dialog = {
  showOpenDialog: async (..._args: unknown[]) => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async (..._args: unknown[]) => ({ canceled: true, filePath: undefined }),
  showMessageBox: async (..._args: unknown[]) => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (..._args: unknown[]) => {},
  showOpenDialogSync: (..._args: unknown[]) => undefined,
  showSaveDialogSync: (..._args: unknown[]) => undefined,
  showMessageBoxSync: (..._args: unknown[]) => 0,
};

// ── shell ────────────────────────────────────────────────────────────
// 复用 main/platform/nativeShell 的安全实现（execFile + URL/path 校验）
import { shell as _shell } from '../host/platform/nativeShell';
export const shell = _shell;

// ── clipboard ────────────────────────────────────────────────────────

export const clipboard = {
  readText: () => '',
  writeText: (..._args: unknown[]) => {},
  readHTML: () => '',
  writeHTML: (..._args: unknown[]) => {},
  readImage: () => nativeImage.createEmpty(),
  writeImage: (..._args: unknown[]) => {},
  readRTF: () => '',
  writeRTF: (..._args: unknown[]) => {},
  clear: () => {},
  availableFormats: () => [] as string[],
  has: (..._args: unknown[]) => false,
  read: (..._args: unknown[]) => '',
  readBookmark: () => ({ title: '', url: '' }),
  readFindText: () => '',
  writeFindText: (..._args: unknown[]) => {},
  writeBookmark: (..._args: unknown[]) => {},
};

// ── nativeTheme ──────────────────────────────────────────────────────

export const nativeTheme = {
  themeSource: 'system' as string,
  shouldUseDarkColors: false,
  on: (..._args: unknown[]) => nativeTheme,
  once: (..._args: unknown[]) => nativeTheme,
  off: (..._args: unknown[]) => nativeTheme,
  removeListener: (..._args: unknown[]) => nativeTheme,
  removeAllListeners: (..._args: unknown[]) => nativeTheme,
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
  on: (..._args: unknown[]) => screen,
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
  resize: (..._args: unknown[]) => emptyImage,
  crop: (..._args: unknown[]) => emptyImage,
  getBitmap: () => Buffer.alloc(0),
  getNativeHandle: () => Buffer.alloc(0),
  isTemplateImage: () => false,
  setTemplateImage: (..._args: unknown[]) => {},
  addRepresentation: (..._args: unknown[]) => {},
  getAspectRatio: () => 1,
  getScaleFactors: () => [1],
  toRGBA: () => ({ data: Buffer.alloc(0), width: 0, height: 0 }),
};

export const nativeImage = {
  createEmpty: () => ({ ...emptyImage }),
  createFromPath: (..._args: unknown[]) => ({ ...emptyImage }),
  createFromBuffer: (..._args: unknown[]) => ({ ...emptyImage }),
  createFromDataURL: (..._args: unknown[]) => ({ ...emptyImage }),
  createThumbnailFromPath: async (..._args: unknown[]) => ({ ...emptyImage }),
};

// ── desktopCapturer ──────────────────────────────────────────────────

export const desktopCapturer = {
  getSources: async (..._args: unknown[]) => [] as Array<{ id: string; name: string; thumbnail: ReturnType<typeof nativeImage.createEmpty> }>,
};

// ── globalShortcut ───────────────────────────────────────────────────

export const globalShortcut = {
  register: (..._args: unknown[]) => false,
  registerAll: (..._args: unknown[]) => {},
  unregister: (..._args: unknown[]) => {},
  unregisterAll: () => {},
  isRegistered: (..._args: unknown[]) => false,
};

// ── Menu / MenuItem / Tray ───────────────────────────────────────────

export class Menu {
  items: unknown[] = [];
  static setApplicationMenu(..._args: unknown[]) {}
  static getApplicationMenu() { return null; }
  static buildFromTemplate(..._args: unknown[]) { return new Menu(); }
  popup(..._args: unknown[]) {}
  closePopup() {}
  append(..._args: unknown[]) {}
  insert(..._args: unknown[]) {}
}

export class MenuItem {
  constructor(_options?: unknown) {}
}

export class Tray {
  constructor(_image?: unknown) {}
  setToolTip(..._args: unknown[]) {}
  setContextMenu(..._args: unknown[]) {}
  on(..._args: unknown[]) { return this; }
  destroy() {}
}

// ── Notification ─────────────────────────────────────────────────────

export class Notification {
  constructor(_options?: { title?: string; body?: string; icon?: unknown; [key: string]: unknown }) {}
  show() {}
  close() {}
  on(..._args: unknown[]) { return this; }
  static isSupported() { return false; }
}

// ── session ──────────────────────────────────────────────────────────

const mockSession = {
  clearCache: async () => {},
  clearStorageData: async () => {},
  setProxy: async (..._args: unknown[]) => {},
  resolveProxy: async (..._args: unknown[]) => 'DIRECT',
  on: (..._args: unknown[]) => mockSession,
  webRequest: {
    onBeforeRequest: (..._args: unknown[]) => {},
    onBeforeSendHeaders: (..._args: unknown[]) => {},
    onHeadersReceived: (..._args: unknown[]) => {},
    onCompleted: (..._args: unknown[]) => {},
  },
  protocol: {
    registerFileProtocol: (..._args: unknown[]) => false,
    registerStringProtocol: (..._args: unknown[]) => false,
    registerHttpProtocol: (..._args: unknown[]) => false,
    interceptFileProtocol: (..._args: unknown[]) => false,
  },
  cookies: {
    get: async (..._args: unknown[]) => [],
    set: async (..._args: unknown[]) => {},
    remove: async (..._args: unknown[]) => {},
  },
};

export const session = {
  defaultSession: mockSession,
  fromPartition: (..._args: unknown[]) => mockSession,
};

// ── net ──────────────────────────────────────────────────────────────

export const net = {
  request: (..._args: unknown[]) => ({
    on: (..._args2: unknown[]) => {},
    end: () => {},
    write: (..._args2: unknown[]) => {},
    abort: () => {},
  }),
  isOnline: () => true,
};

// ── autoUpdater ──────────────────────────────────────────────────────

export const autoUpdater = {
  checkForUpdates: () => {},
  checkForUpdatesAndNotify: async () => null,
  downloadUpdate: async () => {},
  quitAndInstall: (..._args: unknown[]) => {},
  on: (..._args: unknown[]) => autoUpdater,
  once: (..._args: unknown[]) => autoUpdater,
  removeListener: (..._args: unknown[]) => autoUpdater,
  setFeedURL: (..._args: unknown[]) => {},
  getFeedURL: () => '',
  currentVersion: { version: '0.0.0-web' },
};

// ── powerMonitor ─────────────────────────────────────────────────────

export const powerMonitor = {
  getSystemIdleState: (..._args: unknown[]) => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false,
  on: (..._args: unknown[]) => powerMonitor,
  once: (..._args: unknown[]) => powerMonitor,
  removeListener: (..._args: unknown[]) => powerMonitor,
};

// ── systemPreferences ────────────────────────────────────────────────

export const systemPreferences = {
  isDarkMode: () => false,
  getAccentColor: () => '0078d7',
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  getMediaAccessStatus: (..._args: unknown[]) => 'not-determined',
  askForMediaAccess: async (..._args: unknown[]) => false,
  on: (..._args: unknown[]) => systemPreferences,
};

// ── contentTracing ───────────────────────────────────────────────────

export const contentTracing = {
  startRecording: async (..._args: unknown[]) => {},
  stopRecording: async (..._args: unknown[]) => '',
  getCategories: async () => [],
  getTraceBufferUsage: async () => ({ value: 0, percentage: 0 }),
};

// ── protocol ─────────────────────────────────────────────────────────

export const protocol = {
  registerSchemesAsPrivileged: (..._args: unknown[]) => {},
  registerFileProtocol: (..._args: unknown[]) => false,
  registerStringProtocol: (..._args: unknown[]) => false,
  registerHttpProtocol: (..._args: unknown[]) => false,
  interceptFileProtocol: (..._args: unknown[]) => false,
};

// ── crashReporter ────────────────────────────────────────────────────

export const crashReporter = {
  start: (..._args: unknown[]) => {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  setUploadToServer: (..._args: unknown[]) => {},
};

// ── webContents ──────────────────────────────────────────────────────

export const webContents = {
  getAllWebContents: () => [],
  getFocusedWebContents: () => null,
  fromId: (..._args: unknown[]) => null,
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
