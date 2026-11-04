// N-BGPANEL-STOP-TERMINAL：面板行级动作的 IPC 契约。
// stopBackgroundSession 必须走 AGENT_CANCEL（{ sessionId }——与 StallNoticeLine 的
// 取消同一通道），dismissBackgroundSession 走新增的 BACKGROUND_DISMISS_TERMINAL
// （单 string 参数，web transport 侧包 {sessionId}）。通道或 payload 漂移会让
// 「停止」变成不 cancellation-aware 的孤儿调用、清除打到 404。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeSpy = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeSpy },
}));

import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

beforeEach(() => {
  invokeSpy.mockClear();
});

describe('stopBackgroundSession / dismissBackgroundSession 的通道契约', () => {
  it('stop 走 AGENT_CANCEL + { sessionId }（与既有取消链路同通道）', async () => {
    await useSessionStore.getState().stopBackgroundSession('session-1');

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_CANCEL, { sessionId: 'session-1' });
  });

  it('dismiss 走 BACKGROUND_DISMISS_TERMINAL + 单 string sessionId', async () => {
    await useSessionStore.getState().dismissBackgroundSession('session-1');

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith(IPC_CHANNELS.BACKGROUND_DISMISS_TERMINAL, 'session-1');
  });

  it('失败吞为日志不抛（面板点击不炸）', async () => {
    invokeSpy.mockRejectedValueOnce(new Error('bridge down'));

    await expect(useSessionStore.getState().stopBackgroundSession('session-1')).resolves.toBeUndefined();
    await expect(useSessionStore.getState().dismissBackgroundSession('session-1')).resolves.toBeUndefined();
  });
});
