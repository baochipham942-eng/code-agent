// ============================================================================
// 无人值守（cron/automation）独立权限档测试
// ============================================================================
// 钳制单点在 PermissionModeManager.getModeForSession：
// unattended 会话不继承 UI 档，统一解析为内部 unattended 档。

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
import {
  readOnlyForcesConfirmationFor,
  resolveToolPermissionClassification,
} from '../../../src/host/tools/toolPermissionClassification';

// 会话档持久化落 CODE_AGENT_DATA_DIR：测试指到临时目录，不污染真实用户目录。
const tmpDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'b1-unattended-'));
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
afterAll(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('无人值守会话独立权限档', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    fs.rmSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), { force: true });
  });
  afterEach(() => resetPermissionModeManager());

  it('用户全局开 bypass 时，cron 会话仍解析为独立 unattended 档', () => {
    const manager = getPermissionModeManager();
    manager.setMode('bypassPermissions', true); // 用户当前档 = bypass
    manager.markUnattendedSession('cron-session');
    manager.initSessionMode('cron-session'); // 会话创建收口：快照 + 钳制在读取处
    expect(manager.getModeForSession('cron-session')).toBe('unattended');
  });

  it('普通（有人值守）会话不受钳制，保持 bypass', () => {
    const manager = getPermissionModeManager();
    manager.setMode('bypassPermissions', true);
    manager.initSessionMode('chat-session');
    expect(manager.getModeForSession('chat-session')).toBe('bypassPermissions');
  });

  it('unattended 会话即使显式设置 bypass（已审批）也不继承该交互档', () => {
    const manager = getPermissionModeManager();
    manager.markUnattendedSession('cron-session');
    manager.setSessionMode('cron-session', 'bypassPermissions', true);
    expect(manager.getModeForSession('cron-session')).toBe('unattended');
  });

  it('无论 UI 基档是 readOnly/default/acceptEdits，运行档只有一个答案', () => {
    const manager = getPermissionModeManager();
    manager.markUnattendedSession('cron-session');
    for (const mode of ['readOnly', 'default', 'acceptEdits'] as const) {
      manager.setSessionMode('cron-session', mode);
      expect(manager.getModeForSession('cron-session')).toBe('unattended');
    }
  });

  it('clampUnattendedPermissionMode 纯函数语义', () => {
    expect(clampUnattendedPermissionMode('bypassPermissions')).toBe('unattended');
    expect(clampUnattendedPermissionMode('acceptEdits')).toBe('unattended');
    expect(clampUnattendedPermissionMode('readOnly')).toBe('unattended');
    expect(clampUnattendedPermissionMode('default')).toBe('unattended');
  });

  it('isUnattendedSession：bash OS 沙箱围栏据此判定，钳制档位不等于撤围栏（审出 MED）', () => {
    const manager = getPermissionModeManager();
    manager.markUnattendedSession('cron-session');
    expect(manager.isUnattendedSession('cron-session')).toBe(true);
    expect(manager.isUnattendedSession('chat-session')).toBe(false);
    expect(manager.isUnattendedSession(undefined)).toBe(false);
  });

  it('unattended 对沙箱内写入、执行、联网免确认，但不放行 dangerous/admin', () => {
    // bypass：写入 + 执行免确认
    expect(permissionModeAutoApproves('bypassPermissions', 'write')).toBe(true);
    expect(permissionModeAutoApproves('bypassPermissions', 'execute')).toBe(true);
    expect(permissionModeAutoApproves('bypassPermissions', 'network')).toBe(false);
    // acceptEdits：仅写入免确认 —— cron 钳制 bypass→acceptEdits 后执行档真正收窄
    expect(permissionModeAutoApproves('acceptEdits', 'write')).toBe(true);
    expect(permissionModeAutoApproves('acceptEdits', 'execute')).toBe(false);
    expect(permissionModeAutoApproves('unattended', 'write')).toBe(true);
    expect(permissionModeAutoApproves('unattended', 'execute')).toBe(true);
    expect(permissionModeAutoApproves('unattended', 'network')).toBe(true);
    expect(permissionModeAutoApproves('unattended', 'dangerous')).toBe(false);
    expect(permissionModeAutoApproves('unattended', 'admin')).toBe(false);
    // 其余档一律不免
    expect(permissionModeAutoApproves('default', 'write')).toBe(false);
    expect(permissionModeAutoApproves('readOnly', 'write')).toBe(false);
  });

  it('unattended 是内部派生档，不能被人工设置到全局或普通会话', () => {
    const manager = getPermissionModeManager();
    expect(manager.setMode('unattended')).toBe(false);
    expect(manager.setSessionMode('chat-session', 'unattended')).toBe(false);
    expect(manager.getModeForSession('chat-session')).toBe('default');
  });

  it('工作区外写入属于信任边界，unattended 不把该 ask 升成 allow', async () => {
    const result = await resolveToolPermissionClassification({
      executionToolName: 'Write',
      policyToolName: 'Write',
      params: { file_path: '/Users/linchen/outside/note.txt', content: 'blocked' },
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory: '/tmp/workspace',
      workspaceRoot: '/tmp/workspace',
      permissionLevel: 'write',
      permStartTime: 0,
      readOnlyForcesConfirmation: readOnlyForcesConfirmationFor('unattended', {
        requiresPermission: true,
        permissionLevel: 'write',
      }),
      sessionPermissionMode: 'unattended',
    });

    expect(result.decision).toBe('ask');
    expect(result.trustBoundary).toBe(true);
  });

  it('对外副作用与 network 正交，unattended 不把发邮件的 ask 升成 allow', async () => {
    const result = await resolveToolPermissionClassification({
      executionToolName: 'mail_send',
      policyToolName: 'mail_send',
      params: { to: ['outside@example.com'], subject: 'test', body: 'test' },
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory: '/tmp/workspace',
      workspaceRoot: '/tmp/workspace',
      permissionLevel: 'network',
      permStartTime: 0,
      readOnlyForcesConfirmation: false,
      sessionPermissionMode: 'unattended',
    });

    expect(result.external).toBe(true);
    expect(result.decision).toBe('ask');
  });
});
