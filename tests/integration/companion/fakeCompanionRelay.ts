import { createServer, type Server, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
} from '../../../src/shared/contract/companionRelay';

type CompanionRelayRole = 'host' | 'device';

interface Route {
  host?: WebSocket;
  device?: WebSocket;
  expiresAt: number;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length >= L.relayAuthLength && timingSafeEqual(a, b);
}

/** Loopback relay: routes ciphertext by token, never inspects payload contents. */
export class FakeCompanionRelay {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly routes = new Map<string, Route>();
  private readonly roles = new WeakMap<WebSocket, { role: CompanionRelayRole; token: string }>();
  readonly captures: string[] = [];
  dropped = 0;
  dropKeys = new Set<string>();
  holdKeys = new Set<string>();
  private held: Array<{ key: string; to: WebSocket; payload: string }> = [];
  private readonly waiting = new Map<string, Array<{ from: CompanionRelayRole; payload: string }>>();
  constructor(private readonly credential: string, private readonly now: () => number = Date.now) {}

  get url(): string { return `ws://127.0.0.1:${this.port}`; }
  get routeCount(): number { return this.routes.size; }
  deviceOpen(token: string): boolean {
    const device = this.routes.get(token)?.device;
    return !!device && device.readyState === WebSocket.OPEN;
  }

  async listen(port = 0): Promise<string> {
    if (this.server) return this.url;
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket, request) => this.accept(socket, request));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.wss = wss;
    this.port = (server.address() as { port: number }).port;
    return this.url;
  }

  async restart(): Promise<string> {
    const port = this.port;
    await this.stop();
    return this.listen(port);
  }

  async stop(): Promise<void> {
    this.held.length = 0;
    this.waiting.clear();
    this.routes.clear();
    const wss = this.wss; this.wss = null;
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  releaseHeld(): void {
    const pending = this.held.splice(0);
    for (const item of pending) {
      if (item.to.readyState === WebSocket.OPEN) item.to.send(item.payload);
    }
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const auth = url.searchParams.get('auth') ?? '';
    if (!sameSecret(auth, this.credential)) { socket.close(); return; }
    socket.on('message', data => {
      const raw = String(data);
      this.captures.push(raw);
      try { this.onFrame(socket, parseCompanionRelayFrame(JSON.parse(raw) as unknown), raw); } catch { socket.close(); }
    });
    socket.on('close', () => this.detach(socket));
  }

  private detach(socket: WebSocket): void {
    const binding = this.roles.get(socket);
    if (!binding) return;
    const route = this.routes.get(binding.token);
    if (!route) return;
    if (route[binding.role] === socket) delete route[binding.role];
    if (!route.host && !route.device) this.routes.delete(binding.token);
  }

  private onFrame(socket: WebSocket, frame: CompanionRelayFrame, raw: string): void {
    if (companionRelayFrameExpired(frame, this.now())) return;
    const token = frame.envelope.routeToken;
    if (frame.kind === 'register') {
      const route = this.routes.get(token) ?? { expiresAt: this.now() + L.relayRouteTokenTtlMs };
      route[frame.role] = socket;
      route.expiresAt = this.now() + L.relayRouteTokenTtlMs;
      this.routes.set(token, route);
      this.roles.set(socket, { role: frame.role, token });
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
      const route = this.routes.get(token);
      const binding = this.roles.get(socket);
      if (route && binding) {
        if (route[binding.role] === socket) delete route[binding.role];
        if (!route.host && !route.device) this.routes.delete(token);
      }
      return;
    }
    if (frame.kind !== 'handshake' && frame.kind !== 'forward') return;
    const route = this.routes.get(token);
    const binding = this.roles.get(socket);
    if (!route || !binding || route.expiresAt <= this.now()) { this.dropped += 1; return; }
    const peer = binding.role === 'host' ? route.device : route.host;
    if (!peer || peer.readyState !== WebSocket.OPEN) {
      const queued = this.waiting.get(token) ?? [];
      if (queued.length >= L.relayMaxBufferedFrames) { this.dropped += 1; return; }
      queued.push({ from: binding.role, payload: raw });
      this.waiting.set(token, queued);
      return;
    }
    const key = `${binding.role}:${frame.envelope.seq}`;
    if (this.dropKeys.has(key)) return;
    if (this.holdKeys.has(key)) { this.held.push({ key, to: peer, payload: raw }); return; }
    peer.send(raw);
  }

  private flushWaiting(token: string, route: Route): void {
    const queued = this.waiting.get(token);
    if (!queued?.length || !route.host || !route.device) return;
    if (route.host.readyState !== WebSocket.OPEN || route.device.readyState !== WebSocket.OPEN) return;
    this.waiting.delete(token);
    for (const item of queued) {
      const to = item.from === 'host' ? route.device : route.host;
      if (to.readyState === WebSocket.OPEN) to.send(item.payload);
      else this.dropped += 1;
    }
  }

  private breakDevice(token: string): void {
    this.waiting.delete(token);
    const route = this.routes.get(token);
    if (!route) return;
    const device = route.device;
    delete route.device;
    if (!route.host) this.routes.delete(token);
    if (device && device.readyState < WebSocket.CLOSING) device.close();
  }
}
