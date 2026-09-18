import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { DEFAULT_SUPABASE_URL } from '../../../src/shared/constants/network';
import { loginNeoAccount } from '../../../packages/mobile/src/platform/accountLogin';
import type { RelayDial, RelayDialSocket } from '../../../packages/mobile/src/platform/relayCompanionClient';

/**
 * 手机登录 Neo 账号（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：Supabase REST 密码换令牌 +
 * relay 换票两段。fetch 与拨号全部脚本化，只测判据：凭据错 / 账号服务连不上（S7）/ 账号不一致
 * 点名（D-2）/ 成功回票据。access token 与密码绝不落盘由 store 侧测试守卫（M4）。
 */

/** 脚本化 relay 换票 socket：open 后按脚本发帧/关闭。 */
class TicketSocket {
  sent: string[] = [];
  closed = false;
  private closeHandlers: Array<() => void> = [];
  private messageHandlers: Array<(data: string) => void> = [];
  readonly socket: RelayDialSocket = {
    send: data => { this.sent.push(data); },
    close: () => { this.closed = true; },
    onOpen: () => {},
    onClose: handler => { this.closeHandlers.push(handler); },
    onError: () => {},
    onMessage: handler => { this.messageHandlers.push(handler); },
  };
  deliver(raw: string) { for (const handler of [...this.messageHandlers]) handler(raw); }
  fireClose() { for (const handler of [...this.closeHandlers]) handler(); }
}

const TOKEN = 'access-token-opaque';
const TICKET = 'neo1.payload.mac';

const ticketFrame = (ticket = TICKET) => JSON.stringify({
  v: 1, kind: 'ticket',
  envelope: { routeToken: 'neo-relay-ticket-issue', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
  ciphertext: ticket,
});

function okFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('loginNeoAccount：账号一致性与失败两类', () => {
  it('D-2 账号不一致：输入邮箱 ≠ 电脑账号邮箱 ⇒ 直接拒绝并点名，不出网不换票', async () => {
    const fetchImpl = vi.fn();
    const dial = vi.fn();
    const result = await loginNeoAccount({
      email: 'other@example.com', password: 'pw',
      hostAccountEmail: 'lin@example.com', relayUrl: 'wss://relay.example.invalid/', dial, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, kind: 'wrongAccount', hostEmail: 'lin@example.com' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });

  it('大小写/空白差异不算不一致：按归一化邮箱比较', async () => {
    const socket = new TicketSocket();
    const dial = vi.fn(() => { queueMicrotask(() => socket.deliver(ticketFrame())); return socket.socket; });
    const result = await loginNeoAccount({
      email: ' Lin@Example.com ', password: 'pw',
      hostAccountEmail: 'lin@example.com', relayUrl: 'wss://relay.example.invalid/',
      dial: dial as RelayDial, fetchImpl: okFetch({ access_token: TOKEN, user: { id: 'user-1', email: 'lin@example.com' } }),
    });
    expect(result).toMatchObject({ ok: true, ticket: TICKET, userId: 'user-1', email: 'lin@example.com' });
  });

  it('Supabase 归一化后的邮箱与电脑账号不一致 ⇒ 同样点名拒绝（换回的真身过不了才算）', async () => {
    const result = await loginNeoAccount({
      email: 'lin@example.com', password: 'pw',
      hostAccountEmail: 'lin@example.com', relayUrl: 'wss://relay.example.invalid/',
      dial: () => new TicketSocket().socket,
      fetchImpl: okFetch({ access_token: TOKEN, user: { id: 'user-1', email: 'someone-else@example.com' } }),
    });
    expect(result).toEqual({ ok: false, kind: 'wrongAccount', hostEmail: 'lin@example.com' });
  });

  it('凭据错（S4 行内）：Supabase 400 ⇒ invalidCredentials，不拨 relay', async () => {
    const dial = vi.fn();
    const result = await loginNeoAccount({
      email: 'lin@example.com', password: 'wrong',
      hostAccountEmail: null, relayUrl: 'wss://relay.example.invalid/', dial,
      fetchImpl: okFetch({ error: 'invalid_credentials' }, 400),
    });
    expect(result).toEqual({ ok: false, kind: 'invalidCredentials' });
    expect(dial).not.toHaveBeenCalled();
  });

  it('账号服务连不上（S7）：网络失败 / 非 400 / 载荷残缺都归这一类', async () => {
    const failing: typeof fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const base = { email: 'lin@example.com', password: 'pw', hostAccountEmail: null, relayUrl: 'wss://relay.example.invalid/', dial: () => new TicketSocket().socket } as const;
    expect(await loginNeoAccount({ ...base, fetchImpl: failing })).toEqual({ ok: false, kind: 'unreachable' });
    expect(await loginNeoAccount({ ...base, fetchImpl: okFetch({}, 503) })).toEqual({ ok: false, kind: 'unreachable' });
    expect(await loginNeoAccount({ ...base, fetchImpl: okFetch({ access_token: TOKEN, user: { id: 'user-1' } }) })).toEqual({ ok: false, kind: 'unreachable' });
  });

  it('没有已知 relay 地址（还没配对/Host 没配中继）⇒ unreachable，不出网', async () => {
    const fetchImpl = vi.fn();
    const result = await loginNeoAccount({
      email: 'lin@example.com', password: 'pw', hostAccountEmail: null, relayUrl: null,
      dial: () => new TicketSocket().socket, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, kind: 'unreachable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('loginNeoAccount：relay 换票', () => {
  it('请求打到 Supabase 密码端点（apikey 头 + grant_type=password），票据走凭据子协议的同一条 dial', async () => {
    const socket = new TicketSocket();
    const dial = vi.fn(() => { queueMicrotask(() => socket.deliver(ticketFrame())); return socket.socket; });
    const fetchImpl = okFetch({ access_token: TOKEN, user: { id: 'user-1', email: 'lin@example.com' } });
    const result = await loginNeoAccount({
      email: 'lin@example.com', password: 'pw', hostAccountEmail: null,
      relayUrl: 'ws://127.0.0.1:8791/', dial: dial as RelayDial, fetchImpl,
    });
    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${DEFAULT_SUPABASE_URL}/auth/v1/token?grant_type=password`,
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'content-type': 'application/json' }) }),
    );
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].headers.apikey).toBeTypeOf('string');
    // 换票连接拿到的 authorization 是 access token——它只在这次换票里活一下。
    expect(dial).toHaveBeenCalledWith('ws://127.0.0.1:8791/', { authorization: `Bearer ${TOKEN}` });
    // 收到票据即断：这条连接只为换票而存在。
    expect(socket.closed).toBe(true);
  });

  it('relay 把连接关了（没开账号鉴权/令牌被拒）⇒ unreachable', async () => {
    const socket = new TicketSocket();
    const dial = vi.fn(() => { queueMicrotask(() => socket.fireClose()); return socket.socket; });
    const result = await loginNeoAccount({
      email: 'lin@example.com', password: 'pw', hostAccountEmail: null, relayUrl: 'ws://127.0.0.1:8791/',
      dial: dial as RelayDial, fetchImpl: okFetch({ access_token: TOKEN, user: { id: 'user-1', email: 'lin@example.com' } }),
    });
    expect(result).toEqual({ ok: false, kind: 'unreachable' });
  });

  it('ticket 帧信封不对（非 sentinel）不认账；等到超时按 unreachable 收口', async () => {
    vi.useFakeTimers();
    const socket = new TicketSocket();
    const dial = vi.fn(() => socket.socket);
    const pending = loginNeoAccount({
      email: 'lin@example.com', password: 'pw', hostAccountEmail: null, relayUrl: 'ws://127.0.0.1:8791/',
      dial: dial as RelayDial, fetchImpl: okFetch({ access_token: TOKEN, user: { id: 'user-1', email: 'lin@example.com' } }),
    });
    socket.deliver(JSON.stringify({
      v: 1, kind: 'ticket',
      envelope: { routeToken: 'someone-elses-route-token', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: 'neo1.forged.mac',
    }));
    const assertion = expect(pending).resolves.toEqual({ ok: false, kind: 'unreachable' });
    await vi.advanceTimersByTimeAsync(L.accountLoginTimeoutMs + 10);
    await assertion;
    expect(socket.closed).toBe(true);
  });
});
