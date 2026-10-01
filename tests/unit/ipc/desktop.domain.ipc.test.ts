import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const FULL_DISK_ACCESS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const execFileGate = vi.hoisted(() => ({
  installed: false,
  calls: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile: typeof actual.execFile = ((...args: unknown[]) => {
    if (execFileGate.installed) {
      const file = String(args[0]);
      const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
      execFileGate.calls.push({ file, args: argv });
      const callback = [...args].reverse().find((item) => typeof item === 'function') as
        | ((error: NodeJS.ErrnoException | null, stdout?: string, stderr?: string) => void)
        | undefined;
      callback?.(null, '', '');
      return undefined as unknown as ReturnType<typeof actual.execFile>;
    }
    return (actual.execFile as (...inner: unknown[]) => ReturnType<typeof actual.execFile>)(...args);
  }) as typeof actual.execFile;
  return { ...actual, execFile };
});

// desktop.ipc.ts 的 DESKTOP domain dispatch 聚焦覆盖（computer-surface observe/
// listElements 的复杂状态逻辑暂不深测）。重点：normalizeBrowserUrl 多分支校验、
// 托管浏览器会话/relay 委派、音频采集状态机（manualAudioActive + 启动失败原因）、
// dispatch 兜底。用 vi.resetModules + 动态 import 隔离模块级 manualAudioActive。

const svc = vi.hoisted(() => ({
  native: {
    getStatus: vi.fn(() => ({ running: true })),
    getCurrentContext: vi.fn(() => ({ app: 'x' })),
    getStats: vi.fn(() => ({ total: 1 })),
    listAudioSegments: vi.fn(() => []),
  },
  browser: {
    getSessionState: vi.fn(() => ({ running: false, mode: 'headless', activeTab: null as { id: string } | null })),
    ensureSession: vi.fn(async () => ({ running: true })),
    close: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    newTab: vi.fn(async () => {}),
    getAccountStateSummary: vi.fn(async () => ({ loggedIn: true })),
  },
  relay: {
    ensureStarted: vi.fn(async () => ({ running: true })),
    stop: vi.fn(async () => ({ running: false })),
    getState: vi.fn(() => ({ running: true, extensionPath: '/ext' as string | null })),
    listTabs: vi.fn(async () => [{ id: 't1' }]),
    createTab: vi.fn(async () => ({ id: 't2' })),
  },
  audioStatus: { capturing: true, soxAvailable: true, asrEngine: 'whisper' } as Record<string, unknown>,
  startAudio: vi.fn(async (..._a: unknown[]) => {}),
  stopAudio: vi.fn(),
  openPath: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock('../../../src/host/services/desktop/nativeDesktopService', () => ({ getNativeDesktopService: () => svc.native }));
vi.mock('../../../src/host/services/desktop/computerSurface', () => ({ getComputerSurface: () => ({ observe: vi.fn(), getState: vi.fn(), listBackgroundElements: vi.fn() }) }));
vi.mock('../../../src/host/services/desktop/desktopVisionAnalyzer', () => ({ startDesktopVisionAnalyzer: vi.fn() }));
vi.mock('../../../src/host/services/desktop/desktopAudioCapture', () => ({
  startDesktopAudioCapture: (...a: unknown[]) => svc.startAudio(...a),
  stopDesktopAudioCapture: () => svc.stopAudio(),
  getAudioCaptureStatus: () => svc.audioStatus,
}));
vi.mock('../../../src/host/services/infra/browserService', () => ({ browserService: svc.browser, getManagedBrowserService: () => svc.browser }));
vi.mock('../../../src/host/services/infra/browserRelayService', () => ({ browserRelayService: svc.relay }));
vi.mock('../../../src/host/platform', () => ({ shell: { openPath: (...a: unknown[]) => svc.openPath(...a) } }));
vi.mock('../../../src/host/services/infra/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', () => ({
  getManagedBrowserProviderAdapter: () => ({
    getPreferredUiSessionState: () => null,
  }),
}));

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

async function setup() {
  vi.resetModules();
  const { registerDesktopHandlers } = await import('../../../src/host/ipc/desktop.ipc');
  const handlers = new Map<string, HandlerFn>();
  registerDesktopHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.DESKTOP)!;
  return (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.browser.getSessionState.mockReturnValue({ running: false, mode: 'headless', activeTab: null });
  svc.relay.getState.mockReturnValue({ running: true, extensionPath: '/ext' });
  svc.audioStatus = { capturing: true, soxAvailable: true, asrEngine: 'whisper' };
});

describe('简单委派', () => {
  it('getStatus / getCurrentContext / getManagedBrowserSession', async () => {
    const call = await setup();
    expect((await call('getStatus')).data).toEqual({ running: true });
    expect((await call('getCurrentContext')).data).toEqual({ app: 'x' });
    expect((await call('getManagedBrowserSession')).data).toMatchObject({ running: false });
  });

  it('ensureManagedBrowserSession 默认 url=about:blank + leaseOwner', async () => {
    const call = await setup();
    const res = await call('ensureManagedBrowserSession', {});
    expect(res.success).toBe(true);
    expect(svc.browser.ensureSession).toHaveBeenCalledWith('about:blank', expect.objectContaining({
      leaseOwner: 'desktop-ipc',
      profileMode: 'isolated',
    }));
  });
});

describe('raw browser relay IPC', () => {
  it('禁止 Renderer 列出、创建或按 native tab id attach/detach', async () => {
    const call = await setup();
    for (const [action, payload] of [
      ['listBrowserRelayTabs', undefined],
      ['openBrowserRelayTab', { url: 'https://example.com' }],
      ['attachBrowserRelayTab', { tabId: 7 }],
      ['detachBrowserRelayTab', { tabId: 7 }],
    ] as const) {
      expect(await call(action, payload)).toMatchObject({
        success: false,
        error: { code: 'DESKTOP_ERROR', message: expect.stringContaining('BROWSER_TAB_BORROW_REQUIRED') },
      });
    }
    expect(svc.relay.listTabs).not.toHaveBeenCalled();
    expect(svc.relay.createTab).not.toHaveBeenCalled();
  });
});

describe('openManagedBrowserUrl 会话切换逻辑', () => {
  it('headless 运行中切 visible → 先 close 再 ensure，有 activeTab 走 navigate', async () => {
    const call = await setup();
    svc.browser.getSessionState
      .mockReturnValueOnce({ running: true, mode: 'headless', activeTab: null }) // current
      .mockReturnValue({ running: true, mode: 'visible', activeTab: { id: 'tab1' } }); // next + final
    const res = await call('openManagedBrowserUrl', { url: 'a.com', mode: 'visible' });
    expect(res.success).toBe(true);
    expect(svc.browser.close).toHaveBeenCalled();
    expect(svc.browser.navigate).toHaveBeenCalledWith('https://a.com/', 'tab1');
  });

  it('无 activeTab → newTab', async () => {
    const call = await setup();
    svc.browser.getSessionState.mockReturnValue({ running: false, mode: 'visible', activeTab: null });
    await call('openManagedBrowserUrl', { url: 'b.com' });
    expect(svc.browser.newTab).toHaveBeenCalledWith('https://b.com/');
  });
});

describe('browser relay', () => {
  it('start/stop/getState 委派', async () => {
    const call = await setup();
    expect((await call('startBrowserRelay')).data).toMatchObject({ running: true });
    expect((await call('stopBrowserRelay')).data).toMatchObject({ running: false });
    expect((await call('getBrowserRelayState')).data).toMatchObject({ extensionPath: '/ext' });
  });

  it('openBrowserRelayExtensionDirectory 有路径 → shell.openPath', async () => {
    const call = await setup();
    await call('openBrowserRelayExtensionDirectory');
    expect(svc.openPath).toHaveBeenCalledWith('/ext');
  });

  it('openBrowserRelayExtensionDirectory 无路径 → 报错', async () => {
    const call = await setup();
    svc.relay.getState.mockReturnValue({ running: true, extensionPath: null });
    expect(await call('openBrowserRelayExtensionDirectory')).toMatchObject({ success: false, error: { message: expect.stringContaining('not found') } });
  });
});

describe('音频采集状态机', () => {
  it('启动成功 → capturing 状态', async () => {
    const call = await setup();
    const res = await call('startAudioCapture', { mode: 'microphone' });
    expect(res.success).toBe(true);
    expect(svc.startAudio).toHaveBeenCalledWith(undefined, 'microphone');
  });

  it('已在采集 → 幂等返回当前状态，不重复启动', async () => {
    const call = await setup();
    await call('startAudioCapture', {});
    svc.startAudio.mockClear();
    const res = await call('startAudioCapture', {});
    expect(res.success).toBe(true);
    expect(svc.startAudio).not.toHaveBeenCalled(); // manualAudioActive 已 true
  });

  it('启动后 not capturing（sox 缺失）→ AUDIO_START_FAILED 带原因', async () => {
    const call = await setup();
    svc.audioStatus = { capturing: false, soxAvailable: false, asrEngine: 'whisper' };
    const res = await call('startAudioCapture', {});
    expect(res).toMatchObject({ success: false, error: { code: 'AUDIO_START_FAILED', message: expect.stringContaining('sox') } });
  });

  it('stopAudioCapture / getAudioCaptureStatus', async () => {
    const call = await setup();
    expect((await call('stopAudioCapture')).success).toBe(true);
    expect(svc.stopAudio).toHaveBeenCalled();
    expect((await call('getAudioCaptureStatus')).data).toMatchObject({ capturing: true });
  });
});

describe('openFullDiskAccessSettings', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    execFileGate.installed = false;
    execFileGate.calls = [];
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('darwin calls open once with the Full Disk Access URL', async () => {
    execFileGate.installed = true;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const call = await setup();
    await expect(call('openFullDiskAccessSettings')).resolves.toEqual({ success: true, data: true });
    expect(execFileGate.calls).toEqual([
      { file: 'open', args: [FULL_DISK_ACCESS_SETTINGS_URL] },
    ]);
  });

  it('non-darwin does not call open and returns false', async () => {
    execFileGate.installed = true;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const call = await setup();
    await expect(call('openFullDiskAccessSettings')).resolves.toEqual({ success: true, data: false });
    expect(execFileGate.calls).toEqual([]);
  });
});

describe('dispatch 兜底', () => {
  it('未知 action → UNKNOWN_ACTION', async () => {
    const call = await setup();
    expect(await call('bogus')).toMatchObject({ success: false, error: { code: 'UNKNOWN_ACTION' } });
  });

  it('service 抛错 → DESKTOP_ERROR', async () => {
    const call = await setup();
    svc.native.getStatus.mockImplementation(() => {
      throw new Error('native down');
    });
    expect(await call('getStatus')).toMatchObject({ success: false, error: { code: 'DESKTOP_ERROR', message: 'native down' } });
  });
});
