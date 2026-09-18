import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import {
  COMPANION_RELAY_CLOSE_CODE_ROUTE_TAKEN,
  COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN,
  COMPANION_RELAY_PAIR_ROUTE_TOKEN,
  COMPANION_RELAY_SENTINEL_DEVICE_REF,
  COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN,
  COMPANION_RELAY_WS_PROTOCOL,
  companionRelayCredentialSubprotocol,
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
} from '../../../src/shared/contract/companionRelay';
import type { JwksStats } from './accountAuth';
import type { RelayTicketAuth } from './ticketAuth';

type CompanionRelayRole = 'host' | 'device';

export interface CompanionRelayLogger {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
}

export interface CompanionRelayServerStats {
  connections: number;
  routes: number;
  queuedFrames: number;
  forwarded: number;
  droppedExpired: number;
  droppedNoRoute: number;
  droppedBacklog: number;
  droppedBackpressure: number;
  revoked: number;
  rejectedAuth: number;
  notifiedNoHost: number;
  /** 以 Supabase 账号令牌鉴权、当前在线的连接数（N-COMPANION-RELAY-ACCOUNT-BIND）。 */
  accountConnections: number;
  /** 登记到别人名下路由、或账号超出路由限额而被拒的次数。 */
  rejectedOwner: number;
  /** 已下发（含续签）的设备票据帧数（N-COMPANION-RELAY-DEVICE-TICKET）。 */
  ticketsIssued: number;
  /** 当前以设备票据鉴权、在线的连接数（close 减、stop() 归零；与 accountConnections 分开记账）。 */
  ticketConnections: number;
  /** 探活失败（上一个 ping 周期无 pong/message）被 terminate 的连接数；与 idle 清扫分开记账，
   *  排障要分清「没流量被扫」与「链路死了探不到」（N-COMPANION-RELAY-KEEPALIVE）。 */
  terminatedNoPong: number;
  /** 同 token 不同实例顶替 host 槽被拒的次数（N-COMPANION-RELAY-ROUTE-TAKEOVER）。 */
  rejectedTakeover: number;
  /** list-hosts 回帧下发次数（N-COMPANION-RELAY-ACCOUNT-RECOVER）；只数真回了的。 */
  listHosts: number;
  /** legacy 连接发起 list-hosts 被拒次数（找回是账号面，共享凭据连接没有「我的电脑」）。 */
  rejectedListHosts: number;
  /** 初次 pair-request 转发到 Host 连接的次数。 */
  pairRequests: number;
  /** pair-request 被拒次数（legacy 发起 / 限流 / 目标不在线 / 续帧对不上挂起态）。 */
  rejectedPairRequests: number;
  /** 回到手机的 pair-result 帧数（Host 发的 + relay 合成的 timeout/host-offline/rate-limited；
   *  只数真发出去的，R3 Nit1 统一口径——初次/续帧/挂起超时/断腿各路径都进这一个数）。 */
  pairResults: number;
  /** account×instance 二级索引的当前键数（R3 Important）：只应随「在线实例数」涨——随桌面重启
   *  次数单调涨 = register 改写实例没摘旧键的索引泄漏，healthz 上可直接盯。 */
  instanceIndexKeys: number;
  jwks?: JwksStats;
}

/** 连接的主人：共享凭据 ⇒ legacy；账号令牌 ⇒ acct:<Supabase 用户 id>。 */
type Principal = string;
const LEGACY_PRINCIPAL: Principal = 'legacy';

interface Route {
  /** 第一次登记这条路由的连接的主人；换主人来登记（任一角色）一律拒。 */
  owner: Principal;
  host?: WebSocket;
  /** host 槽当前占用者的实例身份（register.instanceId，N-COMPANION-RELAY-ROUTE-TAKEOVER）：
   *  顶替判据只认「两侧 instanceId 都在且不同」——缺任一侧（旧客户端）判不了，放行留痕。 */
  hostInstanceId?: string;
  /** Host register 自报的电脑名 / 主机公钥指纹（N-COMPANION-RELAY-ACCOUNT-RECOVER）：list-hosts
   *  列表行的展示材料，旧 Host 不带（列表行降级为空串，手机按「需要升级」处理）。 */
  hostName?: string;
  hostKeyFingerprint?: string;
  device?: WebSocket;
  expiresAt: number;
}

/**
 * 一次 relay 找回配对交换的挂起态（N-COMPANION-RELAY-ACCOUNT-RECOVER）：手机发出初次
 * pair-request 后 relay 记住「哪条手机连接在等哪条 Host 连接」，Host 的 pair-result 靠
 * requestId 找回手机；到点（relayPairTtlMs）Host 还没给结论就替它回 timeout。
 */
interface PendingPair {
  phone: WebSocket;
  host: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

interface Binding {
  role: CompanionRelayRole;
  /** One connection may serve many routes: the host socket registers one token per paired device. */
  tokens: Set<string>;
}

interface QueuedFrame {
  from: CompanionRelayRole;
  payload: string;
  bytes: number;
  expiresAt: number;
}

// 前缀只在 shared 契约里定义一次：对空凭据编码得到的就是前缀本身，避免两端各抄一份常量。
const COMPANION_RELAY_WS_AUTH_PREFIX = companionRelayCredentialSubprotocol('');

// 票据帧的固定信封 sentinel（与 no-host 帧同一套写法）：票据不走路由，任何真实 route 的转发
// 都不会长这个样子。只有 relay 发它；旧 Host / 手机不认识该 kind，静默丢帧。新 Host 会校验同一
// sentinel（常量在 shared 契约，两侧单一真源）。

// 关顶替者连接时 close 帧带的说明（N-COMPANION-RELAY-ROUTE-TAKEOVER）：code 在 shared 契约
// （Host 侧要认），reason 只有 relay 发、没人比对，留在这里。
const CLOSE_REASON_ROUTE_TAKEN = 'ROUTE_TAKEN_OVER';

/**
 * 只有 relay 服务端解码，所以放这里不进 shared 契约（knip 死导出棘轮不扫 packages/relay）。
 * 从 `Sec-WebSocket-Protocol` 头里解凭据（node http 把重复头合并成逗号串）：取第一个带
 * 前缀的项，base64url 解码回 UTF-8。没有凭据项或编码非法都返回 null——调用方按无凭据拒。
 */
function companionRelayCredentialFromSubprotocols(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  for (const item of header.split(',')) {
    const protocol = item.trim();
    if (!protocol.startsWith(COMPANION_RELAY_WS_AUTH_PREFIX)) continue;
    const encoded = protocol.slice(COMPANION_RELAY_WS_AUTH_PREFIX.length);
    if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) return null;
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
    try {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      // 解码结果必须能原样重新编码回去，否则按非法编码拒（防宽容解码吃掉坏输入）。
      return companionRelayCredentialSubprotocol(decoded) === protocol ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length >= L.relayAuthLength && timingSafeEqual(a, b);
}

function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

/**
 * 生产 companion relay：只看信封（route token / seq / TTL），按 token 把密文帧转发给对端。
 * 信任边界与 tests/integration/companion/fakeCompanionRelay.ts 一致——不解析密文、不落盘、
 * 断线排队有界（帧数 + 字节数双上限）、对端发送缓冲有界、revoke 同步断路、过期帧/过期
 * route 定期清扫。本类只监听调用方给定的地址；公网暴露（TLS 终止）是反代层的职责。
 */
export class CompanionRelayServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly host: string;
  private readonly routes = new Map<string, Route>();
  /** pair-request 找 host 的二级索引（R2 Nit5）：`principal|instanceId` → route tokens，写入/摘除
   *  收敛在 putRoute/dropRoute。查找命中后仍以 routes 行复核——索引即使失配也只多一次校验，
   *  不会把离线电脑误报在线。 */
  private readonly routesByAccountInstance = new Map<string, Set<string>>();
  private readonly bindings = new WeakMap<WebSocket, Binding>();
  private readonly principals = new WeakMap<WebSocket, Principal>();
  private readonly lastSeen = new WeakMap<WebSocket, number>();
  private readonly waiting = new Map<string, QueuedFrame[]>();
  private readonly waitingBytes = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** 已发 ping、还没等到 pong/message 的连接：下一轮 ping 时仍在集合里 = 探活失败。 */
  private readonly pongPending = new WeakSet<WebSocket>();
  /** 已因「无实例身份注册」warn 过的连接（N-COMPANION-RELAY-ROUTE-TAKEOVER）：同一连接只打一次。 */
  private readonly legacyRegisterWarned = new WeakSet<WebSocket>();
  private readonly stats: CompanionRelayServerStats = {
    connections: 0, routes: 0, queuedFrames: 0, forwarded: 0,
    droppedExpired: 0, droppedNoRoute: 0, droppedBacklog: 0, droppedBackpressure: 0,
    revoked: 0, rejectedAuth: 0, notifiedNoHost: 0, accountConnections: 0, rejectedOwner: 0,
    ticketsIssued: 0, ticketConnections: 0, terminatedNoPong: 0, rejectedTakeover: 0,
    listHosts: 0, rejectedListHosts: 0, pairRequests: 0, rejectedPairRequests: 0, pairResults: 0,
    instanceIndexKeys: 0,
  };
  private readonly pendingPairs = new Map<string, PendingPair>();
  /** pair-request 初次请求的限流记账：每连接（WeakMap 随连接回收）与每账号（写时清过期项）。 */
  private readonly pairRateBySocket = new WeakMap<WebSocket, number>();
  private readonly pairRateByAccount = new Map<Principal, number>();
  private readonly now: () => number;

  constructor(private readonly options: {
    credential: string;
    host?: string;
    port?: number;
    now?: () => number;
    sweepIntervalMs?: number;
    pingIntervalMs?: number;
    noHostGraceMs?: number;
    /** 找回配对挂起 TTL（N-COMPANION-RELAY-ACCOUNT-RECOVER）；测试注入用，缺省 COMPANION_LIMITS。 */
    pairTtlMs?: number;
    /** pair-request 初次请求限流间隔；测试注入用，缺省 COMPANION_LIMITS。 */
    pairRequestMinIntervalMs?: number;
    /** 配了就同时认 Supabase access token；不配则只认共享凭据（与账号绑定之前完全一致）。 */
    accountVerifier?: { verify(token: string): string | null; readonly stats: JwksStats };
    /** 配了就认 relay 自签设备票据并向账号连接签发/续签（N-COMPANION-RELAY-DEVICE-TICKET）。 */
    ticketAuth?: RelayTicketAuth;
    logger?: CompanionRelayLogger;
  }) {
    this.host = options.host ?? '127.0.0.1';
    this.now = options.now ?? Date.now;
    if (options.credential.length < L.relayAuthLength) {
      throw new Error('COMPANION_RELAY_CREDENTIAL_TOO_SHORT');
    }
  }

  get address(): { host: string; port: number } { return { host: this.host, port: this.port }; }
  get currentStats(): CompanionRelayServerStats {
    const stats: CompanionRelayServerStats = {
      ...this.stats,
      routes: this.routes.size,
      queuedFrames: this.queueSize(),
      instanceIndexKeys: this.routesByAccountInstance.size,
    };
    if (this.options.accountVerifier) stats.jwks = this.options.accountVerifier.stats;
    return stats;
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) return this.address;
    const server = createServer((request, response) => this.onHttpRequest(request, response));
    const wss = new WebSocketServer({
      server,
      maxPayload: L.relayMaxWireFrameBytes,
      // 手机侧凭据走子协议：客户端发了协议名必须回选（浏览器在「发了子协议、服务端没选」时
      // 直接断开），但只回选固定协议名——凭据项绝不回选或回显。
      handleProtocols: protocols => protocols.has(COMPANION_RELAY_WS_PROTOCOL) ? COMPANION_RELAY_WS_PROTOCOL : false,
    });
    wss.on('connection', (socket, request) => this.accept(socket, request));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.host, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.wss = wss;
    this.port = (server.address() as { port: number }).port;
    this.sweepTimer = setInterval(() => this.sweep(), this.options.sweepIntervalMs ?? L.relaySweepMs);
    this.sweepTimer.unref();
    this.pingTimer = setInterval(() => this.ping(), this.options.pingIntervalMs ?? L.relayPingMs);
    this.pingTimer.unref();
    this.options.logger?.info('relay_listening', { host: this.host, port: this.port });
    return this.address;
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const token of this.waiting.keys()) this.purgeWaiting(token);
    for (const pending of this.pendingPairs.values()) clearTimeout(pending.timer);
    this.pendingPairs.clear();
    this.routes.clear();
    this.routesByAccountInstance.clear();
    const wss = this.wss; this.wss = null;
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    this.stats.connections = 0;
    this.stats.accountConnections = 0;
    this.stats.ticketConnections = 0;
    this.options.logger?.info('relay_stopped', {});
  }

  /** 触发一次清扫；测试用它配合注入时钟驱动过期路径。 */
  sweep(): void {
    const now = this.now();
    for (const [token, route] of this.routes) {
      if (route.expiresAt > now) continue;
      this.dropRoute(token);
      this.purgeWaiting(token);
      this.options.logger?.info('route_expired', { token: tokenPrefix(token) });
    }
    for (const client of this.wss?.clients ?? []) {
      const seen = this.lastSeen.get(client) ?? 0;
      if (now - seen <= L.relayIdleMs) continue;
      const binding = this.bindings.get(client);
      if (binding && [...binding.tokens].some(token => this.routes.has(token))) continue;
      this.options.logger?.info('connection_idle_closed', {});
      client.close();
    }
  }

  /**
   * 触发一轮连接级探活（N-COMPANION-RELAY-KEEPALIVE）；测试用它配合注入时钟驱动 missed-pong 路径。
   * 对每条 OPEN 连接发 WS 协议层 ping；上一轮 ping 后到本轮仍无 pong/message 的连接 terminate——
   * 半开连接等不到关闭帧握手，close() 只会挂到内核超时。terminate 走既有 close → detach 清 route
   * 槽位，不用另写清理。与 idle 清扫是两条独立判据：答 pong 的连接 lastSeen 恒新，sweep 的 idle
   * 分支够不到它——连接活性不绑 route 生命周期（无 route 的 Host 连接也活得下去）。
   */
  ping(): void {
    for (const client of this.wss?.clients ?? []) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (this.pongPending.has(client)) {
        this.stats.terminatedNoPong += 1;
        this.options.logger?.info('connection_pong_timeout', {});
        client.terminate();
        continue;
      }
      this.pongPending.add(client);
      client.ping();
    }
  }

  private onHttpRequest(request: IncomingMessage, response: import('node:http').ServerResponse): void {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(this.currentStats));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    // 鉴权顺序：先 Authorization 头（Host 继续用它），没有再从子协议里解凭据（手机 WebView
    // 设不了请求头）。via 只进日志的来源标记，凭据与其编码绝不落日志。
    const header = request.headers.authorization;
    const headerAuth = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
    const subprotocolAuth = headerAuth ? null : companionRelayCredentialFromSubprotocols(request.headers['sec-websocket-protocol']);
    const via: 'header' | 'subprotocol' | 'none' = headerAuth ? 'header' : subprotocolAuth !== null ? 'subprotocol' : 'none';
    const auth = headerAuth || subprotocolAuth || '';
    // 鉴权三级：共享凭据先比（常量时间）；不是它且以 neo1. 开头按设备票据验（HMAC + 未过期）；
    // 其余按账号令牌验签。三者都不过才 auth_rejected。票据与令牌得到同一个主人 acct:<sub>，
    // 后续逻辑（路由主人隔离、容量分账）完全复用，不另开分支。sub 不进日志。
    // 令牌只在 upgrade 时验：连接存活期间过期或电脑退出登录都不断开——Host 退出登录会自己关账号连接
    // 并作废本地票据（票据是 30 天 bearer 凭据，relay 侧没有按账号吊销的通道；Host 退出时不清它，
    // 它就会在登出后继续自动重连，「Host 自己管连接」这个前提就被掏空），每次重连都换新凭据；
    // relay 主动踢过期连接只会制造重连风暴。要做按账号封禁时再补连接级复核。
    const legacy = sameSecret(auth, this.options.credential);
    let sub: string | null = null;
    let ticketExp: number | null = null;
    if (!legacy && this.options.ticketAuth && auth.startsWith('neo1.')) {
      const ticket = this.options.ticketAuth.verify(auth);
      if (ticket) {
        sub = ticket.sub;
        ticketExp = ticket.exp;
      }
    } else if (!legacy) {
      sub = this.options.accountVerifier?.verify(auth) ?? null;
    }
    const principal = legacy ? LEGACY_PRINCIPAL : sub ? `acct:${sub}` : null;
    if (!principal) {
      this.stats.rejectedAuth += 1;
      this.options.logger?.warn('auth_rejected', { via });
      socket.close();
      return;
    }
    this.principals.set(socket, principal);
    // 账号主人的在线连接分两本账：以票据进来的记 ticketConnections，以令牌进来的记 accountConnections。
    const viaTicket = ticketExp !== null;
    if (viaTicket) this.stats.ticketConnections += 1;
    else if (sub) this.stats.accountConnections += 1;
    this.stats.connections += 1;
    this.lastSeen.set(socket, this.now());
    if (sub && this.options.ticketAuth) {
      // 用 access token 进来的（ticketExp 还是 null）立刻下发新票据；用票据进来的只在剩余有效期 < 续签阈值时续签。
      // ponytail: 续签无上限、也没有按账号吊销票据的通道——同一把密钥下 30 天票只要一直连就能无限续命；
      // 全局作废只有删密钥文件一档（粒度是「全部账号」不是「某个账号」）。要按账号封禁时得先补连接级复核
      // （upgrade 只验一次、连接期内不复核，见上面鉴权注释），再给验签加账号级吊销名单。
      if (ticketExp === null || ticketExp - this.now() < L.relayTicketRenewBeforeMs) this.sendTicket(socket, sub, viaTicket);
    }
    socket.on('message', data => {
      this.lastSeen.set(socket, this.now());
      this.pongPending.delete(socket);
      try {
        this.onFrame(socket, parseCompanionRelayFrame(JSON.parse(String(data)) as unknown), String(data));
      } catch {
        socket.close();
      }
    });
    // 收到 pong 与收到 message 同权刷新 lastSeen：这是「连接活性不绑 route」的关键一路——
    // 答 pong 的连接（哪怕零 route）now - seen <= relayIdleMs 恒真，sweep 的 idle 分支够不到它。
    socket.on('pong', () => {
      this.lastSeen.set(socket, this.now());
      this.pongPending.delete(socket);
    });
    const openedAt = this.now();
    socket.on('close', code => {
      this.stats.connections = Math.max(0, this.stats.connections - 1);
      if (viaTicket) this.stats.ticketConnections = Math.max(0, this.stats.ticketConnections - 1);
      else if (sub) this.stats.accountConnections = Math.max(0, this.stats.accountConnections - 1);
      // 设备/宿主腿断开必须留痕（N-MOBILE-SEND-RESULT-LOST）：只记 role、token 前缀、存活时长、
      // close code 与鉴权类别——票据/令牌/凭据全文照旧绝不进日志（sub 不进日志）。
      const binding = this.bindings.get(socket);
      this.options.logger?.info('connection_closed', {
        role: binding?.role ?? 'unbound',
        auth: viaTicket ? 'ticket' : sub ? 'account' : 'legacy',
        tokens: binding ? [...binding.tokens].map(tokenPrefix) : [],
        closeCode: code,
        uptimeMs: this.now() - openedAt,
      });
      this.detach(socket);
      this.detachPairs(socket);
    });
    socket.on('error', () => { /* close follows */ });
  }

  /** 往刚鉴权成功的账号连接发一帧设备票据（issue/renew 都走这里）。票据绝不进日志，只记事件名。 */
  private sendTicket(socket: WebSocket, sub: string, renewed: boolean): void {
    const ticketAuth = this.options.ticketAuth;
    if (!ticketAuth || socket.readyState !== WebSocket.OPEN) return;
    const { ticket } = ticketAuth.issue(sub);
    socket.send(JSON.stringify({
      v: 1, kind: 'ticket',
      envelope: { routeToken: COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN, deviceRef: COMPANION_RELAY_SENTINEL_DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now() },
      ciphertext: ticket,
    } satisfies CompanionRelayFrame));
    this.stats.ticketsIssued += 1;
    this.options.logger?.info(renewed ? 'ticket_renewed' : 'ticket_issued');
  }

  /** routes 的写入唯一入口：主表 set 的同时维护 account×instance 二级索引（R2 Nit5）。改写
   *  hostInstanceId（同 token 换实例重注册）必须先把 token 从旧实例键摘除（R3 Important）——
   *  否则旧键只加不删，桌面 Neo 每重启一次就多一个永不回收的键，只能靠重启 relay 释放。 */
  private putRoute(token: string, route: Route, prevInstanceId?: string): void {
    this.routes.set(token, route);
    this.dropInstanceIndex(token, route.owner, prevInstanceId);
    if (!route.hostInstanceId) return;
    const key = `${route.owner}|${route.hostInstanceId}`;
    const tokens = this.routesByAccountInstance.get(key) ?? new Set<string>();
    tokens.add(token);
    this.routesByAccountInstance.set(key, tokens);
  }

  /** routes 的删除唯一入口（stop 的整表清空除外）：连带从二级索引按当前实例键摘除（R2 Nit5）。 */
  private dropRoute(token: string): void {
    const route = this.routes.get(token);
    if (!route) return;
    this.routes.delete(token);
    this.dropInstanceIndex(token, route.owner, route.hostInstanceId);
  }

  /** 二级索引的摘除唯一入口：register 改写实例前（按旧 instanceId）与 dropRoute（按当前值）共用，
   *  保证 register / unregister / 过期清扫三条路径的加删对称。owner 在路由生命周期内不变
   *  （register 拒换主人），旧键与新键同用 route.owner 拼不会错位。 */
  private dropInstanceIndex(token: string, owner: Principal, instanceId: string | undefined): void {
    if (!instanceId) return;
    const key = `${owner}|${instanceId}`;
    const tokens = this.routesByAccountInstance.get(key);
    if (!tokens) return;
    tokens.delete(token);
    if (!tokens.size) this.routesByAccountInstance.delete(key);
  }

  /** pair-request 的目标查找：索引直达 + routes 行复核，替代逐帧全表扫（R2 Nit5）。 */
  private onlineHostFor(principal: Principal, instanceId: string): WebSocket | undefined {
    const tokens = this.routesByAccountInstance.get(`${principal}|${instanceId}`);
    if (!tokens) return undefined;
    for (const token of tokens) {
      const route = this.routes.get(token);
      if (!route || route.owner !== principal || route.hostInstanceId !== instanceId) continue;
      if (route.host?.readyState === WebSocket.OPEN) return route.host;
    }
    return undefined;
  }

  private detach(socket: WebSocket): void {
    const binding = this.bindings.get(socket);
    if (!binding) return;
    for (const token of binding.tokens) {
      const route = this.routes.get(token);
      if (!route) continue;
      if (route[binding.role] === socket) delete route[binding.role];
      if (!route.host && !route.device) this.dropRoute(token);
      // host 腿断开而设备腿还在：手机仍握着与旧 Host 实例谈好的会话密钥，Host 重连后会话表
      // 已清，它的 forward 只能被吞——照 no-host 宽限模式给它一个重拨重握手的推力
      // （N-COMPANION-RELAY-RECONNECT-DROPSESSIONS）。槽位已被新 socket 顶替时这里不挂
      // （换实例场景由 register 分支的顶替检测覆盖）。
      if (binding.role === 'host' && !route.host && route.device && route.device.readyState === WebSocket.OPEN) {
        this.notifyHostLegDetachAfterGrace(token, route.device);
      }
    }
  }

  private onFrame(socket: WebSocket, frame: CompanionRelayFrame, raw: string): void {
    if (companionRelayFrameExpired(frame, this.now())) {
      this.stats.droppedExpired += 1;
      return;
    }
    const token = frame.envelope.routeToken;
    if (frame.kind === 'register') {
      const principal = this.principals.get(socket) ?? LEGACY_PRINCIPAL;
      const known = this.routes.get(token);
      if (!known && this.capacityReached(principal)) {
        if (principal === LEGACY_PRINCIPAL) {
          this.stats.droppedNoRoute += 1;
          this.options.logger?.warn('route_capacity_reached', { routes: this.routes.size });
        } else {
          this.stats.rejectedOwner += 1;
          this.options.logger?.warn('account_route_quota_reached', { role: frame.role });
        }
        return;
      }
      const existing = this.bindings.get(socket);
      if (existing && existing.role !== frame.role) {
        // A connection speaks one role for its whole life; letting a device flip to
        // host mid-connection would hand it the revoke path.
        this.stats.droppedNoRoute += 1;
        this.options.logger?.warn('register_role_mismatch', { role: frame.role, token: tokenPrefix(token) });
        return;
      }
      if (known && known.owner !== principal) {
        // 路由 token 本身是秘密，走到这里说明有人拿着别人的 token 换身份来登记：拒，不动原路由。
        this.stats.rejectedOwner += 1;
        this.options.logger?.warn('route_owner_mismatch', { role: frame.role, token: tokenPrefix(token) });
        return;
      }
      // 顶替判据（N-COMPANION-RELAY-ROUTE-TAKEOVER）：同 token 的 host 槽被另一条 OPEN 连接占着时，
      // routeToken 是持久身份确定性派生的，共用数据目录的另一个 Host 进程算出同一批 token——
      // 「谁在位」必须按实例身份分辨，否则顶替成功的唯一痕迹是一条与正常注册不可分辨的 info 日志。
      // 只判 host 槽：手机（device 角色）没有实例身份，重连顶替是常态，维持原行为。
      if (frame.role === 'host' && known?.host && known.host !== socket && known.host.readyState === WebSocket.OPEN) {
        if (frame.instanceId && known.hostInstanceId) {
          if (frame.instanceId !== known.hostInstanceId) {
            // 不同实例 = 顶替：不覆盖、留痕、关顶替者（code 走 4000 段自定值，Host 侧单具名码报警）。
            // 原路由不动：在位实例零感知地被换掉，正是本单要堵的洞。
            this.stats.rejectedTakeover += 1;
            this.options.logger?.warn('route_takeover_rejected', {
              role: frame.role, token: tokenPrefix(token),
              incumbent: known.hostInstanceId.slice(0, 8), challenger: frame.instanceId.slice(0, 8),
            });
            socket.close(COMPANION_RELAY_CLOSE_CODE_ROUTE_TAKEN, CLOSE_REASON_ROUTE_TAKEN);
            return;
          }
          // 相同 = 同实例重连（旧 socket 的关闭还没到）：放行，重连路径不许被顶替检测掐死。
        } else if (!frame.instanceId && !this.legacyRegisterWarned.has(socket)) {
          // 注册侧缺实例身份（旧 Host）：判不了顶替，维持放行，但 warn 一次让「无实例身份注册」有迹可循。
          this.legacyRegisterWarned.add(socket);
          this.options.logger?.warn('register_without_instance_id', { role: frame.role, token: tokenPrefix(token) });
        }
      }
      const route: Route = known ?? { owner: principal, expiresAt: this.now() + L.relayRouteTokenTtlMs };
      // 同 token 的 host 槽被另一条 socket 顶替（Host 换实例重连、旧 socket 的关闭还没到）：
      // 对设备腿来说谈判对象已经换了，照 host 腿断开同款宽限处理。到期复查时 host 槽若仍被
      // 占着（顶替者活着），说明 host 在位，什么都不发——不许踢一个 host 在位的健康对。
      const displacedHost = frame.role === 'host' ? known?.host : undefined;
      // 改写前先留旧实例身份（R3 Important）：putRoute 要按它摘旧索引键，route 对象随后就被改写。
      const prevInstanceId = known?.hostInstanceId;
      route[frame.role] = socket;
      if (frame.role === 'host') {
        route.hostInstanceId = frame.instanceId;
        route.hostName = frame.hostName;
        route.hostKeyFingerprint = frame.hostKeyFingerprint;
      }
      route.expiresAt = this.now() + L.relayRouteTokenTtlMs;
      this.putRoute(token, route, prevInstanceId);
      const binding = existing ?? { role: frame.role, tokens: new Set<string>() };
      binding.tokens.add(token);
      this.bindings.set(socket, binding);
      this.options.logger?.info('registered', { role: frame.role, token: tokenPrefix(token) });
      if (displacedHost && displacedHost !== socket && route.device && route.device.readyState === WebSocket.OPEN) {
        this.notifyHostLegDetachAfterGrace(token, route.device);
      }
      this.flushWaiting(token, route);
      if (frame.role === 'device' && !route.host) this.notifyNoHostAfterGrace(token, socket);
      return;
    }
    if (frame.kind === 'heartbeat') {
      const binding = this.bindings.get(socket);
      const route = this.routes.get(token);
      // 槽主守卫（N-COMPANION-RELAY-ROUTE-TAKEOVER）：不是本 route 当前槽主的连接不许续 TTL——
      // 被顶掉的旧 Host（顶替放行路径上）socket 还开着，它的心跳照样刷 TTL，等于替顶替者养路由。
      if (route && binding?.tokens.has(token) && route[binding.role] === socket) {
        route.expiresAt = this.now() + L.relayRouteTokenTtlMs;
      }
      return;
    }
    if (frame.kind === 'revoke') {
      // Only the host side of this exact route may break the device; otherwise any
      // credential holder could DoS other routes by name.
      const binding = this.bindings.get(socket);
      if (!binding || binding.role !== 'host' || !binding.tokens.has(token)) {
        this.stats.droppedNoRoute += 1;
        this.options.logger?.warn('revoke_rejected', { token: tokenPrefix(token) });
        return;
      }
      this.breakDevice(token);
      return;
    }
    if (frame.kind === 'unregister' || frame.kind === 'disconnect') {
      const binding = this.bindings.get(socket);
      const route = this.routes.get(token);
      if (route && binding?.tokens.has(token) && route[binding.role] === socket) {
        delete route[binding.role];
        binding.tokens.delete(token);
        if (!route.host && !route.device) this.dropRoute(token);
      }
      return;
    }
    if (frame.kind === 'ack') return;
    if (frame.kind === 'list-hosts') { this.onListHosts(socket); return; }
    if (frame.kind === 'pair-request') { this.onPairRequest(socket, frame, raw); return; }
    if (frame.kind === 'pair-result') { this.onPairResult(socket, frame, raw); return; }
    const route = this.routes.get(token);
    const binding = this.bindings.get(socket);
    if (!route || !binding || route.expiresAt <= this.now()
      || !binding.tokens.has(token) || route[binding.role] !== socket) {
      this.stats.droppedNoRoute += 1;
      return;
    }
    const peer = binding.role === 'host' ? route.device : route.host;
    if (!peer || peer.readyState !== WebSocket.OPEN) {
      const queued = this.waiting.get(token) ?? [];
      const bytes = raw.length;
      if (queued.length >= L.relayMaxBufferedFrames
        || (this.waitingBytes.get(token) ?? 0) + bytes > L.relayMaxBufferedBytes) {
        this.stats.droppedBacklog += 1;
        return;
      }
      queued.push({ from: binding.role, payload: raw, bytes, expiresAt: frame.envelope.issuedAt + frame.envelope.ttlMs });
      this.waiting.set(token, queued);
      this.waitingBytes.set(token, (this.waitingBytes.get(token) ?? 0) + bytes);
      return;
    }
    if (peer.bufferedAmount + raw.length > L.relayMaxBufferedBytes) {
      this.stats.droppedBackpressure += 1;
      return;
    }
    peer.send(raw);
    this.stats.forwarded += 1;
  }

  /**
   * list-hosts（N-COMPANION-RELAY-ACCOUNT-RECOVER）：只认账号主人（JWT 或票据鉴权的连接——两者
   * 都是同一位账号主人，共享凭据的 legacy 连接没有「我的电脑」可言，发起即拒并记 stats）。
   * 遍历该主人名下 host 槽在位且 OPEN 的路由，按 hostInstanceId 去重（一台电脑为每台已配对
   * 手机登记一条路由），回 register 自报的 name/fingerprint/instanceId。路由表是内存短 TTL，
   * 这里只能列**此刻在线**的电脑——离线置灰行由手机侧产品层另想办法，本刀不做。
   */
  private onListHosts(socket: WebSocket): void {
    const principal = this.principals.get(socket) ?? LEGACY_PRINCIPAL;
    if (principal === LEGACY_PRINCIPAL) {
      this.stats.rejectedListHosts += 1;
      this.options.logger?.warn('list_hosts_rejected', { auth: 'legacy' });
      return;
    }
    const byInstance = new Map<string, { name: string; fingerprint: string; instanceId: string }>();
    for (const route of this.routes.values()) {
      if (route.owner !== principal || !route.hostInstanceId) continue;
      if (route.host?.readyState !== WebSocket.OPEN) continue;
      const known = byInstance.get(route.hostInstanceId);
      // 去重时优先留带自报名的那条（Host 新旧版本混跑的路由行都指向同一实例）。
      if (known && known.name) continue;
      byInstance.set(route.hostInstanceId, {
        name: route.hostName ?? '',
        fingerprint: route.hostKeyFingerprint ?? '',
        instanceId: route.hostInstanceId,
      });
    }
    socket.send(JSON.stringify({
      v: 1, kind: 'list-hosts',
      envelope: { routeToken: COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN, deviceRef: COMPANION_RELAY_SENTINEL_DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now() },
      ciphertext: JSON.stringify([...byInstance.values()]),
    } satisfies CompanionRelayFrame));
    this.stats.listHosts += 1;
    this.options.logger?.info('list_hosts_served', { hosts: byInstance.size });
  }

  /**
   * pair-request（N-COMPANION-RELAY-ACCOUNT-RECOVER）。带 instanceId 的是初次请求：发起方必须是
   * 账号主人、过限流（每连接与每账号，防卡片轰炸电脑），目标实例不在主人名下的在线 host 槽 ⇒
   * 立刻回具名 host-offline（照 no-host 哲学，手机秒级失败）；在 ⇒ 原样投递到该 Host 连接并挂起
   * pending，relayPairTtlMs 内 Host 没给结论就替它回 timeout。不带 instanceId 的是同一交换的续帧
   * （XX 第三条消息）：只认挂起态里的原手机连接，原样转发、不计限流。
   */
  private onPairRequest(socket: WebSocket, frame: Extract<CompanionRelayFrame, { kind: 'pair-request' }>, raw: string): void {
    const principal = this.principals.get(socket) ?? LEGACY_PRINCIPAL;
    if (principal === LEGACY_PRINCIPAL) {
      this.stats.rejectedPairRequests += 1;
      this.options.logger?.warn('pair_request_rejected', { auth: 'legacy' });
      return;
    }
    const requestId = frame.requestId;
    if (!frame.instanceId) {
      const pending = this.pendingPairs.get(requestId);
      if (!pending || pending.phone !== socket) {
        this.stats.rejectedPairRequests += 1;
        this.options.logger?.warn('pair_request_unmatched', {});
        return;
      }
      if (pending.host.readyState !== WebSocket.OPEN) {
        clearTimeout(pending.timer);
        this.pendingPairs.delete(requestId);
        this.sendPairResult(pending.phone, requestId, 'host-offline');
        return;
      }
      pending.host.send(raw);
      return;
    }
    if (this.pendingPairs.has(requestId)) {
      this.stats.rejectedPairRequests += 1;
      this.options.logger?.warn('pair_request_rejected', { reason: 'duplicate' });
      return;
    }
    const now = this.now();
    const minIntervalMs = this.options.pairRequestMinIntervalMs ?? L.relayPairRequestMinIntervalMs;
    if (now - (this.pairRateBySocket.get(socket) ?? 0) < minIntervalMs
      || now - (this.pairRateByAccount.get(principal) ?? 0) < minIntervalMs) {
      this.stats.rejectedPairRequests += 1;
      this.options.logger?.warn('pair_request_rejected', { reason: 'rate-limited' });
      this.sendPairResult(socket, requestId, 'rate-limited');
      return;
    }
    // 记账紧随限流检查（R2 Nit5）：过检的初次请求无论后面成不成都占频次——指向不存在
    // instanceId 的探测/轰炸与真实请求同一节奏，不能免限流地反复打进来。
    this.pairRateBySocket.set(socket, now);
    // 写时顺手清过期项：这张表的量级 = 真实发起过找回的账号数，不清才会被轮换 sub 撑大。
    for (const [account, at] of this.pairRateByAccount) {
      if (now - at >= minIntervalMs) this.pairRateByAccount.delete(account);
    }
    this.pairRateByAccount.set(principal, now);
    const host = this.onlineHostFor(principal, frame.instanceId);
    if (!host) {
      this.stats.rejectedPairRequests += 1;
      this.options.logger?.info('pair_request_no_host', { target: frame.instanceId.slice(0, 8) });
      this.sendPairResult(socket, requestId, 'host-offline');
      return;
    }
    const timer = setTimeout(() => {
      this.pendingPairs.delete(requestId);
      this.sendPairResult(socket, requestId, 'timeout');
      this.options.logger?.info('pair_request_timeout', {});
    }, this.options.pairTtlMs ?? L.relayPairTtlMs);
    timer.unref();
    this.pendingPairs.set(requestId, { phone: socket, host, timer });
    host.send(raw);
    this.stats.pairRequests += 1;
    this.options.logger?.info('pair_request_forwarded', { target: frame.instanceId.slice(0, 8) });
  }

  /**
   * Host 的 pair-result：只认挂起态里那条 Host 连接发的，原样回手机。同意应答（stage 'reply'）
   * **不是终局**——转发后挂起态保留，等手机的续帧与 Host 的 complete；终局（拒绝 / complete）
   * 才销账。迟到的终局对不上挂起态 ⇒ 丢掉留痕。
   */
  private onPairResult(socket: WebSocket, frame: Extract<CompanionRelayFrame, { kind: 'pair-result' }>, raw: string): void {
    const pending = this.pendingPairs.get(frame.requestId);
    if (!pending || pending.host !== socket) {
      this.stats.rejectedPairRequests += 1;
      this.options.logger?.warn('pair_result_unmatched', {});
      return;
    }
    const terminal = !frame.accepted || frame.stage !== 'reply';
    if (terminal) {
      clearTimeout(pending.timer);
      this.pendingPairs.delete(frame.requestId);
    }
    if (pending.phone.readyState !== WebSocket.OPEN) return;
    pending.phone.send(raw);
    this.stats.pairResults += 1;
  }

  /** relay 合成的具名拒绝回帧（host-offline / timeout / rate-limited）：sentinel 信封，与 Host 发的同一形状。
   *  计数收在这里（R3 Nit1 统一口径）：合成回帧只要真发出去了就计 pairResults，调用方不再各记各的。 */
  private sendPairResult(socket: WebSocket, requestId: string, reason: 'host-offline' | 'timeout' | 'rate-limited'): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      v: 1, kind: 'pair-result',
      envelope: { routeToken: COMPANION_RELAY_PAIR_ROUTE_TOKEN, deviceRef: COMPANION_RELAY_SENTINEL_DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now() },
      requestId, accepted: false, reason, ciphertext: '',
    } satisfies CompanionRelayFrame));
    this.stats.pairResults += 1;
  }

  /**
   * 配对挂起态随连接断开清理：手机腿没了 ⇒ 直接销账（没人等结论了）；Host 腿断了 ⇒ 替它回
   * host-offline，别让手机干等自己的握手超时。
   */
  private detachPairs(socket: WebSocket): void {
    for (const [requestId, pending] of this.pendingPairs) {
      if (pending.phone === socket) {
        clearTimeout(pending.timer);
        this.pendingPairs.delete(requestId);
        continue;
      }
      if (pending.host === socket) {
        clearTimeout(pending.timer);
        this.pendingPairs.delete(requestId);
        this.sendPairResult(pending.phone, requestId, 'host-offline');
        this.options.logger?.info('pair_host_leg_closed', {});
      }
    }
  }

  /**
   * 设备注册到没有 host 的 route（Host 没开，或手机缓存的 token 已不是 Host 在用的那个）：宽限期
   * 后 host 仍不在就回 no-host 帧，并丢掉这台设备排着的帧——否则手机要干等自己的握手超时
   * （FB-194）。宽限期内 host 重连上来，flushWaiting 照常转发，定时器到点时看到 host 在就什么都不做。
   */
  private notifyNoHostAfterGrace(token: string, device: WebSocket): void {
    const timer = setTimeout(() => {
      const route = this.routes.get(token);
      if (!route || route.host || route.device !== device || device.readyState !== WebSocket.OPEN) return;
      this.purgeWaiting(token);
      const now = this.now();
      device.send(JSON.stringify({
        v: 1, kind: 'no-host',
        envelope: { routeToken: token, deviceRef: COMPANION_RELAY_SENTINEL_DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: now },
        ciphertext: '',
      } satisfies CompanionRelayFrame));
      this.stats.notifiedNoHost += 1;
      this.options.logger?.info('no_host_notified', { token: tokenPrefix(token) });
    }, this.options.noHostGraceMs ?? L.relayNoHostGraceMs);
    timer.unref();
  }

  /**
   * host 腿断开/被顶替，route 上还挂着设备腿（N-COMPANION-RELAY-RECONNECT-DROPSESSIONS）：
   * 手机握着的会话密钥属于旧 host 实例，Host 重连后会话表已清，forward 只能被静默吞。照
   * notifyNoHostAfterGrace 同款宽限：期内 host 重新注册回来（host 槽非空）就什么都不做——
   * 与它的计时器通过 route 表互见，host 回来了谁都不许再踢设备；到点复查 host 槽确实仍空、
   * 设备腿还是原来那条且在线，才回 no-host 帧并丢掉这台设备排着的帧，手机据此重拨重握手
   * （帧形状与 notifyNoHostAfterGrace 完全一致，手机端零改动）。
   */
  private notifyHostLegDetachAfterGrace(token: string, device: WebSocket): void {
    const timer = setTimeout(() => {
      const route = this.routes.get(token);
      if (!route || route.host || route.device !== device || device.readyState !== WebSocket.OPEN) return;
      this.purgeWaiting(token);
      const now = this.now();
      device.send(JSON.stringify({
        v: 1, kind: 'no-host',
        envelope: { routeToken: token, deviceRef: COMPANION_RELAY_SENTINEL_DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: now },
        ciphertext: '',
      } satisfies CompanionRelayFrame));
      this.stats.notifiedNoHost += 1;
      this.options.logger?.info('host_leg_detached_notify', { token: tokenPrefix(token) });
    }, this.options.noHostGraceMs ?? L.relayNoHostGraceMs);
    timer.unref();
  }

  /**
   * 新建路由的容量：共享凭据与账号各算各的，账号再按主人限额。账号令牌谁注册都能拿到，
   * 既不能让一个账号占满、也不能让一群账号挤掉共享凭据通道（ai-review PR#1926 第 2、3 轮）。
   * ponytail: 新建路由时线性数一遍（总量 ≤ relayMaxRoutes + relayMaxAccountRoutes），量级上去再换计数表。
   */
  private capacityReached(principal: Principal): boolean {
    const owners = [...this.routes.values()].map(route => route.owner);
    if (principal === LEGACY_PRINCIPAL) return owners.filter(owner => owner === LEGACY_PRINCIPAL).length >= L.relayMaxRoutes;
    return owners.filter(owner => owner !== LEGACY_PRINCIPAL).length >= L.relayMaxAccountRoutes
      || owners.filter(owner => owner === principal).length >= L.relayMaxRoutesPerAccount;
  }

  private flushWaiting(token: string, route: Route): void {
    const queued = this.waiting.get(token);
    if (!queued?.length || !route.host || !route.device) return;
    if (route.host.readyState !== WebSocket.OPEN || route.device.readyState !== WebSocket.OPEN) return;
    this.waiting.delete(token);
    this.waitingBytes.delete(token);
    const now = this.now();
    for (const item of queued) {
      if (item.expiresAt <= now) {
        // Frames must not outlive their envelope TTL while waiting for the peer.
        this.stats.droppedExpired += 1;
        continue;
      }
      const to = item.from === 'host' ? route.device : route.host;
      if (to.readyState === WebSocket.OPEN) {
        to.send(item.payload);
        this.stats.forwarded += 1;
      } else {
        this.stats.droppedBacklog += 1;
      }
    }
  }

  private purgeWaiting(token: string): void {
    this.waiting.delete(token);
    this.waitingBytes.delete(token);
  }

  private queueSize(): number {
    let total = 0;
    for (const queued of this.waiting.values()) total += queued.length;
    return total;
  }

  private breakDevice(token: string): void {
    this.purgeWaiting(token);
    const route = this.routes.get(token);
    if (!route) return;
    const device = route.device;
    delete route.device;
    if (!route.host) this.dropRoute(token);
    if (device && device.readyState < WebSocket.CLOSING) device.close();
    this.stats.revoked += 1;
    this.options.logger?.warn('revoked', { token: tokenPrefix(token) });
  }
}
