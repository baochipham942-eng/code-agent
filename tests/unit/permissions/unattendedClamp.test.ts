// ============================================================================
// B1 ③ 无人值守（cron/automation）会话权限档钳制测试
// ============================================================================
// 钳制单点在 PermissionModeManager.getModeForSession：
// unattended 会话的权限档不得高于 acceptEdits（bypass→acceptEdits）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

import {
  getPermissionModeManager,
  resetPermissionModeManager,
  clampUnattendedPermissionMode,
} from '../../../src/host/permissions/modes';

describe('无人值守会话权限档钳制', () => {
  beforeEach(() => resetPermissionModeManager());
  afterEach(() => resetPermissionModeManager());

  it('用户全局开 bypass 时，cron 会话解析为 acceptEdits（真险情回归）', () => {
    const manager = getPermissionModeManager();
    manager.setMode('bypassPermissions', true); // 用户当前档 = bypass
    manager.markUnattendedSession('cron-session');
    manager.initSessionMode('cron-session'); // 会话创建收口：快照 + 钳制在读取处
    expect(manager.getModeForSession('cron-session')).toBe('acceptEdits');
  });

  it('普通（有人值守）会话不受钳制，保持 bypass', () => {
    const manager = getPermissionModeManager();
    manager.setMode('bypassPermissions', true);
    manager.initSessionMode('chat-session');
    expect(manager.getModeForSession('chat-session')).toBe('bypassPermissions');
  });

  it('unattended 会话即使显式设置 bypass（已审批）也被钳到 acceptEdits', () => {
    const manager = getPermissionModeManager();
    manager.markUnattendedSession('cron-session');
    manager.setSessionMode('cron-session', 'bypassPermissions', true);
    expect(manager.getModeForSession('cron-session')).toBe('acceptEdits');
  });

  it('钳制只压 bypass：readOnly / default / acceptEdits 原样通过', () => {
    const manager = getPermissionModeManager();
    manager.markUnattendedSession('cron-session');
    for (const mode of ['readOnly', 'default', 'acceptEdits'] as const) {
      manager.setSessionMode('cron-session', mode);
      expect(manager.getModeForSession('cron-session')).toBe(mode);
    }
  });

  it('clampUnattendedPermissionMode 纯函数语义', () => {
    expect(clampUnattendedPermissionMode('bypassPermissions')).toBe('acceptEdits');
    expect(clampUnattendedPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(clampUnattendedPermissionMode('readOnly')).toBe('readOnly');
    expect(clampUnattendedPermissionMode('default')).toBe('default');
  });
});
