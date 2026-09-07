import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';

describe('失败气泡编辑重发', () => {
  const send = vi.fn();
  const restoreComposer = vi.fn();

  const failedUser = (overrides: Partial<Message> = {}): Message => ({
    id: 'user-failed-1',
    role: 'user',
    content: '长段需求原文',
    timestamp: 1,
    metadata: { sendFailed: true },
    ...overrides,
  });

  beforeEach(() => {
    send.mockClear();
    restoreComposer.mockClear();
    useMessageActionStore.getState().unregister();
  });

  it('把原文和附件取回 composer，并带上原 clientMessageId', () => {
    const attachment = { id: 'f1', name: 'a.png', type: 'image', size: 1, data: 'x' } as never;
    useMessageActionStore.getState().register(
      send,
      () => [failedUser({ attachments: [attachment] })],
      restoreComposer,
    );

    useMessageActionStore.getState().editAndResendMessage('user-failed-1');

    expect(restoreComposer).toHaveBeenCalledTimes(1);
    expect(restoreComposer).toHaveBeenCalledWith({
      content: '长段需求原文',
      attachments: [attachment],
      clientMessageId: 'user-failed-1',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('未失败的用户气泡不能走编辑重发', () => {
    useMessageActionStore.getState().register(
      send,
      () => [{ id: 'u-ok', role: 'user', content: '已发出去的', timestamp: 1 }],
      restoreComposer,
    );

    useMessageActionStore.getState().editAndResendMessage('u-ok');

    expect(restoreComposer).not.toHaveBeenCalled();
  });

  it('纯附件失败气泡也能取回附件', () => {
    const attachment = { id: 'f2', name: 'b.png', type: 'image', size: 1, data: 'y' } as never;
    useMessageActionStore.getState().register(
      send,
      () => [failedUser({ content: '', attachments: [attachment] })],
      restoreComposer,
    );

    useMessageActionStore.getState().editAndResendMessage('user-failed-1');

    expect(restoreComposer).toHaveBeenCalledWith({
      content: '',
      attachments: [attachment],
      clientMessageId: 'user-failed-1',
    });
  });
});
