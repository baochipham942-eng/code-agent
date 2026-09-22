import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// update.ipc.ts 派发特征测试（RQ-183 续作·UPDATE 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 10 个 action（计数以切块断言为准）。
// - check：服务未初始化 → { hasUpdate: false, currentVersion }；已初始化回服务结果；服务抛错 → warn 并回本地版本兜底（不冒泡）
// - getInfo：未初始化 → null；否则回缓存
// - download / openFile / openUrl / prepareRuntimeAssets：未初始化抛 'Update service not initialized' → INTERNAL_ERROR；已初始化透传参数
//   （openFile / openUrl 回 null；prepareRuntimeAssets 有 assetId 调单资源、否则调全量）
// - startAutoCheck / stopAutoCheck：未初始化静默；已初始化调服务；均回 null
// - runtimeAssetsStatus：合并 getRuntimeAssetsStatus(shellVersion) 与 preparation（未初始化为 null）；rendererBundleStatus 读 userData 路径
// - 未知 action → INVALID_ACTION + `Unknown action: <action>`；非 Error 抛出 → String(error)
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  initialized: true,
  svc: {
    checkForUpdates: vi.fn(async (): Promise<unknown> => ({ hasUpdate: true, currentVersion: '1.0.0', latestVersion: '1.1.0' })),
    getCachedUpdateInfo: vi.fn((): unknown => ({ hasUpdate: true, cached: true })),
    downloadUpdate: vi.fn(async (_u: string): Promise<string> => '/tmp/app.dmg'),
    openDownloadedFile: vi.fn(async (_p: string): Promise<void> => {}),
    openDownloadUrl: vi.fn(async (_u: string): Promise<void> => {}),
    startAutoCheck: vi.fn(),
    stopAutoCheck: vi.fn(),
    getRuntimeAssetPreparationStatus: vi.fn((): unknown => ({ preparing: false })),
    prepareRuntimeAsset: vi.fn(async (_id: string): Promise<unknown> => ({ one: true })),
    prepareRuntimeAssets: vi.fn(async (): Promise<unknown> => ({ all: true })),
  },
  assetsStatus: vi.fn(async (_o: unknown): Promise<unknown> => ({ assets: [], shell: 'ok' })),
  bundleStatus: vi.fn(async (_p: string): Promise<unknown> => ({ active: 'v1' })),
  logWarn: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '1.0.0', getPath: (k: string) => `/data/${k}` },
}));
vi.mock('../../../src/host/services/cloud/updateService', () => ({
  getUpdateService: () => h.svc,
  isUpdateServiceInitialized: () => h.initialized,
}));
vi.mock('../../../src/host/runtime/runtimeAssetStatus', () => ({ getRuntimeAssetsStatus: (o: unknown) => h.assetsStatus(o) }));
vi.mock('../../../src/host/services/renderer/rendererBundleCache', () => ({ readRendererBundleStatus: (p: string) => h.bundleStatus(p) }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.logWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { registerUpdateHandlers } from '../../../src/host/ipc/update.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;
const notInit = { success: false, error: { code: 'INTERNAL_ERROR', message: 'Update service not initialized' } };

beforeEach(() => {
  vi.clearAllMocks();
  h.initialized = true;
  const handlers = new Map<string, HandlerFn>();
  registerUpdateHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.UPDATE)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('update.ipc dispatch 特征：检查与信息', () => {
  it('check：未初始化本地版本；已初始化回服务结果；服务抛错 warn 后兜底', async () => {
    h.initialized = false;
    expect(await call('check')).toEqual({ success: true, data: { hasUpdate: false, currentVersion: '1.0.0' } });
    h.initialized = true;
    expect(await call('check')).toEqual({ success: true, data: { hasUpdate: true, currentVersion: '1.0.0', latestVersion: '1.1.0' } });
    h.svc.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    expect(await call('check')).toEqual({ success: true, data: { hasUpdate: false, currentVersion: '1.0.0' } });
    expect(h.logWarn).toHaveBeenCalledWith('Update check failed; using local version fallback', { error: 'offline', currentVersion: '1.0.0' });
  });

  it('getInfo：未初始化 null；已初始化回缓存', async () => {
    h.initialized = false;
    expect(await call('getInfo')).toEqual({ success: true, data: null });
    h.initialized = true;
    expect(await call('getInfo')).toEqual({ success: true, data: { hasUpdate: true, cached: true } });
  });
});

describe('update.ipc dispatch 特征：下载与打开', () => {
  it('download / openFile / openUrl / prepareRuntimeAssets：未初始化 → INTERNAL_ERROR 固定文案', async () => {
    h.initialized = false;
    for (const [a, p] of [['download', { downloadUrl: 'u' }], ['openFile', { filePath: 'f' }], ['openUrl', { url: 'u' }], ['prepareRuntimeAssets', undefined]] as const) {
      expect(await call(a, p)).toEqual(notInit);
    }
  });

  it('已初始化：参数透传，openFile / openUrl 回 null', async () => {
    expect(await call('download', { downloadUrl: 'https://x/app.dmg' })).toEqual({ success: true, data: '/tmp/app.dmg' });
    expect(h.svc.downloadUpdate).toHaveBeenCalledWith('https://x/app.dmg');
    expect(await call('openFile', { filePath: '/tmp/app.dmg' })).toEqual({ success: true, data: null });
    expect(h.svc.openDownloadedFile).toHaveBeenCalledWith('/tmp/app.dmg');
    expect(await call('openUrl', { url: 'https://x' })).toEqual({ success: true, data: null });
    expect(h.svc.openDownloadUrl).toHaveBeenCalledWith('https://x');
  });

  it('prepareRuntimeAssets：有 assetId 调单资源，否则调全量', async () => {
    expect(await call('prepareRuntimeAssets', { assetId: 'poppler' })).toEqual({ success: true, data: { one: true } });
    expect(h.svc.prepareRuntimeAsset).toHaveBeenCalledWith('poppler');
    expect(await call('prepareRuntimeAssets')).toEqual({ success: true, data: { all: true } });
  });
});

describe('update.ipc dispatch 特征：自动检查与状态', () => {
  it('start / stopAutoCheck：未初始化静默，已初始化调服务，均回 null', async () => {
    h.initialized = false;
    expect(await call('startAutoCheck')).toEqual({ success: true, data: null });
    expect(await call('stopAutoCheck')).toEqual({ success: true, data: null });
    expect(h.svc.startAutoCheck).not.toHaveBeenCalled();
    h.initialized = true;
    await call('startAutoCheck'); await call('stopAutoCheck');
    expect(h.svc.startAutoCheck).toHaveBeenCalledTimes(1);
    expect(h.svc.stopAutoCheck).toHaveBeenCalledTimes(1);
  });

  it('runtimeAssetsStatus 合并 preparation（未初始化 null）；rendererBundleStatus 读 userData', async () => {
    expect(await call('runtimeAssetsStatus')).toEqual({ success: true, data: { assets: [], shell: 'ok', preparation: { preparing: false } } });
    expect(h.assetsStatus).toHaveBeenCalledWith({ shellVersion: '1.0.0' });
    h.initialized = false;
    expect(await call('runtimeAssetsStatus')).toEqual({ success: true, data: { assets: [], shell: 'ok', preparation: null } });
    expect(await call('rendererBundleStatus')).toEqual({ success: true, data: { active: 'v1' } });
    expect(h.bundleStatus).toHaveBeenCalledWith('/data/userData');
  });

  it('未知 action → INVALID_ACTION + 完整文案；非 Error 抛出 → String(error)', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
    h.bundleStatus.mockRejectedValueOnce('raw bundle');
    expect(await call('rendererBundleStatus')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw bundle' } });
  });
});
