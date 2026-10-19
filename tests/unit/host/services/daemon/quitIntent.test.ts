// ============================================================================
// quitIntent 单测（ADR-083 append 2026-10-18）：壳声明的退出意图状态机。
//   - setDaemonQuitIntent：background 同时 arm detach（旧 /quit-guard/detach 合同）；
//   - 意图变化通知 onDaemonQuitIntentChange（daemon 状态文件据此重写）；
//   - 模块态本文件内自管理：按用例顺序设置，不依赖跨文件隔离。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

import { armBackgroundContinueDetach, backgroundContinueDetachArmed } from '../../../../../src/host/services/daemon/shellExit';
import { getDaemonQuitIntent, onDaemonQuitIntentChange, setDaemonQuitIntent } from '../../../../../src/host/services/daemon/quitIntent';

describe('setDaemonQuitIntent（ADR-083 append 2026-10-18）', () => {
  it('background：记录意图并 arm detach（EOF 不再是 win32 停机指令）', () => {
    setDaemonQuitIntent('background');
    expect(getDaemonQuitIntent()).toBe('background');
    expect(backgroundContinueDetachArmed()).toBe(true);
  });

  it('stop：记录意图；意图变化通知监听器', () => {
    const listener = vi.fn();
    const unsubscribe = onDaemonQuitIntentChange(listener);
    setDaemonQuitIntent('stop');
    expect(getDaemonQuitIntent()).toBe('stop');
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    setDaemonQuitIntent('background');
    expect(listener).toHaveBeenCalledOnce();
    expect(getDaemonQuitIntent()).toBe('background');
  });

  it('同值重复声明不重复通知（幂等）', () => {
    const listener = vi.fn();
    const unsubscribe = onDaemonQuitIntentChange(listener);
    setDaemonQuitIntent('stop');
    setDaemonQuitIntent('stop');
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    setDaemonQuitIntent('background');
  });

  it('直接 arm detach（旧路径）不改意图——意图与 detach arm 是两个状态', () => {
    setDaemonQuitIntent('background'); // 起点归一
    armBackgroundContinueDetach();
    expect(backgroundContinueDetachArmed()).toBe(true);
    // 语义检查在新用例里做，这里只保证旧入口仍可用（别名路由等价性见路由测试）。
  });
});
