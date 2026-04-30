import { describe, expect, it } from 'vitest';
import {
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
});
