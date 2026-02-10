// ============================================================================
// Vitest Global Setup
// 在所有测试模块加载前注册全局 mock，避免非 Electron 环境模块崩溃
// ============================================================================

import { vi } from 'vitest';

// 标记为 CLI 模式，跳过 secureStorage.ts 中的 require('keytar')
// keytar 为 Electron headers 编译，在系统 Node.js 中 SIGSEGV (exit 139)
process.env.CODE_AGENT_CLI_MODE = '1';

// electron: vitest 跑在纯 Node.js 环境，没有 Electron runtime
// ToolRegistry 导入链中 5 个工具文件直接 import electron (app/BrowserWindow/ipcMain 等)
// 必须在 setup 阶段提供完整 mock，否则 worker 进程直接崩
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/tmp/mock-electron-${name}`,
    getName: () => 'code-agent-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    once: () => {},
    quit: () => {},
  },
  BrowserWindow: class MockBrowserWindow {
    static getAllWindows() { return []; }
    static getFocusedWindow() { return null; }
    webContents = { send: () => {} };
    on() { return this; }
    once() { return this; }
  },
  ipcMain: {
    on: () => {},
    once: () => {},
    handle: () => {},
    removeHandler: () => {},
  },
  clipboard: {
    readText: () => '',
    readImage: () => ({ isEmpty: () => true, toDataURL: () => '' }),
    writeText: () => {},
  },
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => true }),
  },
  shell: {
    openExternal: () => Promise.resolve(),
  },
}));

// isolated-vm: C++ 原生模块，sandbox.ts 已改为懒加载，
// 但仍需 mock 以防被直接引用
vi.mock('isolated-vm', () => ({
  Isolate: class MockIsolate {
    createContextSync() { return { global: { setSync: () => {} }, release: () => {} }; }
    compileScriptSync() { return { run: () => ({}) }; }
    dispose() {}
  },
}));

// node-pty: PTY 原生模块，在 vitest fork worker 中可能干扰进程信号处理
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    on: () => {},
    write: () => {},
    kill: () => {},
    resize: () => {},
    pid: 0,
  }),
}));

// keytar: 系统密钥链原生模块，在 vitest fork worker 中会 SIGSEGV (exit code 139)
// secureStorage.ts 在 try-catch 中 require('keytar')，但 segfault 不可 catch
vi.mock('keytar', () => ({
  getPassword: () => Promise.resolve(null),
  setPassword: () => Promise.resolve(),
  deletePassword: () => Promise.resolve(true),
  findCredentials: () => Promise.resolve([]),
}));

// electron-store: ESM 模块，vitest 中 require() 加载会报 ExperimentalWarning
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      get() { return undefined; }
      set() {}
      delete() {}
      has() { return false; }
      clear() {}
    },
  };
});

// better-sqlite3: 数据库原生模块，可能被间接引用
vi.mock('better-sqlite3', () => {
  const mockDb = {
    pragma: () => {},
    prepare: () => ({
      run: () => ({}),
      get: () => undefined,
      all: () => [],
    }),
    exec: () => {},
    close: () => {},
    transaction: (fn: Function) => fn,
  };
  return { default: () => mockDb };
});
