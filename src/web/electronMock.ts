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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron app API mock 占位签名，等 IPC zod 重构后改成具体 Electron 类型
  commandLine: { appendSwitch: (..._args: any[]) => {} },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron app API mock 占位签名，等 IPC zod 重构后改成具体 Electron 类型
  on: (..._args: any[]) => app,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  once: (..._args: any[]) => app,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  off: (..._args: any[]) => app,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  removeListener: (..._args: any[]) => app,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  removeAllListeners: (..._args: any[]) => app,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  emit: (..._args: any[]) => false,
  quit: () => {},
  exit: () => {},
  requestSingleInstanceLock: () => true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron app API mock 占位签名，等 IPC zod 重构后改成具体 Electron 类型
  setAppUserModelId: (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron app API mock 占位签名，等 IPC zod 重构后改成具体 Electron 类型
  setAsDefaultProtocolClient: (..._args: any[]) => false as boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron app API mock 占位签名，等 IPC zod 重构后改成具体 Electron 类型
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    on: (..._args: any[]) => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    once: (..._args: any[]) => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    openDevTools: (..._args: any[]) => {},
    session: { clearCache: async () => {} },
    getURL: () => '',
    isDestroyed: () => false, // Web 模式下窗口始终"存在"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    setWindowOpenHandler: (..._args: any[]) => {},
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  constructor(_options?: Record<string, any>) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  loadURL(..._args: any[]) { return Promise.resolve(); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setTitle(..._args: any[]) {}
  getTitle() { return ''; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setBounds(..._args: any[]) {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setSize(..._args: any[]) {}
  getSize() { return [800, 600]; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on(..._args: any[]) { return this; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  once(..._args: any[]) { return this; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  removeListener(..._args: any[]) { return this; }

  static getAllWindows(): BrowserWindow[] { return []; }
  static getFocusedWindow(): BrowserWindow | null { return null; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  static fromWebContents(..._args: any[]): BrowserWindow | null { return null; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  static fromId(..._args: any[]): BrowserWindow | null { return null; }
}

// ── dialog ───────────────────────────────────────────────────────────

export const dialog = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  showOpenDialog: async (..._args: any[]) => ({ canceled: true, filePaths: [] as string[] }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  showSaveDialog: async (..._args: any[]) => ({ canceled: true, filePath: undefined }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  showMessageBox: async (..._args: any[]) => ({ response: 0, checkboxChecked: false }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  showErrorBox: (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  showOpenDialogSync: (..._args: any[]) => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  showSaveDialogSync: (..._args: any[]) => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  showMessageBoxSync: (..._args: any[]) => 0,
};

// ── shell ────────────────────────────────────────────────────────────
// 复用 main/platform/nativeShell 的安全实现（execFile + URL/path 校验）
import { shell as _shell } from '../main/platform/nativeShell';
export const shell = _shell;

// ── clipboard ────────────────────────────────────────────────────────

export const clipboard = {
  readText: () => '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  writeText: (..._args: any[]) => {},
  readHTML: () => '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  writeHTML: (..._args: any[]) => {},
  readImage: () => nativeImage.createEmpty(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  writeImage: (..._args: any[]) => {},
  readRTF: () => '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  writeRTF: (..._args: any[]) => {},
  clear: () => {},
  availableFormats: () => [] as string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  has: (..._args: any[]) => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  read: (..._args: any[]) => '',
  readBookmark: () => ({ title: '', url: '' }),
  readFindText: () => '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  writeFindText: (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  writeBookmark: (..._args: any[]) => {},
};

// ── nativeTheme ──────────────────────────────────────────────────────

export const nativeTheme = {
  themeSource: 'system' as string,
  shouldUseDarkColors: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on: (..._args: any[]) => nativeTheme,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  once: (..._args: any[]) => nativeTheme,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  off: (..._args: any[]) => nativeTheme,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  removeListener: (..._args: any[]) => nativeTheme,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  resize: (..._args: any[]) => emptyImage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  crop: (..._args: any[]) => emptyImage,
  getBitmap: () => Buffer.alloc(0),
  getNativeHandle: () => Buffer.alloc(0),
  isTemplateImage: () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setTemplateImage: (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  addRepresentation: (..._args: any[]) => {},
  getAspectRatio: () => 1,
  getScaleFactors: () => [1],
  toRGBA: () => ({ data: Buffer.alloc(0), width: 0, height: 0 }),
};

export const nativeImage = {
  createEmpty: () => ({ ...emptyImage }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  createFromPath: (..._args: any[]) => ({ ...emptyImage }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  createFromBuffer: (..._args: any[]) => ({ ...emptyImage }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  createFromDataURL: (..._args: any[]) => ({ ...emptyImage }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  createThumbnailFromPath: async (..._args: any[]) => ({ ...emptyImage }),
};

// ── desktopCapturer ──────────────────────────────────────────────────

export const desktopCapturer = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  getSources: async (..._args: any[]) => [] as Array<{ id: string; name: string; thumbnail: ReturnType<typeof nativeImage.createEmpty> }>,
};

// ── globalShortcut ───────────────────────────────────────────────────

export const globalShortcut = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  register: (..._args: any[]) => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  registerAll: (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  unregister: (..._args: any[]) => {},
  unregisterAll: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  isRegistered: (..._args: any[]) => false,
};

// ── Menu / MenuItem / Tray ───────────────────────────────────────────

export class Menu {
  items: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  static setApplicationMenu(..._args: any[]) {}
  static getApplicationMenu() { return null; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  static buildFromTemplate(..._args: any[]) { return new Menu(); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  popup(..._args: any[]) {}
  closePopup() {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  append(..._args: any[]) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  insert(..._args: any[]) {}
}

export class MenuItem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  constructor(_options?: any) {}
}

export class Tray {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  constructor(_image?: any) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setToolTip(..._args: any[]) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setContextMenu(..._args: any[]) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on(..._args: any[]) { return this; }
  destroy() {}
}

// ── Notification ─────────────────────────────────────────────────────

export class Notification {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  constructor(_options?: { title?: string; body?: string; icon?: any; [key: string]: any }) {}
  show() {}
  close() {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on(..._args: any[]) { return this; }
  static isSupported() { return false; }
}

// ── session ──────────────────────────────────────────────────────────

const mockSession = {
  clearCache: async () => {},
  clearStorageData: async () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setProxy: async (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  resolveProxy: async (..._args: any[]) => 'DIRECT',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on: (..._args: any[]) => mockSession,
  webRequest: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    onBeforeRequest: (..._args: any[]) => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    onBeforeSendHeaders: (..._args: any[]) => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    onHeadersReceived: (..._args: any[]) => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    onCompleted: (..._args: any[]) => {},
  },
  protocol: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    registerFileProtocol: (..._args: any[]) => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    registerStringProtocol: (..._args: any[]) => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    registerHttpProtocol: (..._args: any[]) => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    interceptFileProtocol: (..._args: any[]) => false,
  },
  cookies: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    get: async (..._args: any[]) => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    set: async (..._args: any[]) => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    remove: async (..._args: any[]) => {},
  },
};

export const session = {
  defaultSession: mockSession,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  fromPartition: (..._args: any[]) => mockSession,
};

// ── net ──────────────────────────────────────────────────────────────

export const net = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  request: (..._args: any[]) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
    on: (..._args2: any[]) => {},
    end: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  quitAndInstall: (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on: (..._args: any[]) => autoUpdater,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  once: (..._args: any[]) => autoUpdater,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  removeListener: (..._args: any[]) => autoUpdater,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setFeedURL: (..._args: any[]) => {},
  getFeedURL: () => '',
  currentVersion: { version: '0.0.0-web' },
};

// ── powerMonitor ─────────────────────────────────────────────────────

export const powerMonitor = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  getSystemIdleState: (..._args: any[]) => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on: (..._args: any[]) => powerMonitor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  once: (..._args: any[]) => powerMonitor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  removeListener: (..._args: any[]) => powerMonitor,
};

// ── systemPreferences ────────────────────────────────────────────────

export const systemPreferences = {
  isDarkMode: () => false,
  getAccentColor: () => '0078d7',
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  getMediaAccessStatus: (..._args: any[]) => 'not-determined',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  askForMediaAccess: async (..._args: any[]) => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  on: (..._args: any[]) => systemPreferences,
};

// ── contentTracing ───────────────────────────────────────────────────

export const contentTracing = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  startRecording: async (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  stopRecording: async (..._args: any[]) => '',
  getCategories: async () => [],
  getTraceBufferUsage: async () => ({ value: 0, percentage: 0 }),
};

// ── protocol ─────────────────────────────────────────────────────────

export const protocol = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  registerSchemesAsPrivileged: (..._args: any[]) => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  registerFileProtocol: (..._args: any[]) => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  registerStringProtocol: (..._args: any[]) => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  registerHttpProtocol: (..._args: any[]) => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  interceptFileProtocol: (..._args: any[]) => false,
};

// ── crashReporter ────────────────────────────────────────────────────

export const crashReporter = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  start: (..._args: any[]) => {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
  setUploadToServer: (..._args: any[]) => {},
};

// ── webContents ──────────────────────────────────────────────────────

export const webContents = {
  getAllWebContents: () => [],
  getFocusedWebContents: () => null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): electron mock 函数签名占位，整个文件是 web 模式下的 electron API stub，等迁移到 Electron 类型 import 后整体收紧
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
