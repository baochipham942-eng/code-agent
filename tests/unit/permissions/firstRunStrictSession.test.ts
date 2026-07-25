// ============================================================================
// 云货架专家首跑最严档 —— 主 agent 路径的钳制门
// ============================================================================
//
// 2026-07-25 真机 dogfood 判 NO-GO 的那条：PR #690 把「首跑强制 strict」钩在
// subagentExecutor 上，而用户在输入框选中专家后说话，专家是**作为主 agent** 跑的
// （preferredAgentId → 路由），根本不经过那条路。净效果：两轮行为无差别、
// 文件直接落盘、firstRunPending 永远是 true。
//
// 主 agent 的档位单一真源是 PermissionModeManager.getModeForSession()，
// 它已经有一处同构钳制（无人值守 → clampUnattendedPermissionMode）。首跑走同一形状。
//
// 本门钉的是「钳制真的发生」，不是「标记被写进去了」——上一版就是只测了台账侧才漏的。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampFirstRunPermissionMode,
  getPermissionModeManager,
  permissionModeAutoApproves,
  type PermissionMode,
} from '../../../src/host/permissions/modes';

describe('云货架专家首跑：主 agent 档位钳制', () => {
  const manager = getPermissionModeManager();
  let sessionId: string;

  beforeEach(() => {
    sessionId = `first-run-${Math.random().toString(36).slice(2)}`;
  });

  // 免确认的两档就是「用户看不到审批弹窗」的来源——首跑必须把它们摁掉。
  it.each<[PermissionMode]>([
    ['bypassPermissions'],
    ['acceptEdits'],
  ])('会话档是 %s 时，首跑钳制后不再有任何免确认', (mode) => {
    manager.setSessionMode(sessionId, mode, true);
    expect(permissionModeAutoApproves(manager.getModeForSession(sessionId), 'write')).toBe(true);

    manager.markFirstRunStrictSession(sessionId);

    const clamped = manager.getModeForSession(sessionId);
    expect(permissionModeAutoApproves(clamped, 'write')).toBe(false);
    expect(permissionModeAutoApproves(clamped, 'execute')).toBe(false);
  });

  it('清除标记后回到会话自己的档位（第二轮不该还被钳着）', () => {
    manager.setSessionMode(sessionId, 'acceptEdits', true);
    manager.markFirstRunStrictSession(sessionId);
    expect(permissionModeAutoApproves(manager.getModeForSession(sessionId), 'write')).toBe(false);

    manager.clearFirstRunStrictSession(sessionId);

    expect(manager.getModeForSession(sessionId)).toBe('acceptEdits');
    expect(permissionModeAutoApproves(manager.getModeForSession(sessionId), 'write')).toBe(true);
  });

  it('未标记的会话不受影响（不误伤所有人）', () => {
    manager.setSessionMode(sessionId, 'acceptEdits', true);
    expect(manager.getModeForSession(sessionId)).toBe('acceptEdits');
  });

  // 纯函数单独钉一遍：钳制方向只能更严，不能把已经很严的档放宽。
  it('钳制函数只收紧不放宽', () => {
    expect(permissionModeAutoApproves(clampFirstRunPermissionMode('bypassPermissions'), 'execute')).toBe(false);
    expect(permissionModeAutoApproves(clampFirstRunPermissionMode('acceptEdits'), 'write')).toBe(false);
    expect(clampFirstRunPermissionMode('plan')).toBe('plan');
    expect(clampFirstRunPermissionMode('readOnly')).toBe('readOnly');
  });
});
