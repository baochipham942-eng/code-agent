import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// roles.ipc.ts 派发特征测试（RQ-183 续作·ROLES 刀迁表前钉住现状）：派发层共 22 个 action，既有 rolesIpc.test.ts 覆盖 list /
// detail / 记忆 / 绑定 / 主动性 / 视觉 / 装备 / 定义正文 / 恢复出厂等 14 个，且未知 action 只断言 code。这里补齐其余 8 个：
// updatePersonalization 四条校验与写入形状、草稿队列 listDrafts / confirmDraft / rejectDraft（含 CONFIRM_FAILED /
// REJECT_FAILED 缺省文案）、rolePack 四件套（缺 roleId 与动态 import 委派）、未知 action 的完整文案
// 'Unknown roles action:'，以及抛错兜底 ROLES_ERROR（Error → message、非 Error → 'Unknown error'，记 error 日志）。
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: unknown, request: IPCRequest) => Promise<IPCResponse>),
  logError: vi.fn(),
  writePersonalization: vi.fn(),
  listDrafts: vi.fn(async () => [{ draftId: 'd1' }]),
  confirmDraft: vi.fn(async (..._a: unknown[]) => ({ success: true, roleId: 'r1' }) as { success: boolean; error?: string; roleId?: string }),
  rejectDraft: vi.fn(async (..._a: unknown[]) => ({ success: true }) as { success: boolean; error?: string }),
  listRolePacks: vi.fn(async () => [{ roleId: 'pack-a' }]),
  installRolePack: vi.fn(async (..._a: unknown[]) => ({ installed: true })),
  uninstallRolePack: vi.fn(async (..._a: unknown[]) => ({ uninstalled: true })),
  retryMissingSkills: vi.fn(async (..._a: unknown[]) => ({ retried: 2 })),
}));

vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/infra/logger')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));
vi.mock('../../../src/host/services/roleAssets/rolePersonalization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/roleAssets/rolePersonalization')>()),
  writeRolePersonalization: (...a: unknown[]) => h.writePersonalization(...a),
}));
vi.mock('../../../src/host/services/roleAssets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/roleAssets')>()),
  listRoleDrafts: () => h.listDrafts(),
  confirmRoleDraft: (...a: unknown[]) => h.confirmDraft(...a),
  rejectRoleDraft: (...a: unknown[]) => h.rejectDraft(...a),
}));
vi.mock('../../../src/host/services/roleAssets/rolePackInstallService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/roleAssets/rolePackInstallService')>()),
  listRolePacks: () => h.listRolePacks(),
  installRolePack: (...a: unknown[]) => h.installRolePack(...a),
  uninstallRolePack: (...a: unknown[]) => h.uninstallRolePack(...a),
  retryMissingSkills: (...a: unknown[]) => h.retryMissingSkills(...a),
}));

import { registerRolesHandlers } from '../../../src/host/ipc/roles.ipc';

const call = (action: string, payload?: unknown) => h.handler!(null, { action, payload } as IPCRequest);
const invalid = (message: string) => ({ success: false, error: { code: 'INVALID_ARGS', message } });

beforeEach(() => {
  vi.clearAllMocks();
  h.handler = undefined;
  registerRolesHandlers({
    handle: (_ch: string, fn: typeof h.handler) => {
      h.handler = fn;
    },
  } as never);
});

describe('roles.ipc dispatch 特征：个性化', () => {
  it('updatePersonalization：四条校验逐字；只把传入的字段写下去', async () => {
    expect(await call('updatePersonalization', { soul: 's' })).toEqual(invalid('roleId is required'));
    expect(await call('updatePersonalization', { roleId: 'r1' })).toEqual(invalid('nothing to update'));
    expect(await call('updatePersonalization', { roleId: 'r1', soul: 3 })).toEqual(invalid('userExpectation and soul must be strings'));
    expect(await call('updatePersonalization', { roleId: 'r1', boundaries: { disallowExternalSending: 'yes' } }))
      .toEqual(invalid('boundaries.disallowExternalSending must be a boolean'));
    expect(await call('updatePersonalization', { roleId: 'r1', boundaries: null })).toEqual(invalid('boundaries.disallowExternalSending must be a boolean'));
    expect(h.writePersonalization).not.toHaveBeenCalled();
    expect(await call('updatePersonalization', { roleId: 'r1', soul: '沉稳', boundaries: { disallowExternalSending: true } }))
      .toEqual({ success: true, data: { updated: true } });
    expect(h.writePersonalization).toHaveBeenCalledWith('r1', { soul: '沉稳', boundaries: { disallowExternalSending: true } });
  });
});

describe('roles.ipc dispatch 特征：草稿队列', () => {
  it('listDrafts 透传；confirmDraft / rejectDraft 缺 draftId → INVALID_ARGS', async () => {
    expect(await call('listDrafts')).toEqual({ success: true, data: [{ draftId: 'd1' }] });
    expect(await call('confirmDraft', {})).toEqual(invalid('draftId is required'));
    expect(await call('rejectDraft')).toEqual(invalid('draftId is required'));
    expect(h.confirmDraft).not.toHaveBeenCalled();
  });

  it('confirmDraft：成功回传整个结果；失败 → CONFIRM_FAILED，缺省文案 confirm failed', async () => {
    expect(await call('confirmDraft', { draftId: 'd1' })).toEqual({ success: true, data: { success: true, roleId: 'r1' } });
    expect(h.confirmDraft).toHaveBeenCalledWith('d1');
    h.confirmDraft.mockResolvedValueOnce({ success: false, error: 'name taken' });
    expect(await call('confirmDraft', { draftId: 'd1' })).toEqual({ success: false, error: { code: 'CONFIRM_FAILED', message: 'name taken' } });
    h.confirmDraft.mockResolvedValueOnce({ success: false });
    expect(await call('confirmDraft', { draftId: 'd1' })).toEqual({ success: false, error: { code: 'CONFIRM_FAILED', message: 'confirm failed' } });
  });

  it('rejectDraft：成功回传；失败 → REJECT_FAILED，缺省文案 reject failed', async () => {
    expect(await call('rejectDraft', { draftId: 'd2' })).toEqual({ success: true, data: { success: true } });
    expect(h.rejectDraft).toHaveBeenCalledWith('d2');
    h.rejectDraft.mockResolvedValueOnce({ success: false });
    expect(await call('rejectDraft', { draftId: 'd2' })).toEqual({ success: false, error: { code: 'REJECT_FAILED', message: 'reject failed' } });
  });
});

describe('roles.ipc dispatch 特征：角色包', () => {
  it('rolePackList 透传；Install / Uninstall / RetryMissingSkills 缺 roleId → INVALID_ARGS 且不调服务', async () => {
    expect(await call('rolePackList')).toEqual({ success: true, data: [{ roleId: 'pack-a' }] });
    for (const action of ['rolePackInstall', 'rolePackUninstall', 'rolePackRetryMissingSkills']) {
      expect(await call(action, {})).toEqual(invalid('roleId is required'));
    }
    expect(h.installRolePack).not.toHaveBeenCalled();
    expect(h.uninstallRolePack).not.toHaveBeenCalled();
    expect(h.retryMissingSkills).not.toHaveBeenCalled();
  });

  it('rolePackInstall 透传提权两个开关；Uninstall / RetryMissingSkills 透传 roleId', async () => {
    expect(await call('rolePackInstall', { roleId: 'pack-a', acceptElevation: true, elevationReviewed: false }))
      .toEqual({ success: true, data: { installed: true } });
    expect(h.installRolePack).toHaveBeenCalledWith('pack-a', { acceptElevation: true, elevationReviewed: false });
    expect(await call('rolePackUninstall', { roleId: 'pack-a' })).toEqual({ success: true, data: { uninstalled: true } });
    expect(h.uninstallRolePack).toHaveBeenCalledWith('pack-a');
    expect(await call('rolePackRetryMissingSkills', { roleId: 'pack-a' })).toEqual({ success: true, data: { retried: 2 } });
    expect(h.retryMissingSkills).toHaveBeenCalledWith('pack-a');
  });
});

describe('roles.ipc dispatch 特征：兜底', () => {
  it('未知 action → UNKNOWN_ACTION + Unknown roles action 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown roles action: bogus' } });
  });

  it('抛错 → ROLES_ERROR（Error → message、非 Error → Unknown error）并记 error 日志', async () => {
    h.listDrafts.mockRejectedValueOnce(new Error('queue locked'));
    expect(await call('listDrafts')).toEqual({ success: false, error: { code: 'ROLES_ERROR', message: 'queue locked' } });
    expect(h.logError).toHaveBeenLastCalledWith('Roles IPC error', expect.any(Error));
    h.listRolePacks.mockRejectedValueOnce('boom');
    expect(await call('rolePackList')).toEqual({ success: false, error: { code: 'ROLES_ERROR', message: 'Unknown error' } });
    expect(h.logError).toHaveBeenLastCalledWith('Roles IPC error', 'boom');
  });
});
