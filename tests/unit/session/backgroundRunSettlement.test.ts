// ============================================================================
// BackgroundRunSettlement 决策表（N-RUNINPUT-TOBACKGROUND-OPTION 2026-10-11 rework）
// ============================================================================
// web 直连轮（agent.ts）的终态收线决策：只认 completed 时，max-step 撞顶（error 事件
// 带 MAX_ITERATIONS code）/失败/取消轮会把后台面板 spinner 挂在 running 永不收线
// （无槽验收实测）。决策钉成纯函数，web 路与桌面 TaskManager 共用。

import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';
import {
  resolveBackgroundRunSettlement,
  settleBackgroundRun,
} from '../../../src/host/session/backgroundRunSettlement';

describe('resolveBackgroundRunSettlement（终态 → 收线动作）', () => {
  it('completed → markCompleted（无消息）', () => {
    expect(resolveBackgroundRunSettlement({ status: 'completed' }))
      .toEqual({ action: 'markCompleted' });
  });

  it('interrupted（取消/中断）→ markCompleted + USER_CANCELLED 标记（用户主动停，不算失败）', () => {
    expect(resolveBackgroundRunSettlement({ status: 'interrupted' }))
      .toEqual({ action: 'markCompleted', message: BACKGROUND_TASK_CANCELLED });
  });

  it('error + max-step 撞顶 code → markFailed 传稳定 code（renderer 翻译，不弹英文内部串）', () => {
    expect(resolveBackgroundRunSettlement({
      status: 'error',
      errorMessage: 'Max iterations reached',
      errorCode: RUN_ERROR_CODE_MAX_ITERATIONS,
    })).toEqual({ action: 'markFailed', message: RUN_ERROR_CODE_MAX_ITERATIONS });
  });

  it('error + 普通消息 → markFailed 传原始消息', () => {
    expect(resolveBackgroundRunSettlement({
      status: 'error',
      errorMessage: 'Provider auth failure',
    })).toEqual({ action: 'markFailed', message: 'Provider auth failure' });
  });

  it('error + 无消息 → markFailed 无消息（面板回落默认失败行）', () => {
    expect(resolveBackgroundRunSettlement({ status: 'error' }))
      .toEqual({ action: 'markFailed', message: undefined });
  });
});

describe('settleBackgroundRun（动作分发）', () => {
  it('markFailed 分支 → markFailed(sessionId, message)', () => {
    const manager = { markCompleted: vi.fn(), markFailed: vi.fn() };
    void settleBackgroundRun(manager, 's1', { action: 'markFailed', message: 'boom' });
    expect(manager.markFailed).toHaveBeenCalledWith('s1', 'boom');
    expect(manager.markCompleted).not.toHaveBeenCalled();
  });

  it('markCompleted 分支 → await markCompleted(sessionId, message)', async () => {
    const manager = { markCompleted: vi.fn().mockResolvedValue(undefined), markFailed: vi.fn() };
    await settleBackgroundRun(manager, 's1', { action: 'markCompleted', message: BACKGROUND_TASK_CANCELLED });
    expect(manager.markCompleted).toHaveBeenCalledWith('s1', BACKGROUND_TASK_CANCELLED);
    expect(manager.markFailed).not.toHaveBeenCalled();
  });
});
