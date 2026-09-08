import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionTransport } from '../../../packages/mobile/src/platform/companionTransport';

describe('CompanionTransport', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = { baseUrl: 'http://127.0.0.1/', deviceId: 'd1', credential: 'secret', scopeEpoch: 2 };
  const ack = (state = 'accepted', overrides = {}) => ({ success: true, data: { kind: 'accepted', command: {
    deviceId: 'd1', commandId: 'cmd-1', sessionId: 'session-1', action: 'message.send', state, ...overrides,
  } } });
  it('fails closed before pairing', async () => {
    await expect(new CompanionTransport(async () => null).sendMessage('hi', 'session-1', 'cmd-1')).rejects.toThrow('COMPANION_NOT_PAIRED');
  });

  it('sends an authenticated idempotent command', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(ack()), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new CompanionTransport(async () => config);
    await expect(transport.sendMessage('hello', 'session-1', 'cmd-1')).resolves.toEqual({ state: 'accepted' });
    await transport.sendMessage('hello', 'session-1', 'cmd-1');
    expect(fetchMock.mock.calls.map(call => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).commandId)).toEqual(['cmd-1', 'cmd-1']);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1/companion/commands', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-neo-companion-device': 'd1', 'x-neo-companion-credential': 'secret' }),
    }));
  });
  it.each(['http://192.168.1.2', 'https://relay.example', 'http://127.0.0.1@remote.example'])('does not leak credentials to %s', async baseUrl => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(new CompanionTransport(async () => ({ ...config, baseUrl })).sendMessage('hello', 'session-1', 'cmd-1')).rejects.toThrow('COMPANION_SECURE_CHANNEL_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([{}, ack('accepted', { commandId: 'other' }), ack('accepted', { deviceId: 'other' }), ack('accepted', { sessionId: 'other' })])('rejects a success status with an invalid receipt', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 202 })));
    await expect(new CompanionTransport(async () => config).sendMessage('hello', 'session-1', 'cmd-1')).rejects.toThrow('COMPANION_INVALID_ACK');
  });
  it('keeps uncertain dispatch distinct from accepted work', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ack('reconciling')), { status: 200 })));
    await expect(new CompanionTransport(async () => config).sendMessage('hello', 'session-1', 'cmd-1')).resolves.toEqual({ state: 'reconciling' });
  });
  it('does not treat a recorded rejection as task acceptance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ack('rejected')), { status: 202 })));
    await expect(new CompanionTransport(async () => config).sendMessage('hello', 'session-1', 'cmd-1')).rejects.toThrow('COMPANION_COMMAND_REJECTED');
  });
});
