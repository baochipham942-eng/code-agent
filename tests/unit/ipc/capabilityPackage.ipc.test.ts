import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({
  stagedSources: new Map<string, 'bundled' | 'local'>(),
  installedSources: new Map<string, 'bundled' | 'local'>(),
  confirm: vi.fn(async (_token: string, _approveFutureVersions = false) => ({
    id: 'evaluation-center',
    version: '1.0.0',
    toolNames: [],
    surface: 'internal-feature' as const,
  })),
  stageBundled: vi.fn(async (pluginId: string) => ({
    token: `token:${pluginId}`,
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    description: 'builtin',
    permissions: [],
    toolNames: [],
    surface: 'tools' as const,
    sourceKind: 'bundled' as const,
    sourceLabel: 'Agent Neo',
    sandbox: { passed: true, summary: 'verified' },
    expiresAt: Date.now() + 60_000,
  })),
  discard: vi.fn(async (_token: string) => undefined),
  reject: vi.fn(async (_token: string) => undefined),
  runPackage: vi.fn(async (pluginId: string, packageId: string) => ({
    id: pluginId,
    packageId,
    version: '1.0.0',
    toolNames: [],
    surface: 'tools' as const,
  })),
  listPendingApprovals: vi.fn(async () => []),
  uninstall: vi.fn(async (_pluginId: string) => undefined),
  list: vi.fn(async () => []),
}));

vi.mock('../../../src/host/services/capabilities/manualCapabilityPackageService', () => ({
  getManualCapabilityPackageService: () => ({
    confirm: (token: string, approveFutureVersions?: boolean) => state.confirm(token, approveFutureVersions),
    list: () => state.list(),
    listPendingApprovals: () => state.listPendingApprovals(),
    stageBundled: (pluginId: string) => state.stageBundled(pluginId),
    getStagedPackageSource: vi.fn(async (token: string) => state.stagedSources.get(token) ?? null),
    getInstalledPackageSource: vi.fn(async (pluginId: string) => state.installedSources.get(pluginId) ?? null),
    discard: (token: string) => state.discard(token),
    reject: (token: string) => state.reject(token),
    runPackage: (pluginId: string, packageId: string) => state.runPackage(pluginId, packageId),
    uninstall: (pluginId: string) => state.uninstall(pluginId),
  }),
}));

import { registerCapabilityPackageHandlers } from '../../../src/host/ipc/capabilityPackage.ipc';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
let handlers: Map<string, Handler>;
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args);

beforeEach(() => {
  vi.clearAllMocks();
  state.stagedSources.clear();
  state.installedSources.clear();
  handlers = new Map();
  registerCapabilityPackageHandlers(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    () => null,
  );
});

describe('capability package source authorization', () => {
  it('allows regular users to list the source-filtered package inventory', async () => {
    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST)).toEqual({ success: true, data: [] });
    expect(state.list).toHaveBeenCalledOnce();
  });

  it.each([
    ['builtin-token', 'bundled'],
    ['local-token', 'local'],
  ] as const)('allows a regular user to confirm a %s source after preview', async (token, source) => {
    state.stagedSources.set(token, source);

    const result = await call(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM, token);

    expect(result).toEqual({
      success: true,
      data: {
        id: 'evaluation-center',
        version: '1.0.0',
        toolNames: [],
        surface: 'internal-feature',
      },
    });
    expect(state.confirm).toHaveBeenCalledWith(token, false);
  });

  it('rejects an unknown confirmation token before touching the installer', async () => {
    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM, 'forged-token')).toEqual({
      success: false,
      error: '插件确认来源无效或已过期',
    });
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('allows cancelling only a server-staged preview token', async () => {
    state.stagedSources.set('local-token', 'local');
    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_CANCEL, 'local-token')).toEqual({
      success: true,
      data: undefined,
    });
    expect(state.reject).toHaveBeenCalledWith('local-token');

    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_CANCEL, 'forged-token')).toEqual({
      success: false,
      error: '插件确认来源无效或已过期',
    });
    expect(state.reject).toHaveBeenCalledTimes(1);
  });

  it('exposes the framework approval queue and forwards the explicit future-version choice', async () => {
    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_APPROVAL_LIST)).toEqual({ success: true, data: [] });
    state.stagedSources.set('local-token', 'local');
    await call(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM, 'local-token', true);
    expect(state.confirm).toHaveBeenCalledWith('local-token', true);
  });

  it('runs an already approved immutable version by identity', async () => {
    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_RUN, 'plugin-a', 'package-a')).toMatchObject({
      success: true,
      data: { id: 'plugin-a', packageId: 'package-a' },
    });
    expect(state.runPackage).toHaveBeenCalledWith('plugin-a', 'package-a');
  });

  it('allows only the eight first-party ids through bundled staging', async () => {
    const result = await call(IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_BUNDLED, 'builtin.imageProcess');
    expect(result).toMatchObject({ success: true, data: { id: 'builtin.imageProcess', sourceKind: 'bundled' } });
    expect(state.stageBundled).toHaveBeenCalledWith('builtin.imageProcess');

    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_BUNDLED, 'third-party.plugin')).toEqual({
      success: false,
      error: '只允许安装 Neo 内置插件',
    });
    expect(state.stageBundled).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['builtin.imageProcess', 'bundled'],
    ['local.web-research', 'local'],
  ] as const)('allows uninstall for a verified %s source', async (pluginId, source) => {
    state.installedSources.set(pluginId, source);
    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_UNINSTALL, pluginId)).toEqual({
      success: true,
      data: undefined,
    });
    expect(state.uninstall).toHaveBeenCalledWith(pluginId);
  });

  it('rejects uninstall when the object is neither first-party nor locally approved', async () => {
    expect(await call(IPC_CHANNELS.CAPABILITY_PACKAGE_UNINSTALL, 'foreign.plugin')).toEqual({
      success: false,
      error: '只允许卸载 Neo 内置或本机导入的插件',
    });
    expect(state.uninstall).not.toHaveBeenCalled();
  });
});
