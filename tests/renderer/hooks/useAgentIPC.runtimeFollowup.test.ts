import { describe, expect, it } from 'vitest';
import {
  getAgentSendFailureMessage,
  getRuntimeFollowupFailureMessage,
  isRuntimeBusyStatus,
} from '../../../src/renderer/hooks/agent/useAgentIPC';

describe('runtime follow-up helpers', () => {
  it('treats active task states as busy', () => {
    expect(isRuntimeBusyStatus('running')).toBe(true);
    expect(isRuntimeBusyStatus('paused')).toBe(true);
    expect(isRuntimeBusyStatus('queued')).toBe(true);
    expect(isRuntimeBusyStatus('cancelling')).toBe(true);
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
});
