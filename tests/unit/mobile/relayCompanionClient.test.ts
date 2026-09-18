import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { RelayCompanionClient, type RelayDial, type RelayDialSocket } from '../../../packages/mobile/src/platform/relayCompanionClient';

const TICKET = 'neo1.payload.mac';

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
      // RelayDialRoute 只认拨号真正用到的三样（url/routeToken/凭据形态）；配对盘里的 v 由 parse 层管。
      route: { url: 'ws://127.0.0.1:8791', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' },
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

  it('握手/welcome 等待超时也要关连接——不许留带心跳的僵尸 socket（ai-review Important）', async () => {
    vi.useFakeTimers();
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    const pending = expect(client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] }))
      .rejects.toThrow('COMPANION_NO_RESPONSE');
    await vi.advanceTimersByTimeAsync(L.requestTimeoutMs + 10);
    await pending;
    expect(socket.closed).toBe(true);
    // 心跳 interval 必须已清：过了心跳周期也不该再有任何发送。
    const sentSoFar = socket.sent.length;
    await vi.advanceTimersByTimeAsync(L.relayHeartbeatMs * 3);
    expect(socket.sent.length).toBe(sentSoFar);
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

  it('relay 回 no-host 帧 ⇒ 在飞握手立刻以 COMPANION_RELAY_NO_HOST 结算并关连接，不等握手超时', async () => {
    const socket = new ScriptedSocket();
    const { client } = clientWith(() => socket.socket);
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    const pending = client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] });
    socket.deliver(JSON.stringify({
      v: 1, kind: 'no-host',
      envelope: { routeToken: 'route-token-aaaaaa', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    await expect(pending).rejects.toThrow('COMPANION_RELAY_NO_HOST');
    expect(socket.closed).toBe(true);
    // relay 随后关 socket：失败原因不许被改写成「凭据被拒」。
    socket.fireClose();
    await expect(client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] }))
      .rejects.toThrow('COMPANION_RELAY_NO_HOST');
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

/**
 * N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE：账号路由拨号——票据进凭据子协议那条 dial（authorization
 * 里带的就是票据原文，browserRelayDial 会把它编进 `neo-relay-auth.<base64url>` 子协议项）；relay 在
 * 本连接上续签的 ticket 帧按 sentinel 校验后交给 onTicket，信封过期不拦它（与 Host 同序）。
 */
describe('RelayCompanionClient：账号票据拨号与续签帧', () => {
  const ticketRoute = { url: 'ws://127.0.0.1:8791', routeToken: 'account-token-aaaaaa', ticket: TICKET };

  it('有票据 ⇒ 拨号凭据就是票据（M3 守卫）：authorization = Bearer <ticket>', async () => {
    const socket = new ScriptedSocket();
    let headers: { authorization: string } | undefined;
    const identity = createIdentity();
    const client = new RelayCompanionClient({
      identity, route: ticketRoute, deviceRef: 'phone-1',
      dial: (url, h) => { headers = h; return socket.socket; },
    });
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    expect(headers?.authorization).toBe(`Bearer ${TICKET}`);
    // register 帧仍带账号路由的 token，票据绝不进帧。
    const register = JSON.parse(socket.sent[0]) as { envelope: { routeToken: string } };
    expect(register.envelope.routeToken).toBe('account-token-aaaaaa');
    expect(socket.sent.join('')).not.toContain(TICKET);
    client.close();
  });

  it('relay 续签的 ticket 帧（sentinel 对上）⇒ onTicket 收到票据原文，连接不受影响', async () => {
    const onTicket = vi.fn();
    const socket = new ScriptedSocket();
    const identity = createIdentity();
    const client = new RelayCompanionClient({
      identity, route: ticketRoute, deviceRef: 'phone-1', dial: () => socket.socket, onTicket,
    });
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    socket.deliver(JSON.stringify({
      v: 1, kind: 'ticket',
      envelope: { routeToken: 'neo-relay-ticket-issue', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: 'neo1.renewed.mac',
    }));
    expect(onTicket).toHaveBeenCalledWith('neo1.renewed.mac');
    expect(socket.closed).toBe(false); // 续签帧不是任何人的失败，连接照旧
    client.close();
  });

  it('收到续签 ticket 后、channel 建立前断线 ⇒ 传输断开（COMPANION_NOT_CONNECTED），不误判凭据被拒（ai-review Important）', async () => {
    const onTicket = vi.fn();
    const socket = new ScriptedSocket();
    const identity = createIdentity();
    const client = new RelayCompanionClient({
      identity, route: ticketRoute, deviceRef: 'phone-1', dial: () => socket.socket, onTicket,
    });
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    // 票据进续签窗（relay 必发新票）、Noise channel 建起前 socket 被关（relay 重启/蜂窝切换）：
    // ticket 帧只发给鉴权通过的连接，此刻的关闭是传输断开——若分类成 AUTH_REJECTED，
    // store 会删掉刚续签落盘的有效票据、翻 S8，用户被静默登出。
    socket.deliver(JSON.stringify({
      v: 1, kind: 'ticket',
      envelope: { routeToken: 'neo-relay-ticket-issue', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: 'neo1.renewed.mac',
    }));
    expect(onTicket).toHaveBeenCalledWith('neo1.renewed.mac');
    socket.fireClose();
    await expect(client.resume({ hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] }))
      .rejects.toThrow('COMPANION_NOT_CONNECTED');
  });

  it('ticket 帧信封不是 sentinel（别人路由上的转发形状）⇒ 忽略，不喂给 onTicket', async () => {
    const onTicket = vi.fn();
    const socket = new ScriptedSocket();
    const identity = createIdentity();
    const client = new RelayCompanionClient({
      identity, route: ticketRoute, deviceRef: 'phone-1', dial: () => socket.socket, onTicket,
    });
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    socket.deliver(JSON.stringify({
      v: 1, kind: 'ticket',
      envelope: { routeToken: 'route-token-aaaaaa', deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: 'neo1.forged.mac',
    }));
    expect(onTicket).not.toHaveBeenCalled();
    client.close();
  });

  it('信封 TTL 已过的续签帧也照收：票据帧先于过期判定（与 Host 侧同序，时钟偏差不吞续签）', async () => {
    const onTicket = vi.fn();
    const socket = new ScriptedSocket();
    const identity = createIdentity();
    const client = new RelayCompanionClient({
      identity, route: ticketRoute, deviceRef: 'phone-1', dial: () => socket.socket, onTicket,
    });
    const connected = client.connect();
    socket.fireOpen();
    await connected;
    socket.deliver(JSON.stringify({
      v: 1, kind: 'ticket',
      envelope: { routeToken: 'neo-relay-ticket-issue', deviceRef: 'relay', seq: 0, ttlMs: 1, issuedAt: Date.now() - 10_000 },
      ciphertext: 'neo1.renewed.mac',
    }));
    expect(onTicket).toHaveBeenCalledWith('neo1.renewed.mac');
    client.close();
  });
});
