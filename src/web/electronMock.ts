// ============================================================================
// Electron Shim - 完整的 electron 模块 mock
// ============================================================================
//
// 当 esbuild 使用 --alias:electron=./src/web/electronMock.ts 构建时，
// 所有 `import { xxx } from 'electron'` 都会被解析到这个文件。
// 不再需要 Module._resolveFilename hack。
//
// ============================================================================

export type HandlerFn = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

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
  commandLine: { appendSwitch: () => {} },
  on: () => app,
  once: () => app,
  off: () => app,
  removeListener: () => app,
  removeAllListeners: () => app,
  emit: () => false,
  quit: () => {},
  exit: () => {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId: () => {},
  setPath: () => {},
  getAppPath: () => process.cwd(),
  getLocale: () => 'en-US',
  whenReady: () => Promise.resolve(),
};

// ── BrowserWindow ────────────────────────────────────────────────────

export class BrowserWindow {
  id = 0;
  webContents = {
    send: (_channel: string, ..._args: unknown[]) => {},
    on: () => {},
    once: () => {},
    openDevTools: () => {},
    session: { clearCache: async () => {} },
    getURL: () => '',
    isDestroyed: () => true,
  };

  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  show() {}
  hide() {}
  close() {}
  destroy() {}
  focus() {}
  blur() {}
  minimize() {}
  maximize() {}
  restore() {}
  isMinimized() { return false; }
  isMaximized() { return false; }
  isVisible() { return false; }
  isDestroyed() { return true; }
  setTitle() {}
  getTitle() { return ''; }
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  setSize() {}
  getSize() { return [800, 600]; }
  on() { return this; }
  once() { return this; }
  removeListener() { return this; }

  static getAllWindows() { return []; }
  static getFocusedWindow() { return null; }
  static fromWebContents() { return null; }
  static fromId() { return null; }
}

// ── dialog ───────────────────────────────────────────────────────────

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: () => {},
  showOpenDialogSync: () => undefined,
  showSaveDialogSync: () => undefined,
  showMessageBoxSync: () => 0,
};

// ── shell ────────────────────────────────────────────────────────────

export const shell = {
  openExternal: async () => {},
  openPath: async () => '',
  showItemInFolder: () => {},
  beep: () => {},
  moveItemToTrash: () => false,
  readShortcutLink: () => ({}),
  writeShortcutLink: () => false,
};

// ── clipboard ────────────────────────────────────────────────────────

export const clipboard = {
  readText: () => '',
  writeText: () => {},
  readHTML: () => '',
  writeHTML: () => {},
  readImage: () => nativeImage.createEmpty(),
  writeImage: () => {},
  readRTF: () => '',
  writeRTF: () => {},
  clear: () => {},
  availableFormats: () => [] as string[],
  has: () => false,
  read: () => '',
  readBookmark: () => ({ title: '', url: '' }),
  readFindText: () => '',
  writeFindText: () => {},
  writeBookmark: () => {},
};

// ── nativeTheme ──────────────────────────────────────────────────────

export const nativeTheme = {
  themeSource: 'system' as string,
  shouldUseDarkColors: false,
  on: () => nativeTheme,
  once: () => nativeTheme,
  off: () => nativeTheme,
  removeListener: () => nativeTheme,
  removeAllListeners: () => nativeTheme,
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
  on: () => screen,
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
  toJPEG: () => Buffer.alloc(0),
  toBitmap: () => Buffer.alloc(0),
  toDataURL: () => '',
  getSize: () => ({ width: 0, height: 0 }),
  isEmpty: () => true,
  resize: () => emptyImage,
  crop: () => emptyImage,
  getBitmap: () => Buffer.alloc(0),
  getNativeHandle: () => Buffer.alloc(0),
  isTemplateImage: () => false,
  setTemplateImage: () => {},
  addRepresentation: () => {},
  getAspectRatio: () => 1,
  getScaleFactors: () => [1],
  toRGBA: () => ({ data: Buffer.alloc(0), width: 0, height: 0 }),
};

export const nativeImage = {
  createEmpty: () => ({ ...emptyImage }),
  createFromPath: () => ({ ...emptyImage }),
  createFromBuffer: () => ({ ...emptyImage }),
  createFromDataURL: () => ({ ...emptyImage }),
  createThumbnailFromPath: async () => ({ ...emptyImage }),
};

// ── desktopCapturer ──────────────────────────────────────────────────

export const desktopCapturer = {
  getSources: async () => [] as Array<{ id: string; name: string; thumbnail: unknown }>,
};

// ── globalShortcut ───────────────────────────────────────────────────

export const globalShortcut = {
  register: () => false,
  registerAll: () => {},
  unregister: () => {},
  unregisterAll: () => {},
  isRegistered: () => false,
};

// ── Menu / MenuItem / Tray ───────────────────────────────────────────

export class Menu {
  items: unknown[] = [];
  static setApplicationMenu() {}
  static getApplicationMenu() { return null; }
  static buildFromTemplate() { return new Menu(); }
  popup() {}
  closePopup() {}
  append() {}
  insert() {}
}

export class MenuItem {
  constructor(_options?: unknown) {}
}

export class Tray {
  constructor(_image?: unknown) {}
  setToolTip() {}
  setContextMenu() {}
  on() { return this; }
  destroy() {}
}

// ── Notification ─────────────────────────────────────────────────────

export class Notification {
  constructor(_options?: unknown) {}
  show() {}
  close() {}
  on() { return this; }
  static isSupported() { return false; }
}

// ── session ──────────────────────────────────────────────────────────

const mockSession = {
  clearCache: async () => {},
  clearStorageData: async () => {},
  setProxy: async () => {},
  resolveProxy: async () => 'DIRECT',
  on: () => mockSession,
  webRequest: {
    onBeforeRequest: () => {},
    onBeforeSendHeaders: () => {},
    onHeadersReceived: () => {},
    onCompleted: () => {},
  },
  protocol: {
    registerFileProtocol: () => false,
    registerStringProtocol: () => false,
    registerHttpProtocol: () => false,
    interceptFileProtocol: () => false,
  },
  cookies: {
    get: async () => [],
    set: async () => {},
    remove: async () => {},
  },
};

export const session = {
  defaultSession: mockSession,
  fromPartition: () => mockSession,
};

// ── net ──────────────────────────────────────────────────────────────

export const net = {
  request: () => ({
    on: () => {},
    end: () => {},
    write: () => {},
    abort: () => {},
  }),
  isOnline: () => true,
};

// ── autoUpdater ──────────────────────────────────────────────────────

export const autoUpdater = {
  checkForUpdates: () => {},
  checkForUpdatesAndNotify: async () => null,
  downloadUpdate: async () => {},
  quitAndInstall: () => {},
  on: () => autoUpdater,
  once: () => autoUpdater,
  removeListener: () => autoUpdater,
  setFeedURL: () => {},
  getFeedURL: () => '',
  currentVersion: { version: '0.0.0-web' },
};

// ── powerMonitor ─────────────────────────────────────────────────────

export const powerMonitor = {
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false,
  on: () => powerMonitor,
  once: () => powerMonitor,
  removeListener: () => powerMonitor,
};

// ── systemPreferences ────────────────────────────────────────────────

export const systemPreferences = {
  isDarkMode: () => false,
  getAccentColor: () => '0078d7',
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  getMediaAccessStatus: () => 'not-determined',
  askForMediaAccess: async () => false,
  on: () => systemPreferences,
};

// ── contentTracing ───────────────────────────────────────────────────

export const contentTracing = {
  startRecording: async () => {},
  stopRecording: async () => '',
  getCategories: async () => [],
  getTraceBufferUsage: async () => ({ value: 0, percentage: 0 }),
};

// ── protocol ─────────────────────────────────────────────────────────

export const protocol = {
  registerSchemesAsPrivileged: () => {},
  registerFileProtocol: () => false,
  registerStringProtocol: () => false,
  registerHttpProtocol: () => false,
  interceptFileProtocol: () => false,
};

// ── crashReporter ────────────────────────────────────────────────────

export const crashReporter = {
  start: () => {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  setUploadToServer: () => {},
};

// ── webContents ──────────────────────────────────────────────────────

export const webContents = {
  getAllWebContents: () => [],
  getFocusedWebContents: () => null,
  fromId: () => null,
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

// Preload API mocks
export const contextBridge = {
  exposeInMainWorld: (apiKey: string, api: Record<string, unknown>) => {
    (globalThis as Record<string, unknown>)[apiKey] = api;
  },
};

export const webUtils = {
  getPathForFile: (file: File) => (file as unknown as { path?: string }).path ?? file.name,
};
