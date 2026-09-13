import WebSocket from 'ws';
import type { KeyPair } from 'noise-handshake';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { createHandshake, NoiseChannel } from '../../../shared/companion/noiseChannel';
import { fromHex, toHex } from '../../../shared/companion/lanProtocol';
import { companionCommandSchema, type CompanionCommand, type CompanionSubmitResult } from '../../../shared/contract/companion';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
  type CompanionRelayResolved,
} from '../../../shared/contract/companionRelay';
import type { CompanionGateway } from './CompanionGateway';
import { RelayOutboundBuffer, RelaySeqBuffer } from './companionRelayBuffer';
import { loadCompanionRelayConfig, loadCompanionRelayCredential } from './companionRelayConfig';

interface CompanionRelayRoute {
  deviceRef: string;
  routeToken: string;
}

interface DeviceSession {
  cipher: NoiseChannel;
  publicKey: string;
  inbound: RelaySeqBuffer;
}

/** commandId must survive the relay hop; do not mint a new id here. */
function submitRelayedCommand(gateway: CompanionGateway, command: CompanionCommand): CompanionSubmitResult {
  return gateway.submit(command);
}

export class CompanionRelayClient {
  private socket: WebSocket | null = null;
  private readonly buffer = new RelayOutboundBuffer();
  private readonly routes = new Map<string, CompanionRelayRoute>();
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly inbound = new Map<string, RelaySeqBuffer>();
  private readonly peerSeq = new Map<string, number>();
  private controlSeq = 0;
  private stopped = true;
  private allowReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private live = false;
  private openWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(private readonly deps: {
    gateway: CompanionGateway;
    identity: KeyPair;
    config: CompanionRelayResolved;
    credential: string;
    now?: () => number;
    jitter?: () => number;
    WebSocket?: typeof WebSocket;
  }) {
    this.now = deps.now ?? Date.now;
    this.jitter = deps.jitter ?? Math.random;
    this.WebSocketImpl = deps.WebSocket ?? WebSocket;
  }

  advertise(route: CompanionRelayRoute): void {
    this.routes.set(route.deviceRef, route);
    if (this.socket?.readyState === WebSocket.OPEN) this.sendRegister(route);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.allowReconnect = true;
    try { await this.dial(); } catch { this.scheduleReconnect(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.allowReconnect = false;
    this.live = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.dropSessions();
    this.buffer.clear();
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState >= WebSocket.CLOSING) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      timer.unref();
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      socket.close();
    });
  }

  whenConnected(): Promise<void> {
    if (this.live && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise(resolve => { this.openWaiters.push(resolve); });
  }

  get bufferedCount(): number { return this.buffer.size; }
  get droppedCount(): number { return this.buffer.dropped; }

  revoke(deviceId: string): void {
    const route = this.routes.get(deviceId);
    if (route) this.push({ v: 1, kind: 'revoke', envelope: this.controlEnvelope(route), ciphertext: '' });
    this.forget(deviceId);
    this.routes.delete(deviceId);
  }

  enqueueWhileDisconnected(frame: CompanionRelayFrame): 'queued' | 'dropped' {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return 'queued';
    }
    return this.buffer.enqueue(frame);
  }

  private forget(deviceRef: string): void {
    this.sessions.get(deviceRef)?.cipher.close();
    this.sessions.delete(deviceRef);
    this.inbound.delete(deviceRef);
    this.peerSeq.delete(deviceRef);
  }

  private dropSessions(): void {
    for (const id of [...this.sessions.keys()]) this.forget(id);
  }

  private controlEnvelope(route: CompanionRelayRoute) {
    return {
      routeToken: route.routeToken, deviceRef: route.deviceRef, seq: this.controlSeq++,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
    };
  }

  private peerEnvelope(route: CompanionRelayRoute, idempotencyKey?: string) {
    const seq = this.peerSeq.get(route.deviceRef) ?? 0;
    this.peerSeq.set(route.deviceRef, seq + 1);
    return {
      routeToken: route.routeToken, deviceRef: route.deviceRef, seq,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  private sendRegister(route: CompanionRelayRoute): void {
    this.push({ v: 1, kind: 'register', role: 'host', envelope: this.controlEnvelope(route), ciphertext: '' });
  }

  private push(frame: CompanionRelayFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(frame)); return; }
    this.buffer.enqueue(frame);
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve, reject) => {
      const url = new URL(this.deps.config.url);
      url.searchParams.set('auth', this.deps.credential);
      const socket = new this.WebSocketImpl(url.toString());
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('COMPANION_RELAY_CONNECT_TIMEOUT')); }, L.relayConnectTimeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.live = true;
        this.attempt = 0;
        this.controlSeq = 0;
        this.peerSeq.clear();
        this.dropSessions();
        for (const route of this.routes.values()) this.sendRegister(route);
        if (this.socket?.readyState === WebSocket.OPEN) {
          for (const frame of this.buffer.drain()) this.socket.send(JSON.stringify(frame));
        }
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => this.beat(), L.relayHeartbeatMs);
          this.heartbeat.unref();
        }
        for (const waiter of this.openWaiters.splice(0)) waiter();
        resolve();
      });
      socket.on('message', data => {
        try { this.onMessage(String(data)); } catch { /* per-frame forget handles poison */ }
      });
      socket.once('close', () => {
        clearTimeout(timer);
        if (this.socket === socket) { this.socket = null; this.live = false; }
        this.dropSessions();
        this.scheduleReconnect();
      });
      socket.once('error', () => { /* close follows */ });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.allowReconnect || this.reconnectTimer) return;
    const steps = this.deps.config.reconnectBackoffMs;
    const delay = (steps[Math.min(this.attempt, steps.length - 1)] ?? L.relayReconnectBackoffMs[0]) * (0.5 + this.jitter());
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  private beat(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const route of this.routes.values()) {
      this.push({ v: 1, kind: 'heartbeat', envelope: this.controlEnvelope(route), ciphertext: '' });
    }
  }

  private onMessage(raw: string): void {
    let frame: CompanionRelayFrame;
    try { frame = parseCompanionRelayFrame(JSON.parse(raw) as unknown); } catch { return; }
    if (companionRelayFrameExpired(frame, this.now())) return;
    const deviceRef = frame.envelope.deviceRef;
    try {
      if (frame.kind === 'revoke' || frame.kind === 'disconnect') { this.forget(deviceRef); return; }
      if (frame.kind === 'handshake') { this.handleHandshake(frame); return; }
      if (frame.kind !== 'forward') return;
      const inbound = this.inbound.get(deviceRef) ?? new RelaySeqBuffer();
      this.inbound.set(deviceRef, inbound);
      for (const ready of inbound.push(frame, this.now())) this.handleForward(ready);
    } catch {
      this.forget(deviceRef);
    }
  }

  private handleHandshake(frame: CompanionRelayFrame): void {
    if (frame.kind !== 'handshake') return;
    const route = this.routes.get(frame.envelope.deviceRef);
    if (route?.routeToken !== frame.envelope.routeToken) return;
    this.forget(frame.envelope.deviceRef);
    const inbound = new RelaySeqBuffer();
    this.inbound.set(frame.envelope.deviceRef, inbound);
    const noise = createHandshake(false, this.deps.identity);
    if (noise.recv(fromHex(frame.ciphertext)).length !== 0 || !noise.rs) throw new Error('COMPANION_INVALID_FRAME');
    const publicKey = toHex(noise.rs);
    const device = this.deps.gateway.identityDevice(publicKey);
    if (device?.deviceId !== frame.envelope.deviceRef) {
      this.push({ v: 1, kind: 'revoke', envelope: this.controlEnvelope(route), ciphertext: '' });
      return;
    }
    const reply = toHex(noise.send());
    const cipher = new NoiseChannel(noise);
    this.sessions.set(device.deviceId, { cipher, publicKey, inbound });
    this.push({
      v: 1, kind: 'handshake',
      envelope: { routeToken: route.routeToken, deviceRef: route.deviceRef, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now() },
      ciphertext: reply,
    });
    this.push({
      v: 1, kind: 'forward', envelope: this.peerEnvelope(route),
      ciphertext: JSON.stringify(cipher.seal(device)),
    });
  }

  private handleForward(frame: CompanionRelayFrame): void {
    if (frame.kind !== 'forward') return;
    const session = this.sessions.get(frame.envelope.deviceRef);
    const route = this.routes.get(frame.envelope.deviceRef);
    if (!session || !route) return;
    const device = this.deps.gateway.identityDevice(session.publicKey);
    if (!device) { this.revoke(frame.envelope.deviceRef); return; }
    const request = session.cipher.open(JSON.parse(frame.ciphertext) as unknown) as {
      requestId?: unknown; action?: unknown; command?: unknown; commandId?: unknown; epoch?: unknown; afterSeq?: unknown;
    };
    if (!request || typeof request.requestId !== 'string' || request.requestId.length > L.idLength) throw new Error('COMPANION_INVALID_REQUEST');
    let result: unknown;
    if (request.action === 'command') {
      const command = companionCommandSchema.parse(request.command);
      if (command.deviceId !== device.deviceId) throw new Error('COMPANION_IDENTITY_MISMATCH');
      result = submitRelayedCommand(this.deps.gateway, command);
    } else if (request.action === 'status' && typeof request.commandId === 'string' && request.commandId.length <= L.idLength) {
      result = this.deps.gateway.commandStatus(device.deviceId, request.commandId);
    } else if (request.action === 'sync') {
      if (!Number.isSafeInteger(request.epoch) || Number(request.epoch) < 1 || !Number.isSafeInteger(request.afterSeq) || Number(request.afterSeq) < 0) {
        throw new Error('COMPANION_INVALID_CURSOR');
      }
      result = this.deps.gateway.syncForDevice(device.deviceId, Number(request.epoch), Number(request.afterSeq));
    } else throw new Error('COMPANION_UNSUPPORTED_ACTION');
    this.push({
      v: 1, kind: 'forward',
      envelope: this.peerEnvelope(route, frame.envelope.idempotencyKey),
      ciphertext: JSON.stringify(session.cipher.seal({ requestId: request.requestId, result })),
    });
  }
}

export async function startCompanionRelayIfConfigured(opts: {
  dataDirectory: string;
  gateway: CompanionGateway;
  loadIdentity: () => Promise<KeyPair>;
  logger?: { warn: (message: string) => void };
  credential?: string;
  now?: () => number;
}): Promise<CompanionRelayClient | null> {
  const config = loadCompanionRelayConfig(opts.dataDirectory);
  if (!config) return null;
  const credential = opts.credential ?? await loadCompanionRelayCredential(config.credentialRef);
  if (!credential) {
    opts.logger?.warn('Companion relay credential missing; dial-out skipped');
    return null;
  }
  const client = new CompanionRelayClient({
    gateway: opts.gateway,
    identity: await opts.loadIdentity(),
    config,
    credential,
    now: opts.now,
  });
  await client.start();
  return client;
}
