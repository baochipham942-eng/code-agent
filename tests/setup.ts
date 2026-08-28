// ============================================================================
// Vitest Global Setup
// 在所有测试模块加载前注册全局 mock，避免非 Electron 环境模块崩溃
// ============================================================================

import { beforeEach, vi } from 'vitest';
import { configureFolderTrustService } from '../src/host/security/folderTrustServiceConfig';

// 标记为 CLI 模式，跳过 secureStorage.ts 中的 require('keytar')
// keytar 为 Electron headers 编译，在系统 Node.js 中 SIGSEGV (exit 139)
process.env.CODE_AGENT_CLI_MODE = '1';

// Most existing unit tests predate the folder trust gate and exercise loaders in a
// "project config is readable" test context. Security gate tests explicitly clear
// this injected default to cover untrusted/trusted behavior against the real service.
beforeEach(() => {
  configureFolderTrustService({ defaultProjectConfigTrust: true });
});

// 浏览器冒烟（game-runtime / visual smoke）测试态强制走 Playwright bundled headless shell。
// 'auto' 在装有 Chrome 的机器上解析为 system-chrome-cdp，而系统 Chrome 即使 --headless=new
// 启动时仍会向 macOS Dock 短暂注册应用，跑测试批量 spawn 会让整排 Dock 图标反复跳动。
// 显式设置 provider 的测试（如 gameArtifactValidator 的 skip 路径用例）自行覆写，不受影响。
process.env.CODE_AGENT_BROWSER_PROVIDER ||= 'playwright-bundled';

// electron: vitest 跑在纯 Node.js 环境，没有 Electron runtime
// ToolRegistry 导入链中 5 个工具文件直接 import electron (app/AppWindow/ipcHost 等)
// 必须在 setup 阶段提供完整 mock，否则 worker 进程直接崩
// 说明：vitest.config.ts 把 `electron` 别名到 src/host/platform/index.ts，
// 所以这份 mock 同时充当 platform 桶的 mock —— platform 新增导出时必须同步补进来，
// 否则消费它的生产代码在测试里会以 "No X export is defined on the electron mock" 崩掉。
// 2026-08-27 补 hasInteractiveUi / setBrowserWindowInteractionProbe：#1415 把
// agent.ts 的审批 UI 判定源从 sseClients 换成 hasInteractiveUi()，但没给这份 mock 补导出。
let mockInteractionProbe: (() => boolean) | null = null;
vi.mock('electron', () => ({
  // 与 windowBridge.hasInteractiveUi 同语义：有 probe 用 probe，没有则按「无窗口」false。
  hasInteractiveUi: () => (mockInteractionProbe ? mockInteractionProbe() : false),
  setBrowserWindowInteractionProbe: (probe: (() => boolean) | null) => { mockInteractionProbe = probe; },
  app: {
    getPath: (name: string) => `/tmp/mock-electron-${name}`,
    getAppPath: () => process.cwd(),
    getName: () => 'code-agent-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    once: () => {},
    quit: () => {},
  },
  AppWindow: class MockBrowserWindow {
    static getAllWindows() { return []; }
    static getFocusedWindow() { return null; }
    webContents = { send: () => {} };
    on() { return this; }
    once() { return this; }
  },
  ipcHost: {
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


// node-pty: PTY 原生模块，在 vitest fork worker 中可能干扰进程信号处理。
//
// 🔴 更硬的理由（2026-08-14 实测，两轮 CI 红换来的）：**CI 上根本起不来真 PTY，且两个
// runner 各坏各的**——linux-x64 没有原生产物（`Cannot find module
// './prebuilds/linux-x64//pty.node'`），**模块加载阶段**就炸；macOS 加载得了，但
// `pty.spawn` 运行时抛 `posix_spawnp failed.`。所以这个 mock 不是可选的洁癖。
//
// 要验**真** PTY 行为（「进程组死没死」这种 mock 句柄回答不了的判据）的写法见
// `tests/unit/tools/shell/ptyTreeExit.realProcess.test.ts`：能力探测**必须真 spawn 一次**
// （只做 `vi.importActual` 是代理信号，挡不住 macOS 那支），可用才 `vi.doUnmock` +
// 动态 import，不可用整组 `describe.skipIf`，并另留一组永不跳过的接线守护防假绿。
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
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
  };
  return { default: () => mockDb };
});
// Retry timing is an explicit test input; production code keeps production defaults.
process.env.ARTIFACT_SELECTED_PROVIDER_RETRY_DELAY_1_MS = '0';
process.env.ARTIFACT_SELECTED_PROVIDER_RETRY_DELAY_2_MS = '0';
