// ============================================================================
// Platform: Misc Compat - 替代 Electron 杂项模块
// ============================================================================
// dialog, safeStorage, screen, desktopCapturer, Menu, Tray, session, etc.
// 在 Web/CLI 模式下为 no-op，桌面模式可接入 Tauri 插件
// ============================================================================

// ── dialog ─────────────────────────────────────────────────────────────

export const dialog = {
  showOpenDialog: async (..._args: unknown[]) => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async (..._args: unknown[]) => ({ canceled: true, filePath: undefined }),
  showMessageBox: async (..._args: unknown[]) => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (..._args: unknown[]) => {},
  showOpenDialogSync: (..._args: unknown[]) => undefined,
  showSaveDialogSync: (..._args: unknown[]) => undefined,
  showMessageBoxSync: (..._args: unknown[]) => 0,
};

// ── safeStorage ────────────────────────────────────────────────────────

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (plainText: string) => Buffer.from(plainText),
  decryptString: (encrypted: Buffer) => encrypted.toString(),
};

// ── screen ─────────────────────────────────────────────────────────────

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

// ── desktopCapturer ────────────────────────────────────────────────────

export const desktopCapturer = {
  getSources: async (..._args: unknown[]) => [] as Array<{ id: string; name: string; thumbnail: unknown }>,
};

// ── nativeTheme ────────────────────────────────────────────────────────

export const nativeTheme = {
  themeSource: 'system' as string,
  shouldUseDarkColors: false,
  on: (..._args: unknown[]) => nativeTheme,
  once: (..._args: unknown[]) => nativeTheme,
  off: (..._args: unknown[]) => nativeTheme,
  removeListener: (..._args: unknown[]) => nativeTheme,
  removeAllListeners: (..._args: unknown[]) => nativeTheme,
};

// ── Menu / MenuItem / Tray ─────────────────────────────────────────────

 
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

// ── session ────────────────────────────────────────────────────────────

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

// ── net ────────────────────────────────────────────────────────────────

export const net = {
  request: (..._args: unknown[]) => ({
    on: (..._args2: unknown[]) => {},
    end: () => {},
    write: (..._args2: unknown[]) => {},
    abort: () => {},
  }),
  isOnline: () => true,
};

// ── autoUpdater ────────────────────────────────────────────────────────

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
  currentVersion: { version: '0.0.0' },
};

// ── powerMonitor ───────────────────────────────────────────────────────

export const powerMonitor = {
  getSystemIdleState: (..._args: unknown[]) => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false,
  on: (..._args: unknown[]) => powerMonitor,
  once: (..._args: unknown[]) => powerMonitor,
  removeListener: (..._args: unknown[]) => powerMonitor,
};

// ── systemPreferences ──────────────────────────────────────────────────

export const systemPreferences = {
  isDarkMode: () => false,
  getAccentColor: () => '0078d7',
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  getMediaAccessStatus: (..._args: unknown[]) => 'not-determined',
  askForMediaAccess: async (..._args: unknown[]) => false,
  on: (..._args: unknown[]) => systemPreferences,
};

// ── contentTracing ─────────────────────────────────────────────────────

export const contentTracing = {
  startRecording: async (..._args: unknown[]) => {},
  stopRecording: async (..._args: unknown[]) => '',
  getCategories: async () => [],
  getTraceBufferUsage: async () => ({ value: 0, percentage: 0 }),
};

// ── protocol ───────────────────────────────────────────────────────────

export const protocol = {
  registerSchemesAsPrivileged: (..._args: unknown[]) => {},
  registerFileProtocol: (..._args: unknown[]) => false,
  registerStringProtocol: (..._args: unknown[]) => false,
  registerHttpProtocol: (..._args: unknown[]) => false,
  interceptFileProtocol: (..._args: unknown[]) => false,
};

// ── crashReporter ──────────────────────────────────────────────────────

export const crashReporter = {
  start: (..._args: unknown[]) => {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  setUploadToServer: (..._args: unknown[]) => {},
};

// ── webContents ────────────────────────────────────────────────────────

export const webContents = {
  getAllWebContents: () => [],
  getFocusedWebContents: () => null,
  fromId: (..._args: unknown[]) => null,
};

// ── contextBridge ──────────────────────────────────────────────────────

export const contextBridge = {
  exposeInMainWorld: (apiKey: string, api: Record<string, unknown>) => {
    (globalThis as Record<string, unknown>)[apiKey] = api;
  },
};

// ── webUtils ───────────────────────────────────────────────────────────

export const webUtils = {
  getPathForFile: async (file: File) => (file as unknown as { path?: string }).path ?? file.name,
};

// ── ipcRenderer ────────────────────────────────────────────────────────

export const ipcRenderer = {
  invoke: async () => undefined,
  on: () => ipcRenderer,
  once: () => ipcRenderer,
  send: () => {},
  removeListener: () => ipcRenderer,
  removeAllListeners: () => ipcRenderer,
};
