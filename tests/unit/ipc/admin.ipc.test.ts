import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  sessionVerified: false,
  adminService: {
    listUsers: vi.fn(),
    listInviteCodes: vi.fn(),
    createInviteCode: vi.fn(),
    updateInviteCode: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
    hasVerifiedSession: () => mocks.sessionVerified,
  }),
}));

vi.mock('../../../src/main/services/admin', () => ({
  getAdminService: () => mocks.adminService,
}));

import { registerAdminHandlers } from '../../../src/main/ipc/admin.ipc';

type DomainHandler = (_: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, fn: DomainHandler) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    getHandler: () => {
      const fn = registry.get(IPC_DOMAINS.ADMIN);
      if (!fn) throw new Error('ADMIN handler not registered');
      return fn;
    },
  };
}

describe('admin.ipc access control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = null;
    mocks.sessionVerified = false;
    mocks.adminService.listUsers.mockResolvedValue({ users: [] });
  });

  it('rejects unauthenticated users before calling admin services', async () => {
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'listUsers' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.adminService.listUsers).not.toHaveBeenCalled();
  });

  it('rejects authenticated non-admin users', async () => {
    mocks.currentUser = { id: 'user-1', email: 'user@example.com', isAdmin: false };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'listInviteCodes' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.adminService.listInviteCodes).not.toHaveBeenCalled();
  });

  it('rejects cached admin users until the session is verified', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = false;
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'listUsers' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.adminService.listUsers).not.toHaveBeenCalled();
  });

  it('allows admin users to call the admin service', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    mocks.adminService.listUsers.mockResolvedValue({
      users: [{ id: 'user-1', email: 'user@example.com', isAdmin: false }],
    });
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'listUsers' });

    expect(response).toMatchObject({
      success: true,
      data: { users: [{ id: 'user-1', email: 'user@example.com', isAdmin: false }] },
    });
    expect(mocks.adminService.listUsers).toHaveBeenCalledOnce();
  });
});
