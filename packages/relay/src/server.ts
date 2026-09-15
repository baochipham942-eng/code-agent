import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
} from '../../../src/shared/contract/companionRelay';

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
}

interface Route {
  host?: WebSocket;
  device?: WebSocket;
  expiresAt: number;
}

interface Binding {
  role: CompanionRelayRole;
  token: string;
  lastSeenAt: number;
}

interface QueuedFrame {
  from: CompanionRelayRole;
  payload: string;
  bytes: number;
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
  private readonly lastSeen = new WeakMap<WebSocket, number>();
  private readonly waiting = new Map<string, QueuedFrame[]>();
  private readonly waitingBytes = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly stats: CompanionRelayServerStats = {
    connections: 0, routes: 0, queuedFrames: 0, forwarded: 0,
    droppedExpired: 0, droppedNoRoute: 0, droppedBacklog: 0, droppedBackpressure: 0,
    revoked: 0, rejectedAuth: 0,
  };
  private readonly now: () => number;

  constructor(private readonly options: {
    credential: string;
    host?: string;
    port?: number;
    now?: () => number;
    sweepIntervalMs?: number;
    logger?: CompanionRelayLogger;
  }) {
    this.host = options.host ?? '127.0.0.1';
    this.now = options.now ?? Date.now;
    if (options.credential.length < L.relayAuthLength) {
      throw new Error('COMPANION_RELAY_CREDENTIAL_TOO_SHORT');
    }
  }

  get address(): { host: string; port: number } { return { host: this.host, port: this.port }; }
  get currentStats(): CompanionRelayServerStats { return { ...this.stats, routes: this.routes.size, queuedFrames: this.queueSize() }; }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) return this.address;
    const server = createServer((request, response) => this.onHttpRequest(request, response));
    const wss = new WebSocketServer({ server, maxPayload: L.relayMaxWireFrameBytes });
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
      if (binding && this.routes.has(binding.token)) continue;
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
    const header = request.headers.authorization;
    const auth = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (!sameSecret(auth, this.options.credential)) {
      this.stats.rejectedAuth += 1;
      this.options.logger?.warn('auth_rejected', {});
      socket.close();
      return;
    }
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
      this.detach(socket);
    });
    socket.on('error', () => { /* close follows */ });
  }

  private detach(socket: WebSocket): void {
    const binding = this.bindings.get(socket);
    if (!binding) return;
    const route = this.routes.get(binding.token);
    if (!route) return;
    if (route[binding.role] === socket) delete route[binding.role];
    if (!route.host && !route.device) this.routes.delete(binding.token);
  }

  private onFrame(socket: WebSocket, frame: CompanionRelayFrame, raw: string): void {
    if (companionRelayFrameExpired(frame, this.now())) {
      this.stats.droppedExpired += 1;
      return;
    }
    const token = frame.envelope.routeToken;
    if (frame.kind === 'register') {
      if (!this.routes.has(token) && this.routes.size >= L.relayMaxRoutes) {
        this.stats.droppedNoRoute += 1;
        this.options.logger?.warn('route_capacity_reached', { routes: this.routes.size });
        return;
      }
      const route: Route = this.routes.get(token) ?? { expiresAt: this.now() + L.relayRouteTokenTtlMs };
      route[frame.role] = socket;
      route.expiresAt = this.now() + L.relayRouteTokenTtlMs;
      this.routes.set(token, route);
      this.bindings.set(socket, { role: frame.role, token, lastSeenAt: this.now() });
      this.options.logger?.info('registered', { role: frame.role, token: tokenPrefix(token) });
      this.flushWaiting(token, route);
      return;
    }
    if (frame.kind === 'heartbeat') {
      const route = this.routes.get(token);
      if (route) route.expiresAt = this.now() + L.relayRouteTokenTtlMs;
      return;
    }
    if (frame.kind === 'revoke') {
      this.breakDevice(token);
      return;
    }
    if (frame.kind === 'unregister' || frame.kind === 'disconnect') {
      this.detach(socket);
      return;
    }
    if (frame.kind === 'ack') return;
    const route = this.routes.get(token);
    const binding = this.bindings.get(socket);
    if (!route || !binding || route.expiresAt <= this.now() || route[binding.role] !== socket) {
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
      queued.push({ from: binding.role, payload: raw, bytes });
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

  private flushWaiting(token: string, route: Route): void {
    const queued = this.waiting.get(token);
    if (!queued?.length || !route.host || !route.device) return;
    if (route.host.readyState !== WebSocket.OPEN || route.device.readyState !== WebSocket.OPEN) return;
    this.waiting.delete(token);
    this.waitingBytes.delete(token);
    for (const item of queued) {
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
