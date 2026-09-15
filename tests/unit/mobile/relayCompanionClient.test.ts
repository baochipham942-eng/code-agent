import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { RelayCompanionClient, type RelayDial, type RelayDialSocket } from '../../../packages/mobile/src/platform/relayCompanionClient';

/**
 * N-MOBILE-RELAY-PHONE 手机 relay 客户端的连接分类与帧纪律。传输层用脚本化 fake dial：
 * 不依赖 socket，把「open 之后立刻被关（凭据闸）」「error 在 open 之前（连不上）」
 * 「什么都不发（超时）」三种现场精确摆出来。
 */
class ScriptedSocket {
  sent: string[] = [];
  closed = false;
  private readonly handlers: Record<'open' | 'close' | 'error' | 'message', Array<() => void> | Array<(data: string) => void>> = { open: [], close: [], error: [], message: [] };
  readonly socket: RelayDialSocket = {
    send: data => { this.sent.push(data); },
    close: () => { this.closed = true; },
    onOpen: handler => { (this.handlers.open as Array<() => void>).push(handler); },
    onClose: handler => { (this.handlers.close as Array<() => void>).push(handler); },
    onError: handler => { (this.handlers.error as Array<() => void>).push(handler); },
    onMessage: handler => { (this.handlers.message as Array<(data: string) => void>).push(handler); },
  };
  fireOpen() { for (const handler of [...this.handlers.open as Array<() => void>]) handler(); }
  fireClose() { for (const handler of [...this.handlers.close as Array<() => void>]) handler(); }
  fireError() { for (const handler of [...this.handlers.error as Array<() => void>]) handler(); }
  deliver(raw: string) { for (const handler of [...this.handlers.message as Array<(data: string) => void>]) handler(raw); }
}

function clientWith(dial: RelayDial, onRevoked?: () => void) {
  const identity = createIdentity();
  return {
    identity,
    hostKey: toHex(identity.publicKey),
    client: new RelayCompanionClient({
      identity,
      route: { v: 1, url: 'ws://127.0.0.1:8791', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' },
      deviceRef: 'phone-1',
      dial,
      onRevoked,
    }),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('RelayCompanionClient：连接失败三分类', () => {
  it('凭据被拒：upgrade 完成后立刻被关、零收帧 ⇒ COMPANION_RELAY_AUTH_REJECTED', async () => {
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    // relay 在 accept 处 close：open 先到（101 已发），close 紧随其后。
    socket.fireClose();
    await expect(client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] }))
      .rejects.toThrow('COMPANION_RELAY_AUTH_REJECTED');
    expect(socket.closed).toBe(true);
  });

  it('relay 不可达：open 之前 error ⇒ COMPANION_RELAY_UNAVAILABLE', async () => {
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    const pending = client.connect();
    socket.fireError();
    await expect(pending).rejects.toThrow('COMPANION_RELAY_UNAVAILABLE');
  });

  it('拨号超时：对端一声不吭 ⇒ COMPANION_RELAY_CONNECT_TIMEOUT', async () => {
    vi.useFakeTimers();
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    const pending = client.connect();
    const assertion = expect(pending).rejects.toThrow('COMPANION_RELAY_CONNECT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(L.relayConnectTimeoutMs + 10);
    await assertion;
    expect(socket.closed).toBe(true);
  });

  it('open 之后才断：握手已完成 ⇒ 不是凭据问题，落 COMPANION_NOT_CONNECTED', async () => {
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    socket.deliver(JSON.stringify({
      v: 1, kind: 'forward',
      envelope: { routeToken: 'route-token-aaaaaa', deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: 'irrelevant-but-nonempty',
    }));
    socket.fireClose();
    await expect(client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] }))
      .rejects.toThrow('COMPANION_NOT_CONNECTED');
  });
});

describe('RelayCompanionClient：动作面与帧纪律', () => {
  it('relay 面不支持的动作当场拒绝，不拨不建会话', async () => {
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    await expect(client.request({ action: 'dictation', op: 'open' })).rejects.toThrow('COMPANION_UNSUPPORTED_ACTION');
    await expect(client.request({ action: 'push.register', provider: 'apns', token: 'x' })).rejects.toThrow('COMPANION_UNSUPPORTED_ACTION');
    expect(socket.sent).toEqual([]);
  });

  it('register 帧以 device 角色携带缓存的路由 token，凭据只进 Authorization 头', async () => {
    const sockets: ScriptedSocket[] = [];
    let headers: { authorization: string } | undefined;
    const { client } = clientWith((url, h) => { headers = h; sockets.push(new ScriptedSocket()); return sockets[0].socket; });
    expect(() => client.connect()).not.toThrow();
    sockets[0].fireOpen();
    await vi.waitFor(() => expect(sockets[0].sent.length).toBeGreaterThan(0));
    const register = JSON.parse(sockets[0].sent[0]) as { kind: string; role?: string; envelope: { routeToken: string; deviceRef: string } };
    expect(register).toMatchObject({ kind: 'register', role: 'device' });
    expect(register.envelope.routeToken).toBe('route-token-aaaaaa');
    expect(register.envelope.deviceRef).toBe('phone-1');
    expect(headers?.authorization).toBe('Bearer relay-shared-credential');
    // 凭据绝不进 URL。
    expect(sockets[0].sent.join('')).not.toContain('relay-shared-credential');
    client.close();
  });

  it('revoke/disconnect 帧触发 onRevoked 并按设备撤销结算在飞等待', async () => {
    const onRevoked = vi.fn();
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket, onRevoked);
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    const pending = client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] });
    socket.deliver(JSON.stringify({
      v: 1, kind: 'revoke',
      envelope: { routeToken: 'route-token-aaaaaa', deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    await expect(pending).rejects.toThrow('COMPANION_DEVICE_REVOKED');
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBe(true);
  });

  it('过期帧直接丢弃（信封 TTL 纪律与 Host/relay 同源）', async () => {
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    let settled: unknown = 'pending';
    client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] })
      .then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
    socket.deliver(JSON.stringify({
      v: 1, kind: 'handshake',
      envelope: { routeToken: 'route-token-aaaaaa', deviceRef: 'phone-1', seq: 0, ttlMs: 1, issuedAt: Date.now() - 10_000 },
      ciphertext: '00',
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe('pending'); // 过期帧没人理，等待继续（由超时收口）
    client.close();
  });
});
