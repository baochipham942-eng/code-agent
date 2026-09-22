import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from '../../../../src/shared/constants/network';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import {
  COMPANION_RELAY_SENTINEL_DEVICE_REF,
  COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN,
  parseCompanionRelayFrame,
} from '../../../../src/shared/contract/companionRelay';
import type { RelayDial } from './relayCompanionClient';

/**
 * 手机登录 Neo 账号（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：只有邮箱+密码，没有第三方登录。
 * 两段式——①Supabase REST 密码换 access token（fetch 直发，不引 supabase-js）；②拿 token 连
 * relay 换设备票据（relay 在鉴权成功的那条连接上直接发 ticket 帧）。token 与密码都不落盘、
 * 不进日志：落盘的只有票据 + 账号邮箱 + 用户 id（票据 30 天有效、剩 7 天自动续签，之后日常
 * 连接不再碰账号服务）。
 */

/** 登录的失败态只有两类（设计拍板）：凭据错、账号服务连不上；账号不一致单独点名（D-2）。 */
export type AccountLoginResult =
  | { ok: true; ticket: string; userId: string; email: string }
  | { ok: false; kind: 'invalidCredentials' }
  | { ok: false; kind: 'wrongAccount'; hostEmail: string }
  | { ok: false; kind: 'unreachable' };

function sameAccount(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Supabase 密码换令牌。响应里的 access token 只活在本次调用的栈上，绝不外带。
 * 导出给找回流（N-COMPANION-RELAY-ACCOUNT-RECOVER）复用：密码换 token 后不停在换票，
 * token 进内存里的找回会话，连 relay 列电脑/发起配对。
 */
export async function passwordGrant(email: string, password: string, fetchImpl: typeof fetch): Promise<{ accessToken: string; userId: string; email: string } | { error: 'invalidCredentials' | 'unreachable' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), L.accountLoginTimeoutMs);
  try {
    const response = await fetchImpl(`${DEFAULT_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: DEFAULT_SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    if (response.status === 400) return { error: 'invalidCredentials' };
    if (!response.ok) return { error: 'unreachable' };
    const body = await response.json() as { access_token?: unknown; user?: { id?: unknown; email?: unknown } | null };
    if (typeof body.access_token !== 'string' || !body.access_token
      || !body.user || typeof body.user.id !== 'string' || typeof body.user.email !== 'string') return { error: 'unreachable' };
    return { accessToken: body.access_token, userId: body.user.id, email: body.user.email };
  } catch {
    return { error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拿 access token 连 relay 换票：凭据进子协议（WebView 的 WebSocket 设不了请求头，与日常
 * 拨号同一条路），relay 验令牌通过后在本连接上直接下发 ticket 帧——收到即断开，这条连接
 * 只为换票而存在。连不上/被关/超时一律按「服务连不上」结算（重试/稍后再说）。
 */
function exchangeRelayTicket(url: string, accessToken: string, dial: RelayDial): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: ReturnType<RelayDial> | null = null;
    const finish = (outcome: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* 已死 */ }
      if (typeof outcome === 'string') resolve(outcome);
      else reject(outcome);
    };
    const timer = setTimeout(() => finish(new Error('COMPANION_ACCOUNT_LOGIN_TIMEOUT')), L.accountLoginTimeoutMs);
    try {
      socket = dial(url, { authorization: `Bearer ${accessToken}` });
    } catch (error) {
      finish(error instanceof Error ? error : new Error('COMPANION_RELAY_UNAVAILABLE'));
      return;
    }
    socket.onError(() => { /* close 随后结算 */ });
    socket.onClose(() => finish(new Error('COMPANION_RELAY_AUTH_REJECTED')));
    socket.onMessage(raw => {
      try {
        const frame = parseCompanionRelayFrame(JSON.parse(raw) as unknown);
        if (frame.kind === 'ticket'
          && frame.envelope.routeToken === COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN
          && frame.envelope.deviceRef === COMPANION_RELAY_SENTINEL_DEVICE_REF) {
          finish(frame.ciphertext);
          return;
        }
      } catch {
        finish(new Error('COMPANION_RELAY_INVALID_FRAME'));
        return;
      }
    });
  });
}

export async function loginNeoAccount(input: {
  email: string;
  password: string;
  /** 配对信息里带的电脑账号邮箱：与登录的不是同一个账号就直接拒绝，文案点名这台电脑属于谁。 */
  hostAccountEmail: string | null;
  /** relay 地址（账号路由或旧路由的 url 都指向同一个 relay）；还不知道中继在哪就按服务连不上结算。 */
  relayUrl: string | null;
  dial: RelayDial;
  fetchImpl?: typeof fetch;
}): Promise<AccountLoginResult> {
  // 先在本地核对账号一致（D-2）：不是同一个账号时不出网、不换票，直接说清这台电脑属于谁。
  if (input.hostAccountEmail && !sameAccount(input.email, input.hostAccountEmail)) {
    return { ok: false, kind: 'wrongAccount', hostEmail: input.hostAccountEmail };
  }
  if (!input.relayUrl) return { ok: false, kind: 'unreachable' };
  const grant = await passwordGrant(input.email, input.password, input.fetchImpl ?? fetch);
  if ('error' in grant) return { ok: false, kind: grant.error };
  // Supabase 归一化过的邮箱再核一次：输入框里的大小写差异过得了上一关，换回来的真身过不了才算不一致。
  if (input.hostAccountEmail && !sameAccount(grant.email, input.hostAccountEmail)) {
    return { ok: false, kind: 'wrongAccount', hostEmail: input.hostAccountEmail };
  }
  try {
    const ticket = await exchangeRelayTicket(input.relayUrl, grant.accessToken, input.dial);
    return { ok: true, ticket, userId: grant.userId, email: grant.email };
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
}
