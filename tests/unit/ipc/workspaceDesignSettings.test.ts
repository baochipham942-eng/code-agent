// ============================================================================
// workspace.ipc — 设计工作区行为偏好 handler（getDesignSettings / updateDesignSettings）
//
// 薄 handler：编排 designSettings 服务。updateDesignSettings 须只接受已知布尔字段，
// 忽略未知键（防 renderer 误传污染落盘 json）。
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../src/host/services/design/designSettings', () => ({
  readDesignSettings: svc.read,
  updateDesignSettings: svc.update,
}));

import {
  handleGetDesignSettings,
  handleUpdateDesignSettings,
} from '../../../src/host/ipc/workspace.ipc';

beforeEach(() => {
  vi.clearAllMocks();
  svc.read.mockResolvedValue({ regionLockStrict: false });
  svc.update.mockImplementation(async (patch: { regionLockStrict?: boolean }) => ({
    regionLockStrict: patch.regionLockStrict ?? false,
  }));
});

describe('handleGetDesignSettings', () => {
  it('透传服务读取结果', async () => {
    svc.read.mockResolvedValue({ regionLockStrict: true });
    expect(await handleGetDesignSettings()).toEqual({ regionLockStrict: true });
  });
});

describe('handleUpdateDesignSettings', () => {
  it('接受合法 regionLockStrict 布尔，落到服务层', async () => {
    const res = await handleUpdateDesignSettings({ regionLockStrict: true });
    expect(svc.update).toHaveBeenCalledWith({ regionLockStrict: true });
    expect(res).toEqual({ regionLockStrict: true });
  });

  it('忽略未知键（只传白名单字段给服务层）', async () => {
    await handleUpdateDesignSettings({
      regionLockStrict: true,
      // @ts-expect-error 故意传未知键，验证被剥离
      evil: 'rm -rf',
      __proto__pollute: 1,
    });
    expect(svc.update).toHaveBeenCalledWith({ regionLockStrict: true });
  });

  it('regionLockStrict 非布尔时不进 patch（空 patch 保留现值语义）', async () => {
    await handleUpdateDesignSettings({ regionLockStrict: 'yes' as unknown as boolean });
    expect(svc.update).toHaveBeenCalledWith({});
  });
});
