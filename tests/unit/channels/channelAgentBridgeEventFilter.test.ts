import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { ChannelResponseCallback } from '../../../src/host/channels/channelInterface';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';
import {
  shouldDeliverAgentEvent,
  type AgentEventFilter,
} from '../../../src/host/protocol/events/eventFilter';

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [
    { name: 'Read', permissionLevel: 'read', source: 'builtin' },
    { name: 'Bash', permissionLevel: 'execute', source: 'builtin' },
    { name: 'BrowserNavigate', permissionLevel: 'read', source: 'builtin' },
    { name: 'ComputerUse', permissionLevel: 'read', source: 'builtin' },
    { name: 'Write', permissionLevel: 'write', source: 'builtin' },
    { name: 'mcp__demo__read', permissionLevel: 'read', source: 'mcp' },
    { name: 'CronCreate', permissionLevel: 'read', source: 'builtin' },
    { name: 'delegate_task', permissionLevel: 'read', source: 'builtin' },
  ],
}));

interface ChannelAgentBridgeHarness {
  handleSyncMessage(
    accountId: string,
    message: ChannelMessage,
    orchestrator: unknown,
    attachments: undefined,
    responseCallback: ChannelResponseCallback,
  ): Promise<void>;
  getSessionKey(accountId: string, message: ChannelMessage): string;
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
    expect(shouldDeliverAgentEvent('subagent_activity', declaredFilter)).toBe(true);
    expect(shouldDeliverAgentEvent('subagent_run_end', declaredFilter)).toBe(true);
  });

  it('passes guest sessions a physically narrowed read-only tool allowlist', async () => {
    let allowedToolNames: string[] | undefined;
    const orchestrator = {
      getMessages: vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ role: 'assistant', content: 'done' }]),
      sendMessage: vi.fn(async (
        _content: string,
        _attachments: unknown,
        options: { allowedToolNames?: string[] } | undefined,
      ) => {
        allowedToolNames = options?.allowedToolNames;
      }),
    };
    const responseCallback: ChannelResponseCallback = {
      sendText: vi.fn(async () => ({ success: true })),
    };
    const message: ChannelMessage = {
      id: 'guest-message',
      channelId: 'feishu-1',
      sender: { id: 'guest-1', name: 'Guest' },
      context: { chatId: 'group-1', chatType: 'group' },
      content: 'hello',
      timestamp: 1,
      ingressAuth: 'guest',
    };
    const bridge = new ChannelAgentBridge({ configService: {} as never });

    await (bridge as unknown as ChannelAgentBridgeHarness).handleSyncMessage(
      'account-1', message, orchestrator, undefined, responseCallback,
    );

    expect(allowedToolNames).toEqual(['Read']);
    expect(allowedToolNames).not.toEqual(expect.arrayContaining([
      'Bash', 'BrowserNavigate', 'ComputerUse', 'Write', 'mcp__demo__read',
      'CronCreate', 'delegate_task',
    ]));
  });

  it('keeps paired and guest conversations on different session keys', () => {
    const bridge = new ChannelAgentBridge({ configService: {} as never }) as unknown as ChannelAgentBridgeHarness;
    const base: ChannelMessage = {
      id: 'message',
      channelId: 'feishu-1',
      sender: { id: 'sender', name: 'Sender' },
      context: { chatId: 'group-1', chatType: 'group' },
      content: 'hello',
      timestamp: 1,
    };

    expect(bridge.getSessionKey('account-1', { ...base, ingressAuth: 'guest' }))
      .toBe(JSON.stringify(['account-1', 'group-1', '', 'guest']));
    expect(bridge.getSessionKey('account-1', { ...base, ingressAuth: 'paired' }))
      .toBe(JSON.stringify(['account-1', 'group-1', '', 'paired']));
  });

  it('keeps threads in the same chat on different session keys', () => {
    const bridge = new ChannelAgentBridge({ configService: {} as never }) as unknown as ChannelAgentBridgeHarness;
    const base: ChannelMessage = {
      id: 'message',
      channelId: 'feishu-1',
      sender: { id: 'sender', name: 'Sender' },
      context: { chatId: 'group-1', chatType: 'group' },
      content: 'hello',
      timestamp: 1,
    };

    expect(bridge.getSessionKey('account-1', {
      ...base,
      context: { ...base.context, threadId: 'thread-1' },
    })).toBe(JSON.stringify(['account-1', 'group-1', 'thread-1', 'paired']));
    expect(bridge.getSessionKey('account-1', {
      ...base,
      context: { ...base.context, threadId: 'thread-2' },
    })).toBe(JSON.stringify(['account-1', 'group-1', 'thread-2', 'paired']));
  });
});
