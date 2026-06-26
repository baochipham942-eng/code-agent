import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHANNEL_PRIVACY_MODE,
  resolveChannelPrivacyMode,
  sanitizeChannelMessage,
} from '../../../src/host/channels/privacy/channelPrivacyFirewall';
import type { ChannelMessage } from '../../../src/shared/contract/channel';

function makeMessage(): ChannelMessage {
  return {
    id: 'msg-1',
    channelId: 'generic-account',
    sender: { id: 'user-1', name: 'Alice' },
    context: { chatId: 'chat-1', chatType: 'group' },
    content: 'alice@example.com card 4242 4242 4242 4242',
    timestamp: 1,
    raw: {
      message: {
        content: 'alice@example.com card 4242 4242 4242 4242',
      },
    },
  };
}

describe('channel privacy firewall', () => {
  it('defaults unknown privacy modes to local-redact', () => {
    expect(resolveChannelPrivacyMode(undefined)).toBe(DEFAULT_CHANNEL_PRIVACY_MODE);
    expect(resolveChannelPrivacyMode('unknown')).toBe(DEFAULT_CHANNEL_PRIVACY_MODE);
  });

  it('applies the generic privacy mode before connector-specific adapters', () => {
    const sanitized = sanitizeChannelMessage(makeMessage(), {
      retainRaw: true,
      mode: 'local-redact',
    });
    const json = JSON.stringify(sanitized);

    expect(sanitized.content).toContain('[email hidden]');
    expect(sanitized.content).toContain('[credit card hidden]');
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('4242 4242 4242 4242');
  });
});
