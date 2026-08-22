import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { ChannelResponseCallback } from '../../../src/host/channels/channelInterface';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';
import {
  shouldDeliverAgentEvent,
  type AgentEventFilter,
} from '../../../src/host/protocol/events/eventFilter';

interface ChannelAgentBridgeHarness {
  handleSyncMessage(
    accountId: string,
    message: ChannelMessage,
    orchestrator: unknown,
    attachments: undefined,
    responseCallback: ChannelResponseCallback,
  ): Promise<void>;
}

describe('ChannelAgentBridge event declaration', () => {
  it('subscribes sync channels to permission events without streaming deltas', async () => {
    let declaredFilter: AgentEventFilter | undefined;
    const orchestrator = {
      getMessages: vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ role: 'assistant', content: 'done' }]),
      sendMessage: vi.fn(async (
        _content: string,
        _attachments: unknown,
        options: { eventFilter?: AgentEventFilter } | undefined,
      ) => {
        declaredFilter = options?.eventFilter;
      }),
    };
    const responseCallback: ChannelResponseCallback = {
      sendText: vi.fn(async () => ({ success: true })),
    };
    const message: ChannelMessage = {
      id: 'message-1',
      channelId: 'feishu-1',
      sender: { id: 'user-1', name: 'User' },
      context: { chatId: 'chat-1', chatType: 'p2p' },
      content: 'hello',
      timestamp: 1,
    };
    const bridge = new ChannelAgentBridge({ configService: {} as never });

    await (bridge as unknown as ChannelAgentBridgeHarness).handleSyncMessage(
      'account-1',
      message,
      orchestrator,
      undefined,
      responseCallback,
    );

    expect(shouldDeliverAgentEvent('message_delta', declaredFilter)).toBe(false);
    expect(shouldDeliverAgentEvent('stream_chunk', declaredFilter)).toBe(false);
    expect(shouldDeliverAgentEvent('permission_request', declaredFilter)).toBe(true);
  });
});
