import { describe, it, expect } from 'vitest';
import { sanitizeChannelMessage } from '../../../src/main/channels/privacy/channelPrivacyFirewall';
import type { ChannelMessage } from '../../../src/shared/contract/channel';

const CARD = '4111 1111 1111 1111'; // Luhn-valid test card → guardSensitiveText redacts

function makeMessage(transcript: string): ChannelMessage {
  return {
    id: 'm1',
    channelId: 'telegram',
    sender: { id: 'u1', name: 'Tester' },
    context: { chatId: 'c1', chatType: 'private' },
    content: 'hello',
    timestamp: 0,
    attachments: [
      {
        id: 'a1',
        type: 'audio',
        name: 'voice.ogg',
        localPath: '/Users/tester/voice.ogg',
        platformFileKey: 'file_key_abc',
        mediaState: 'ready',
        metadata: { transcript: `card ${CARD}`, transcriptionState: 'ready' },
      },
    ],
  } as ChannelMessage;
}

describe('channel attachment transcript privacy (T1)', () => {
  it('redacts sensitive transcript carried in attachment metadata under local-redact', () => {
    const out = sanitizeChannelMessage(makeMessage(`card ${CARD}`), { mode: 'local-redact' });
    const att = out.attachments?.[0];
    expect(att).toBeDefined();
    const transcript = String(att?.metadata?.transcript ?? '');
    expect(transcript).not.toContain(CARD);
    expect(transcript).toContain('[credit card hidden]');
  });

  it('preserves functional fields needed downstream (localPath / platformFileKey / mediaState)', () => {
    const out = sanitizeChannelMessage(makeMessage(`card ${CARD}`), { mode: 'local-redact' });
    const att = out.attachments?.[0];
    expect(att?.localPath).toBe('/Users/tester/voice.ogg');
    expect(att?.platformFileKey).toBe('file_key_abc');
    expect(att?.mediaState).toBe('ready');
  });

  it('does not redact transcript when privacy mode is off (explicit opt-out)', () => {
    const out = sanitizeChannelMessage(makeMessage(`card ${CARD}`), { mode: 'off' });
    const att = out.attachments?.[0];
    expect(String(att?.metadata?.transcript ?? '')).toContain(CARD);
  });
});
