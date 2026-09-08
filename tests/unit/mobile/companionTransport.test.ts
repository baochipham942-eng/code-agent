import { describe, expect, it, vi } from 'vitest';
import { CompanionTransport } from '../../../packages/mobile/src/platform/companionTransport';

describe('CompanionTransport', () => {
  it('fails closed before pairing', async () => {
    await expect(new CompanionTransport(async () => null).sendMessage('hi')).rejects.toThrow('COMPANION_NOT_PAIRED');
  });

  it('sends an authenticated idempotent command', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'cmd-1' });
    await new CompanionTransport(async () => ({ baseUrl: 'http://host/', deviceId: 'd1', credential: 'secret', scopeEpoch: 2 }))
      .sendMessage('hello', 'session-1');
    expect(fetchMock).toHaveBeenCalledWith('http://host/companion/commands', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-neo-companion-device': 'd1', 'x-neo-companion-credential': 'secret' }),
    }));
  });
});
