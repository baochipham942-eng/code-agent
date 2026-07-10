// ============================================================================
// B1 ③ 无人值守（cron/automation）会话权限档钳制测试
// ============================================================================
// 钳制单点在 PermissionModeManager.getModeForSession：
// unattended 会话的权限档不得高于 acceptEdits（bypass→acceptEdits）。

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

import {
  getPermissionModeManager,
  resetPermissionModeManager,
  clampUnattendedPermissionMode,
  permissionModeAutoApproves,
} from '../../../src/host/permissions/modes';

// 会话档持久化落 CODE_AGENT_DATA_DIR：测试指到临时目录，不污染真实用户目录。
const tmpDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'b1-unattended-'));
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
afterAll(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('无人值守会话权限档钳制', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    fs.rmSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), { force: true });
  });
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

  it('isUnattendedSession：bash OS 沙箱围栏据此判定，钳制档位不等于撤围栏（审出 MED）', () => {
    const manager = getPermissionModeManager();
    manager.markUnattendedSession('cron-session');
    expect(manager.isUnattendedSession('cron-session')).toBe(true);
    expect(manager.isUnattendedSession('chat-session')).toBe(false);
    expect(manager.isUnattendedSession(undefined)).toBe(false);
  });

  it('permissionModeAutoApproves：acceptEdits 只免确认写入，与 bypass 拉开差距（钳制不空转，审出 MED）', () => {
    // bypass：写入 + 执行免确认
    expect(permissionModeAutoApproves('bypassPermissions', 'write')).toBe(true);
    expect(permissionModeAutoApproves('bypassPermissions', 'execute')).toBe(true);
    expect(permissionModeAutoApproves('bypassPermissions', 'network')).toBe(false);
    // acceptEdits：仅写入免确认 —— cron 钳制 bypass→acceptEdits 后执行档真正收窄
    expect(permissionModeAutoApproves('acceptEdits', 'write')).toBe(true);
    expect(permissionModeAutoApproves('acceptEdits', 'execute')).toBe(false);
    // 其余档一律不免
    expect(permissionModeAutoApproves('default', 'write')).toBe(false);
    expect(permissionModeAutoApproves('readOnly', 'write')).toBe(false);
  });
});
