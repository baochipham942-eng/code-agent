// ============================================================================
// Electron Mock - 为 Web 独立模式提供 electron 模块的 mock
// ============================================================================
//
// 许多 IPC handler 直接 `import { ipcMain } from 'electron'`，
// 因此我们需要在 Node.js 模块系统层面拦截 electron 的 require/import。
//
// 这个模块导出一个 mockIpcMain，它会捕获所有 handler 注册。
// 同时导出一个 installElectronMock() 函数来注册到 Module._cache。
// ============================================================================

import Module from 'module';

export type HandlerFn = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

/** 所有通过 ipcMain.handle() 注册的 handler */
export const handlers = new Map<string, HandlerFn>();

/** 所有通过 ipcMain.on() 注册的 listener */
export const eventListeners = new Map<string, HandlerFn>();

/**
 * Mock ipcMain — 捕获 handler 注册
 */
export const mockIpcMain = {
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

/**
 * Mock BrowserWindow
 */
const MockBrowserWindow = class {
  webContents = {
    send: (_channel: string, ..._args: unknown[]) => {
      // Web 模式下通过 SSE 推送，这里 no-op
    },
  };
  static getAllWindows() {
    return [];
  }
  static getFocusedWindow() {
    return null;
  }
};

/**
 * Mock app
 */
const mockApp = {
  getPath: (name: string) => {
    switch (name) {
      case 'userData': return process.env.CODE_AGENT_DATA_DIR || '/tmp/code-agent';
      case 'home': return process.env.HOME || '/tmp';
      case 'temp': return '/tmp';
      default: return '/tmp';
    }
  },
  getVersion: () => '0.0.0-web',
  getName: () => 'code-agent-web',
  isReady: () => true,
  on: () => mockApp,
  once: () => mockApp,
  quit: () => {},
};

/**
 * 完整的 electron mock 模块
 */
export const electronMock = {
  ipcMain: mockIpcMain,
  ipcRenderer: {
    invoke: async () => undefined,
    on: () => {},
    send: () => {},
  },
  BrowserWindow: MockBrowserWindow,
  app: mockApp,
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => ({ error: '' }),
    showItemInFolder: () => {},
  },
  clipboard: {
    readText: () => '',
    writeText: () => {},
  },
  nativeTheme: {
    themeSource: 'system' as string,
    shouldUseDarkColors: false,
    on: () => {},
  },
  screen: {
    getPrimaryDisplay: () => ({
      workAreaSize: { width: 1920, height: 1080 },
    }),
  },
  // default export = app
  default: undefined as unknown,
};
electronMock.default = mockApp;

/**
 * 安装 electron mock 到 Node.js 模块系统
 *
 * 必须在 import 任何 IPC handler 之前调用。
 * 通过 hack Module._resolveFilename 来拦截 `require('electron')`。
 */
export function installElectronMock(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const M = Module as any;

  // 创建一个假的 electron 模块并注入缓存
  const fakeElectronPath = '__electron_mock__';

  // 拦截 resolve
  const originalResolve = M._resolveFilename;
  M._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options: unknown
  ) {
    if (request === 'electron') {
      return fakeElectronPath;
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };

  // 在缓存中放入 mock 模块
  M._cache[fakeElectronPath] = {
    id: fakeElectronPath,
    filename: fakeElectronPath,
    loaded: true,
    exports: electronMock,
    children: [],
    paths: [],
  };
}
