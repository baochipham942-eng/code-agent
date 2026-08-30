import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({
  isAdmin: true,
  confirm: vi.fn(async (_token: string) => ({
    id: 'evaluation-center',
    version: '1.0.0',
    toolNames: [],
    surface: 'internal-feature' as const,
  })),
}));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => state.isAdmin,
}));

vi.mock('../../../src/host/services/capabilities/manualCapabilityPackageService', () => ({
  getManualCapabilityPackageService: () => ({
    confirm: (token: string) => state.confirm(token),
    list: vi.fn(async () => []),
    discard: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
  }),
}));

import { registerCapabilityPackageHandlers } from '../../../src/host/ipc/capabilityPackage.ipc';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
let handlers: Map<string, Handler>;

beforeEach(() => {
  vi.clearAllMocks();
  state.isAdmin = true;
  handlers = new Map();
  registerCapabilityPackageHandlers(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    () => null,
  );
});

describe('internal capability package admin gate', () => {
  it('rejects confirm for a regular user before touching the installer', async () => {
    state.isAdmin = false;
    const result = await handlers.get(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM)?.(null, 'token');
    expect(result).toEqual({ success: false, error: '导入能力包需要管理员权限' });
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('allows a verified administrator to confirm the internal package', async () => {
    const result = await handlers.get(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM)?.(null, 'token');
    expect(result).toEqual({
      success: true,
      data: {
        id: 'evaluation-center',
        version: '1.0.0',
        toolNames: [],
        surface: 'internal-feature',
      },
    });
    expect(state.confirm).toHaveBeenCalledWith('token');
  });
});
