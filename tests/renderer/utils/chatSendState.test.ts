import { afterEach, describe, expect, it } from 'vitest';
import {
  chatSendInflightKey,
  claimSendInflight,
  isChatSendAccepted,
  resetChatSendInflightForTests,
  type ChatSendDelivery,
} from '../../../src/renderer/utils/chatSendState';

describe('chatSendState inflight 幂等', () => {
  afterEach(() => {
    resetChatSendInflightForTests();
  });

  it('同一 clientMessageId 并发只启动一次，第二次共用第一次的 Promise', async () => {
    let starts = 0;
    let release!: (value: ChatSendDelivery) => void;
    const first = claimSendInflight('session-1:msg-1', () => {
      starts += 1;
      return new Promise<ChatSendDelivery>((resolve) => {
        release = resolve;
      });
    });
    const second = claimSendInflight('session-1:msg-1', () => {
      starts += 1;
      return Promise.resolve({ outcome: 'sent' as const });
    });

    expect(starts).toBe(1);
    expect(second).toBe(first);
    release({ outcome: 'sent' });
    await expect(first).resolves.toEqual({ outcome: 'sent' });
    await expect(second).resolves.toEqual({ outcome: 'sent' });
  });

  it('失败 settle 后同一键允许再提交', async () => {
    const key = chatSendInflightKey('session-1', 'msg-retry');
    await expect(claimSendInflight(key, async () => ({ outcome: 'failed' as const })))
      .resolves.toEqual({ outcome: 'failed' });
    await expect(claimSendInflight(key, async () => ({ outcome: 'sent' as const })))
      .resolves.toEqual({ outcome: 'sent' });
  });

  it('failed / undefined 不算发出去，sent 与 queued 算发出去', () => {
    expect(isChatSendAccepted(undefined)).toBe(false);
    expect(isChatSendAccepted({ outcome: 'failed' })).toBe(false);
    expect(isChatSendAccepted({ outcome: 'sent' })).toBe(true);
    expect(isChatSendAccepted({ outcome: 'steered' })).toBe(true);
    expect(isChatSendAccepted({
      outcome: 'queued',
      queuedInputId: 'q1',
      code: 'RUN_SETTLED',
      message: 'queued',
    })).toBe(true);
  });
});
