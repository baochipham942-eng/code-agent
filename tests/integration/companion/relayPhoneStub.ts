import WebSocket from 'ws';
import type { KeyPair } from 'noise-handshake';
import { randomUUID } from 'node:crypto';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { createHandshake, NoiseChannel } from '../../../src/shared/companion/noiseChannel';
import { fromHex, toHex } from '../../../src/shared/companion/lanProtocol';
import type { LanBinding } from '../../../src/shared/companion/lanProtocol';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
} from '../../../src/shared/contract/companionRelay';
import { RelaySeqBuffer } from '../../../src/host/services/companion/companionRelayBuffer';

export class RelayPhoneStub {
  private socket: WebSocket | null = null;
  private channel: NoiseChannel | null = null;
  private binding: LanBinding | null = null;
  private seq = 0;
  private inbound = new RelaySeqBuffer();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending: Array<(frame: CompanionRelayFrame) => void> = [];
  private readonly incoming: CompanionRelayFrame[] = [];
  private handshakeWaiter: ((frame: CompanionRelayFrame) => void) | null = null;
  private handshakeFrame: CompanionRelayFrame | null = null;
  private readonly now: () => number;

  constructor(
    private readonly identity: KeyPair,
    private readonly routeToken: string,
    private readonly deviceRef: string,
    now?: () => number,
  ) { this.now = now ?? Date.now; }

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  async connect(url: string, credential: string): Promise<void> {
    this.close();
    const target = new URL(url);
    target.searchParams.set('auth', credential);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(target.toString());
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('COMPANION_RELAY_CONNECT_TIMEOUT')); }, L.relayConnectTimeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.seq = 0;
        this.inbound = new RelaySeqBuffer();
        this.push({
          v: 1, kind: 'register', role: 'device',
          envelope: this.controlEnvelope(), ciphertext: '',
        });
        resolve();
      });
      socket.on('message', data => {
        try { this.onMessage(String(data)); } catch { this.close(); }
      });
      socket.once('close', () => { if (this.socket === socket) this.close(); });
      socket.once('error', () => { /* close follows */ });
    });
  }

  async resume(hostKey: string, endpoint: string): Promise<LanBinding> {
    if (!this.socket) throw new Error('COMPANION_NOT_CONNECTED');
    const noise = createHandshake(true, this.identity, undefined, undefined, hostKey);
    const reply = this.waitHandshake();
    this.push({
      v: 1, kind: 'handshake',
      envelope: { routeToken: this.routeToken, deviceRef: this.deviceRef, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now() },
      ciphertext: toHex(noise.send()),
    });
    this.seq = 0;
    const hello = await reply;
    if (noise.recv(fromHex(hello.ciphertext)).length !== 0) throw new Error('COMPANION_INVALID_FRAME');
    this.channel = new NoiseChannel(noise);
    const welcome = await this.waitForward();
    const opened = this.channel.open(JSON.parse(welcome.ciphertext) as unknown);
    this.binding = this.readBinding(opened, endpoint, hostKey);
    return this.binding;
  }

  burst(payloads: Record<string, unknown>[]): Promise<unknown[]> {
    if (!this.binding || !this.channel) throw new Error('COMPANION_NOT_CONNECTED');
    const channel = this.channel;
    const ids: string[] = [];
    const waiters = payloads.map(() => this.waitForward());
    for (const payload of payloads) {
      const requestId = randomUUID();
      ids.push(requestId);
      const command = payload.command as { commandId?: string } | undefined;
      this.push({
        v: 1, kind: 'forward',
        envelope: this.peerEnvelope(typeof command?.commandId === 'string' ? command.commandId : undefined),
        ciphertext: JSON.stringify(channel.seal({ ...payload, requestId })),
      });
    }
    return Promise.all(waiters).then(replies => replies.map((reply, index) => {
      if (this.channel !== channel) throw new Error('COMPANION_CHANNEL_CHANGED');
      const body = channel.open(JSON.parse(reply.ciphertext) as unknown) as { requestId: string; result: unknown };
      if (body.requestId !== ids[index]) throw new Error('COMPANION_INVALID_ACK');
      return body.result;
    }));
  }

  request(payload: Record<string, unknown>): Promise<unknown> {
    const expected = this.channel;
    const task = this.queue.then(async () => {
      if (!this.binding || !this.channel || this.channel !== expected) throw new Error('COMPANION_NOT_CONNECTED');
      const requestId = randomUUID();
      const command = payload.command as { commandId?: string } | undefined;
      this.push({
        v: 1, kind: 'forward',
        envelope: this.peerEnvelope(typeof command?.commandId === 'string' ? command.commandId : undefined),
        ciphertext: JSON.stringify(this.channel.seal({ ...payload, requestId })),
      });
      const reply = await this.waitForward();
      if (this.channel !== expected) throw new Error('COMPANION_CHANNEL_CHANGED');
      const body = this.channel.open(JSON.parse(reply.ciphertext) as unknown) as { requestId: string; result: unknown };
      if (body.requestId !== requestId) throw new Error('COMPANION_INVALID_ACK');
      return body.result;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
    this.binding = null;
    this.handshakeWaiter = null;
    this.handshakeFrame = null;
    this.pending.length = 0;
    this.incoming.length = 0;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  private controlEnvelope() {
    return {
      routeToken: this.routeToken, deviceRef: this.deviceRef, seq: 0,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
    };
  }

  private peerEnvelope(idempotencyKey?: string) {
    const seq = this.seq;
    this.seq += 1;
    return {
      routeToken: this.routeToken, deviceRef: this.deviceRef, seq,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  private push(frame: CompanionRelayFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('COMPANION_NOT_CONNECTED');
    this.socket.send(JSON.stringify(frame));
  }

  private waitHandshake(): Promise<CompanionRelayFrame> {
    if (this.handshakeFrame) {
      const frame = this.handshakeFrame;
      this.handshakeFrame = null;
      return Promise.resolve(frame);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('COMPANION_RELAY_HANDSHAKE_TIMEOUT')), L.requestTimeoutMs);
      this.handshakeWaiter = frame => { clearTimeout(timer); resolve(frame); };
    });
  }

  private waitForward(): Promise<CompanionRelayFrame> {
    const queued = this.incoming.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), L.requestTimeoutMs);
      this.pending.push(frame => { clearTimeout(timer); resolve(frame); });
    });
  }

  private onMessage(raw: string): void {
    const frame = parseCompanionRelayFrame(JSON.parse(raw) as unknown);
    if (companionRelayFrameExpired(frame, this.now())) return;
    if (frame.kind === 'revoke' || frame.kind === 'disconnect') { this.close(); return; }
    if (frame.kind === 'handshake') {
      if (this.handshakeWaiter) { this.handshakeWaiter(frame); this.handshakeWaiter = null; }
      else this.handshakeFrame = frame;
      return;
    }
    if (frame.kind !== 'forward') return;
    for (const ready of this.inbound.push(frame, this.now())) {
      const waiter = this.pending.shift();
      if (waiter) waiter(ready);
      else this.incoming.push(ready);
    }
  }

  private readBinding(value: unknown, endpoint: string, hostKey: string): LanBinding {
    const v = value as Partial<LanBinding>;
    if (!v || typeof v.deviceId !== 'string' || typeof v.scopeEpoch !== 'number' || !Number.isSafeInteger(v.scopeEpoch) ||
        !Array.isArray(v.scope) || v.scope.some(id => typeof id !== 'string')) {
      throw new Error('COMPANION_INVALID_BINDING');
    }
    return { version: 1, endpoint, hostKey, deviceId: v.deviceId, scopeEpoch: v.scopeEpoch, scope: v.scope };
  }
}
