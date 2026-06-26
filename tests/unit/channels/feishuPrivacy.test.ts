import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import {
  sanitizeFeishuInboundMessage,
} from '../../../src/host/channels/feishu/feishuPrivacy';

function makeMessage(content: string): ChannelMessage {
  return {
    id: 'msg-1',
    channelId: 'feishu-account',
    sender: {
      id: 'ou_sender',
      name: 'Alice alice@example.com',
      isBot: false,
    },
    context: {
      chatId: 'oc_chat',
      chatType: 'group',
      chatName: 'Payment token=abc123',
    },
    content,
    attachments: [{
      id: 'att-1',
      type: 'file',
      name: 'secret alice@example.com.txt',
      url: 'https://example.test/file?token=abc123',
      data: 'base64-secret',
    }],
    timestamp: 1_800_000,
    raw: {
      message: {
        content: '{"text":"card 4242 4242 4242 4242"}',
      },
    },
  };
}

describe('Feishu channel privacy sample', () => {
  it('sanitizes message content, attachment data, and retained raw payloads', () => {
    const sanitized = sanitizeFeishuInboundMessage(makeMessage('card 4242 4242 4242 4242'));
    const json = JSON.stringify(sanitized);

    expect(sanitized.content).toContain('[credit card hidden]');
    expect(sanitized.attachments?.[0]?.data).toBeUndefined();
    expect(sanitized.attachments?.[0]?.url).toBe('https://example.test/file');
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('4242 4242 4242 4242');
    expect(json).not.toContain('base64-secret');
    expect(json).not.toContain('token=abc123');
  });

  it('can keep raw payloads for connector debugging without exposing content to routing', () => {
    const sanitized = sanitizeFeishuInboundMessage(
      makeMessage('card 4242 4242 4242 4242'),
      'allow-raw',
    );

    expect(sanitized.content).toContain('[credit card hidden]');
    expect(JSON.stringify(sanitized.raw)).toContain('4242 4242 4242 4242');
  });

  it('can disable the channel firewall for controlled local debugging', () => {
    const unfiltered = sanitizeFeishuInboundMessage(
      makeMessage('card 4242 4242 4242 4242'),
      'off',
    );

    expect(unfiltered.content).toContain('4242 4242 4242 4242');
    expect(unfiltered.attachments?.[0]?.data).toBe('base64-secret');
    expect(JSON.stringify(unfiltered.raw)).toContain('4242 4242 4242 4242');
  });
});
