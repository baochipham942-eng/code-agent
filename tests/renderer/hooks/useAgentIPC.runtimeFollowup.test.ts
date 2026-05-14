import { describe, expect, it } from 'vitest';
import {
  getAgentSendFailureMessage,
  getRuntimeFollowupFailureMessage,
  getRuntimeInputQueuedMessage,
  isRuntimeBusyStatus,
} from '../../../src/renderer/hooks/agent/useAgentIPC';

describe('runtime follow-up helpers', () => {
  it('treats active task states as busy', () => {
    expect(isRuntimeBusyStatus('running')).toBe(true);
    expect(isRuntimeBusyStatus('paused')).toBe(true);
    expect(isRuntimeBusyStatus('queued')).toBe(true);
    // 'cancelling' 在 commit bce470a2 后从 busy 集合里分离出来：
    // busy = 可接受补充指令的活跃态；cancelling = 不能接，专门走 isRuntimeCancellingStatus
    // 防止用户在 cancelling 期间发补充指令而被静默吞掉。
    expect(isRuntimeBusyStatus('cancelling')).toBe(false);
    expect(isRuntimeBusyStatus('idle')).toBe(false);
    expect(isRuntimeBusyStatus('error')).toBe(false);
  });

  it('keeps Agent not initialized out of the chat-facing copy', () => {
    const message = getRuntimeFollowupFailureMessage(new Error('Agent not initialized'));

    expect(message).toBe('当前任务还没准备好接收补充指令，稍后再发一次。');
    expect(message).not.toContain('Agent not initialized');
    expect(message).not.toContain('中断失败');
  });

  it('uses actionable copy when send-message rejects without an Error message', () => {
    expect(getAgentSendFailureMessage(undefined)).toBe('Error: 消息发送失败，但前端没有收到具体错误。请查看后台日志。');
    expect(getAgentSendFailureMessage(new Error('network down'))).toBe('Error: network down');
  });

  it('uses queued-next-turn copy for runtime inputs', () => {
    expect(getRuntimeInputQueuedMessage('supplement')).toContain('本轮回复结束后作为下一条发送');
    expect(getRuntimeInputQueuedMessage('redirect')).toContain('本轮回复结束后按这条重新处理');
  });
});
