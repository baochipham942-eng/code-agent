import { describe, expect, it, vi } from 'vitest';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { InboundPairingService } from '../../../src/host/channels/inboundPairingService';

const mocks = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

const TEN_MINUTES_MS = 10 * 60 * 1000;

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
  accountScopeId: 'feishu:cli_test_app',
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
      payload: expect.objectContaining({ code: '042731', expiresAt: 1_000 + TEN_MINUTES_MS }),
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
    h.advance(TEN_MINUTES_MS + 1);

    expect(h.service.resolve(requestId, 'allow')).toBe(false);
    expect(h.addPairedSender).not.toHaveBeenCalled();
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });

  it('rejects sender rotation after five pending requests for the same app account', async () => {
    const h = createHarness();
    for (let index = 0; index < 5; index += 1) {
      await h.service.request({
        ...request,
        accountId: `local-account-${index}`,
        senderId: `ou_sender_${index}`,
      });
    }

    expect(await h.service.request({ ...request, senderId: 'ou_sender_5' })).toBeNull();
    expect(h.insert).toHaveBeenCalledTimes(5);
    expect(h.sendControlReply).toHaveBeenCalledTimes(5);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Rejected inbound pairing request: pending account limit reached',
      expect.objectContaining({
        accountScopeId: 'feishu:cli_test_app',
        senderId: 'ou_sender_5',
        pendingCount: 5,
        limit: 5,
      }),
    );
  });

  it('drops pairing replies beyond the per-account minute limit across rotating senders', async () => {
    const h = createHarness();
    for (let index = 0; index < 5; index += 1) {
      await h.service.request({ ...request, senderId: `ou_sender_${index}` });
      const requestId = h.insert.mock.calls[index][0].id as string;
      expect(h.service.resolve(requestId, 'allow')).toBe(true);
    }
    expect(h.sendControlReply).toHaveBeenCalledTimes(10);

    expect(await h.service.request({ ...request, senderId: 'ou_sender_5' })).toBe('042731');
    expect(h.sendControlReply).toHaveBeenCalledTimes(10);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Dropped inbound pairing reply: account rate limit reached',
      expect.objectContaining({
        accountScopeId: 'feishu:cli_test_app',
        senderId: 'ou_sender_5',
        limit: 10,
        windowMs: 60_000,
      }),
    );
  });
});
