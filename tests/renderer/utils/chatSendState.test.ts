import { describe, expect, it } from 'vitest';
import {
  chatSendInflightKey,
  claimSendInflight,
  consumePendingClientMessageId,
  isChatSendAccepted,
  type ChatSendDelivery,
} from '../../../src/renderer/utils/chatSendState';

// 不需要复位钩子：claimSendInflight 在 settle 后自己释放键，各用例用各自的键即可。
// （为测试而多导出一个 reset 会被 knip 生产不可达棘轮判红——那类导出是生产里的死重量。）
describe('chatSendState inflight 幂等', () => {

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

  it('编辑重发 pending id 在 envelope 没带 id 时被消费，用过即清空', () => {
    const pending = { current: 'failed-bubble-id' };
    const id = consumePendingClientMessageId(undefined, pending, () => 'fresh-uuid');
    expect(id).toBe('failed-bubble-id');
    expect(pending.current).toBeNull();
  });

  it('envelope 已带 id 时优先用它，pending 仍然清空以免污染下一条', () => {
    const pending = { current: 'stale-pending' };
    const id = consumePendingClientMessageId('envelope-id', pending, () => 'fresh-uuid');
    expect(id).toBe('envelope-id');
    expect(pending.current).toBeNull();
  });

  it('验收④ 变异：不消费 pending 时编辑重发会铸成新 UUID', () => {
    const pending = { current: 'failed-bubble-id' };
    const mutated = (envelopeId: string | undefined, generateId: () => string) => (
      envelopeId ?? generateId()
    );
    expect(mutated(undefined, () => 'fresh-uuid')).toBe('fresh-uuid');
    expect(pending.current).toBe('failed-bubble-id');
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
