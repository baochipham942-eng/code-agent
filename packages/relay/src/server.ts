import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import {
  COMPANION_RELAY_WS_PROTOCOL,
  companionRelayCredentialSubprotocol,
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
} from '../../../src/shared/contract/companionRelay';
import type { JwksStats } from './accountAuth';

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
  jwks?: JwksStats;
}

/** 连接的主人：共享凭据 ⇒ legacy；账号令牌 ⇒ acct:<Supabase 用户 id>。 */
type Principal = string;
const LEGACY_PRINCIPAL: Principal = 'legacy';

interface Route {
  /** 第一次登记这条路由的连接的主人；换主人来登记（任一角色）一律拒。 */
  owner: Principal;
  host?: WebSocket;
  device?: WebSocket;
  expiresAt: number;
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
  private readonly bindings = new WeakMap<WebSocket, Binding>();
  private readonly principals = new WeakMap<WebSocket, Principal>();
  private readonly lastSeen = new WeakMap<WebSocket, number>();
  private readonly waiting = new Map<string, QueuedFrame[]>();
  private readonly waitingBytes = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly stats: CompanionRelayServerStats = {
    connections: 0, routes: 0, queuedFrames: 0, forwarded: 0,
    droppedExpired: 0, droppedNoRoute: 0, droppedBacklog: 0, droppedBackpressure: 0,
    revoked: 0, rejectedAuth: 0, notifiedNoHost: 0, accountConnections: 0, rejectedOwner: 0,
  };
  private readonly now: () => number;

  constructor(private readonly options: {
    credential: string;
    host?: string;
    port?: number;
    now?: () => number;
    sweepIntervalMs?: number;
    noHostGraceMs?: number;
    /** 配了就同时认 Supabase access token；不配则只认共享凭据（与账号绑定之前完全一致）。 */
    accountVerifier?: { verify(token: string): string | null; readonly stats: JwksStats };
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
    const stats: CompanionRelayServerStats = { ...this.stats, routes: this.routes.size, queuedFrames: this.queueSize() };
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
    this.options.logger?.info('relay_listening', { host: this.host, port: this.port });
    return this.address;
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const token of this.waiting.keys()) this.purgeWaiting(token);
    this.routes.clear();
    const wss = this.wss; this.wss = null;
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    this.stats.connections = 0;
    this.stats.accountConnections = 0;
    this.options.logger?.info('relay_stopped', {});
  }

  /** 触发一次清扫；测试用它配合注入时钟驱动过期路径。 */
  sweep(): void {
    const now = this.now();
    for (const [token, route] of this.routes) {
      if (route.expiresAt > now) continue;
      this.routes.delete(token);
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
    // 共享凭据先比（常量时间）；不是它再按账号令牌验签。sub 不进日志。
    // 令牌只在 upgrade 时验：连接存活期间过期或电脑退出登录都不断开——Host 退出登录会自己关账号连接，
    // 每次重连都换新令牌；relay 主动踢过期连接只会制造重连风暴。要做按账号封禁时再补连接级复核。
    const legacy = sameSecret(auth, this.options.credential);
    const sub = legacy ? null : this.options.accountVerifier?.verify(auth) ?? null;
    const principal = legacy ? LEGACY_PRINCIPAL : sub ? `acct:${sub}` : null;
    if (!principal) {
      this.stats.rejectedAuth += 1;
      this.options.logger?.warn('auth_rejected', { via });
      socket.close();
      return;
    }
    this.principals.set(socket, principal);
    if (sub) this.stats.accountConnections += 1;
    this.stats.connections += 1;
    this.lastSeen.set(socket, this.now());
    socket.on('message', data => {
      this.lastSeen.set(socket, this.now());
      try {
        this.onFrame(socket, parseCompanionRelayFrame(JSON.parse(String(data)) as unknown), String(data));
      } catch {
        socket.close();
      }
    });
    socket.on('close', () => {
      this.stats.connections = Math.max(0, this.stats.connections - 1);
      if (sub) this.stats.accountConnections = Math.max(0, this.stats.accountConnections - 1);
      this.detach(socket);
    });
    socket.on('error', () => { /* close follows */ });
  }

  private detach(socket: WebSocket): void {
    const binding = this.bindings.get(socket);
    if (!binding) return;
    for (const token of binding.tokens) {
      const route = this.routes.get(token);
      if (!route) continue;
      if (route[binding.role] === socket) delete route[binding.role];
      if (!route.host && !route.device) this.routes.delete(token);
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
      const route: Route = known ?? { owner: principal, expiresAt: this.now() + L.relayRouteTokenTtlMs };
      route[frame.role] = socket;
      route.expiresAt = this.now() + L.relayRouteTokenTtlMs;
      this.routes.set(token, route);
      const binding = existing ?? { role: frame.role, tokens: new Set<string>() };
      binding.tokens.add(token);
      this.bindings.set(socket, binding);
      this.options.logger?.info('registered', { role: frame.role, token: tokenPrefix(token) });
      this.flushWaiting(token, route);
      if (frame.role === 'device' && !route.host) this.notifyNoHostAfterGrace(token, socket);
      return;
    }
    if (frame.kind === 'heartbeat') {
      const binding = this.bindings.get(socket);
      const route = this.routes.get(token);
      if (route && binding?.tokens.has(token)) route.expiresAt = this.now() + L.relayRouteTokenTtlMs;
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
        if (!route.host && !route.device) this.routes.delete(token);
      }
      return;
    }
    if (frame.kind === 'ack') return;
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
        envelope: { routeToken: token, deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: now },
        ciphertext: '',
      } satisfies CompanionRelayFrame));
      this.stats.notifiedNoHost += 1;
      this.options.logger?.info('no_host_notified', { token: tokenPrefix(token) });
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
    if (!route.host) this.routes.delete(token);
    if (device && device.readyState < WebSocket.CLOSING) device.close();
    this.stats.revoked += 1;
    this.options.logger?.warn('revoked', { token: tokenPrefix(token) });
  }
}
