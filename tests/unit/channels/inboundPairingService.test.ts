import { describe, expect, it, vi } from 'vitest';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import {
  INBOUND_PAIRING_TTL_MS,
  InboundPairingService,
} from '../../../src/host/channels/inboundPairingService';

function createHarness() {
  let now = 1_000;
  const insert = vi.fn();
  const resolve = vi.fn();
  const repo = { insert, resolve } as unknown as PendingApprovalRepository;
  const addPairedSender = vi.fn(() => true);
  const sendControlReply = vi.fn(async () => {});
  const service = new InboundPairingService({
    now: () => now,
    generateCode: () => '042731',
    getRepository: () => repo,
  });
  service.configureAdapter({ addPairedSender, sendControlReply });
  return { service, insert, resolve, addPairedSender, sendControlReply, advance: (ms: number) => { now += ms; } };
}

const request = {
  accountId: 'feishu-account',
  channelType: 'feishu' as const,
  senderId: 'ou_sender',
  senderName: 'Sender',
  chatId: 'oc_chat',
  replyToMessageId: 'om_1',
  locale: 'en-US' as const,
};

describe('InboundPairingService', () => {
  it('creates a six-digit, ten-minute, persisted one-time pairing request', async () => {
    const h = createHarness();
    expect(await h.service.request(request)).toBe('042731');
    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'channel_pairing',
      payload: expect.objectContaining({ code: '042731', expiresAt: 1_000 + INBOUND_PAIRING_TTL_MS }),
    }));
    expect(h.sendControlReply).toHaveBeenCalledWith(
      'feishu-account', 'oc_chat', 'om_1', expect.stringContaining('Pairing code: 042731'),
    );
  });

  it('persists the sender after approval and cannot consume the request twice', async () => {
    const h = createHarness();
    await h.service.request(request);
    const requestId = h.insert.mock.calls[0][0].id as string;

    expect(h.service.resolve(requestId, 'allow')).toBe(true);
    expect(h.addPairedSender).toHaveBeenCalledWith('feishu-account', 'ou_sender');
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
    expect(h.service.resolve(requestId, 'allow')).toBe(false);
  });

  it('fails closed when approval arrives after the ten-minute TTL', async () => {
    const h = createHarness();
    await h.service.request(request);
    const requestId = h.insert.mock.calls[0][0].id as string;
    h.advance(INBOUND_PAIRING_TTL_MS + 1);

    expect(h.service.resolve(requestId, 'allow')).toBe(false);
    expect(h.addPairedSender).not.toHaveBeenCalled();
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });
});
