import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  sessionVerified: false,
  adminService: {
    listUsers: vi.fn(),
    listInviteCodes: vi.fn(),
    createInviteCode: vi.fn(),
    updateInviteCode: vi.fn(),
    listControlPlaneAuditEvents: vi.fn(),
    listControlPlaneRolloutSummary: vi.fn(),
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

type DomainHandler = (_: unknown, request: unknown) => Promise<IPCResponse>;

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
    vi.unstubAllEnvs();
    mocks.currentUser = null;
    mocks.sessionVerified = false;
    mocks.adminService.listUsers.mockResolvedValue({ users: [] });
    mocks.adminService.listControlPlaneAuditEvents.mockResolvedValue({ events: [] });
    mocks.adminService.listControlPlaneRolloutSummary.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('allows admin users to read control-plane audit surfaces', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    mocks.adminService.listControlPlaneAuditEvents.mockResolvedValue({
      events: [{ id: 'audit-1', artifactKind: 'cloud_config', outcome: 'served', statusCode: 200 }],
    });
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'listControlPlaneAuditEvents',
      payload: { limit: 25 },
    });

    expect(response).toMatchObject({
      success: true,
      data: { events: [{ id: 'audit-1', artifactKind: 'cloud_config' }] },
    });
    expect(mocks.adminService.listControlPlaneAuditEvents).toHaveBeenCalledWith(25);
  });

  it('treats explicit local web test mode as an admin environment', async () => {
    vi.stubEnv('CODE_AGENT_WEB_MODE', 'true');
    vi.stubEnv('CODE_AGENT_E2E', '1');
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

  it('rejects malformed create invite code payloads before calling admin services', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'createInviteCode',
      payload: { label: 'Beta', maxUses: '3' },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect(mocks.adminService.createInviteCode).not.toHaveBeenCalled();
  });

  it('rejects malformed update invite code payloads before calling admin services', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'updateInviteCode',
      payload: { id: 42, isActive: true },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect(mocks.adminService.updateInviteCode).not.toHaveBeenCalled();
  });

  it('rejects malformed control-plane audit event limits before calling admin services', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerAdminHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'listControlPlaneAuditEvents',
      payload: { limit: '80' },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect(mocks.adminService.listControlPlaneAuditEvents).not.toHaveBeenCalled();
  });
});
