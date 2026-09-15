import type { KeyPair } from 'noise-handshake';
import { createHandshake, NoiseChannel } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex } from '../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
  type CompanionRelayRoute,
} from '../../../../src/shared/contract/companionRelay';
import { RelaySeqBuffer } from '../../../../src/shared/companion/relaySeqBuffer';

/**
 * 手机侧 relay 客户端（N-MOBILE-RELAY-PHONE）：LAN 不可达时用配对时缓存的 relay 路由拨
 * WSS，以 device 角色注册，再走与 LAN resume 同一套 IK Noise 握手回到 Host。帧契约与
 * Host 侧 CompanionRelayClient / tests/integration/companion/relayPhoneStub.ts 同源。
 *
 * 能力面对齐 Host 的 relay 转发面：command / status / sync / read。其余动作（听写、推送）
 * Host 不在 relay 面上提供，这里当场拒绝——发出去只会换来拆会话。
 */

/** 一条 relay socket 的传输视图：测试里由 ws 供给，真机上是 WebView 的 WebSocket。 */
export interface RelayDialSocket {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
}

export type RelayDial = (url: string, headers: { authorization: string }) => RelayDialSocket;

/**
 * WebView 的 WebSocket 不能带 Authorization 头（平台限制，不是疏漏）。生产 relay 的前置层
 * 在部署侧注入共享凭据（N-MOBILE-RELAY-PHONE 证据档 §2），浏览器裸拨即可过闸；headers
 * 参数留给能设头的运行时（node/测试侧的 ws dial），签名保持一致。
 */
export const browserRelayDial: RelayDial = url => {
  const socket = new WebSocket(url);
  return {
    send: data => socket.send(data),
    close: () => socket.close(),
    onOpen: handler => { socket.onopen = () => handler(); },
    onMessage: handler => { socket.onmessage = event => handler(String(event.data)); },
    onClose: handler => { socket.onclose = () => handler(); },
    onError: handler => { socket.onerror = () => handler(); },
  };
};

/** Host 在 relay 面上真正处理的动作。 */
const RELAY_SUPPORTED_ACTIONS = new Set(['command', 'status', 'sync', 'read']);

interface ResumeExpectation {
  hostKey: string;
  deviceId: string;
  scopeEpoch: number;
  scope: readonly string[];
}

interface Waiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayCompanionClient {
  private socket: RelayDialSocket | null = null;
  private channel: NoiseChannel | null = null;
  private seq = 0;
  private readonly inbound = new RelaySeqBuffer();
  private queue: Promise<unknown> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private inboundFrames = 0;
  /** 最后一次断开的分类原因：resume/request 在 socket 已死时要能把它原样带给上层。 */
  private failure: Error | null = null;
  private handshakeWaiter: Waiter | null = null;
  private handshakeFrame: CompanionRelayFrame | null = null;
  private welcomeWaiter: Waiter | null = null;
  /** 先于等待者到达的 forward 帧（welcome 在内）：握手回包与 welcome 常在同一个 TCP 段里，
   * node/WebView 会在恢复 await 之前同步派发两帧——没人等的帧排队，不许丢（stub 同款）。 */
  private readonly incoming: CompanionRelayFrame[] = [];
  private readonly replyWaiters = new Map<string, Waiter>();
  private readonly now: () => number;
  private readonly dial: RelayDial;
  private readonly identity: KeyPair;
  private readonly route: CompanionRelayRoute;
  private readonly deviceRef: string;
  private readonly onRevoked?: () => void;

  constructor(deps: {
    identity: KeyPair;
    route: CompanionRelayRoute;
    deviceRef: string;
    dial: RelayDial;
    now?: () => number;
    /** Host 经 relay 推 revoke/disconnect 帧时触发（store 把设备翻成 rejected）。 */
    onRevoked?: () => void;
  }) {
    this.identity = deps.identity;
    this.route = deps.route;
    this.deviceRef = deps.deviceRef;
    this.dial = deps.dial;
    this.now = deps.now ?? Date.now;
    this.onRevoked = deps.onRevoked;
  }

  get connected(): boolean { return this.socket != null && this.channel != null; }

  /**
   * 拨 relay 并以 device 角色注册。resolve 只说明传输层收下了我们——relay 不回 register
   * ack；凭据被拒表现为「upgrade 完成后立刻被关、一个帧都没收到」，由 socket 关闭分类
   * （收帧为零且握手未完成 ⇒ COMPANION_RELAY_AUTH_REJECTED）落到 resume 的等待者上。
   */
  async connect(): Promise<void> {
    this.close();
    this.failure = null;
    await new Promise<void>((resolve, reject) => {
      const socket = this.dial(this.route.url, { authorization: `Bearer ${this.route.credential}` });
      this.socket = socket;
      let opened = false;
      const failConnect = (code: string) => {
        if (opened) return false;
        clearTimeout(timer);
        this.drop(new Error(code));
        reject(new Error(code));
        return true;
      };
      const timer = setTimeout(() => { failConnect('COMPANION_RELAY_CONNECT_TIMEOUT'); }, L.relayConnectTimeoutMs);
      socket.onError(() => { failConnect('COMPANION_RELAY_UNAVAILABLE'); });
      socket.onClose(() => {
        if (failConnect('COMPANION_RELAY_UNAVAILABLE')) return;
        // open 之后被关。upgrade 已完成说明 relay 可达；此刻一个帧都没收到且握手没谈完，
        // 只剩凭据闸这一种解释（fake/生产 relay 都在 accept 时 close）。
        this.drop(new Error(this.channel || this.inboundFrames > 0 ? 'COMPANION_NOT_CONNECTED' : 'COMPANION_RELAY_AUTH_REJECTED'));
      });
      socket.onOpen(() => {
        opened = true;
        clearTimeout(timer);
        this.push({
          v: 1, kind: 'register', role: 'device',
          envelope: this.controlEnvelope(), ciphertext: '',
        });
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => {
            // socket 正在死的时候 send 可能抛：close 事件会来结算，这里吞掉即可。
            try { this.push({ v: 1, kind: 'heartbeat', envelope: this.controlEnvelope(), ciphertext: '' }); }
            catch { /* close follows */ }
          }, L.relayHeartbeatMs);
        }
        resolve();
      });
      socket.onMessage(data => { try { this.onMessage(data); } catch { this.drop(new Error('COMPANION_INVALID_FRAME')); } });
    });
  }

  /**
   * IK 握手回到 Host：hostKey 用配对绑定里的（与 LAN resume 同一身份校验），welcome 里的
   * 绑定必须与缓存绑定逐字段一致——relay 只换路，不换身份。
   */
  async resume(expected: ResumeExpectation): Promise<void> {
    if (!this.socket) throw this.failure ?? new Error('COMPANION_NOT_CONNECTED');
    const noise = createHandshake(true, this.identity, undefined, undefined, expected.hostKey);
    const reply = this.waitHandshake();
    this.push({
      v: 1, kind: 'handshake',
      envelope: { routeToken: this.route.routeToken, deviceRef: this.deviceRef, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now() },
      ciphertext: toHex(noise.send()),
    });
    this.seq = 0;
    const hello = await reply;
    let hostKeyPinned: boolean;
    try { hostKeyPinned = noise.recv(fromHex(hello.ciphertext)).length === 0; }
    catch { hostKeyPinned = false; }
    if (!hostKeyPinned) {
      this.drop(new Error('COMPANION_HOST_KEY_MISMATCH'));
      throw new Error('COMPANION_HOST_KEY_MISMATCH');
    }
    this.channel = new NoiseChannel(noise);
    const welcome = await this.waitWelcome();
    const opened = this.channel.open(JSON.parse(welcome.ciphertext) as unknown) as Partial<{
      deviceId: string; scopeEpoch: number; scope: string[];
    }>;
    if (opened?.deviceId !== expected.deviceId || opened?.scopeEpoch !== expected.scopeEpoch
      || JSON.stringify(opened?.scope ?? []) !== JSON.stringify(expected.scope)) {
      this.drop(new Error('COMPANION_BINDING_CHANGED'));
      throw new Error('COMPANION_BINDING_CHANGED');
    }
  }

  request(payload: Record<string, unknown>): Promise<unknown> {
    if (typeof payload.action !== 'string' || !RELAY_SUPPORTED_ACTIONS.has(payload.action)) {
      return Promise.reject(new Error('COMPANION_UNSUPPORTED_ACTION'));
    }
    const task = this.queue.then(async () => {
      const channel = this.channel;
      if (!this.socket || !channel) throw this.failure ?? new Error('COMPANION_NOT_CONNECTED');
      const requestId = crypto.randomUUID();
      const command = payload.action === 'command' ? payload.command as { commandId?: unknown } : undefined;
      // 幂等键穿透 relay 层：commandId 是这条命令的唯一身份，relay 两端都不许新铸。
      const idempotencyKey = command && typeof command.commandId === 'string' ? command.commandId : undefined;
      this.push({
        v: 1, kind: 'forward',
        envelope: this.peerEnvelope(idempotencyKey),
        ciphertext: JSON.stringify(channel.seal({ ...payload, requestId })),
      });
      const body = await this.waitReply(requestId) as { requestId?: unknown; result?: unknown };
      if (body.requestId !== requestId) throw new Error('COMPANION_INVALID_ACK');
      return body.result;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  close(): void { this.drop(new Error(this.channel || this.inboundFrames > 0 ? 'COMPANION_NOT_CONNECTED' : 'COMPANION_RELAY_AUTH_REJECTED')); }

  private controlEnvelope() {
    return {
      routeToken: this.route.routeToken, deviceRef: this.deviceRef, seq: 0,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
    };
  }

  private peerEnvelope(idempotencyKey?: string) {
    const seq = this.seq;
    this.seq += 1;
    return {
      routeToken: this.route.routeToken, deviceRef: this.deviceRef, seq,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  private push(frame: CompanionRelayFrame): void {
    if (!this.socket) throw new Error('COMPANION_NOT_CONNECTED');
    this.socket.send(JSON.stringify(frame));
  }

  private waitHandshake(): Promise<CompanionRelayFrame> {
    const stashed = this.handshakeFrame;
    if (stashed) { this.handshakeFrame = null; return Promise.resolve(stashed); }
    return this.armWaiter(waiter => { this.handshakeWaiter = waiter; }) as Promise<CompanionRelayFrame>;
  }

  private waitWelcome(): Promise<CompanionRelayFrame> {
    const stashed = this.incoming.shift();
    if (stashed) return Promise.resolve(stashed);
    return this.armWaiter(waiter => { this.welcomeWaiter = waiter; }) as Promise<CompanionRelayFrame>;
  }

  private waitReply(requestId: string): Promise<unknown> {
    return this.armWaiter(waiter => { this.replyWaiters.set(requestId, waiter); });
  }

  /** 统一的等待器：到点 COMPANION_NO_RESPONSE，socket 死了由 drop 统一结算。 */
  private armWaiter(arm: (waiter: Waiter) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: value => { clearTimeout(waiter.timer); resolve(value); },
        reject: error => { clearTimeout(waiter.timer); reject(error); },
        timer: setTimeout(() => {
          disarm();
          reject(new Error('COMPANION_NO_RESPONSE'));
        }, L.requestTimeoutMs),
      };
      const disarm = () => {
        this.handshakeWaiter = this.handshakeWaiter === waiter ? null : this.handshakeWaiter;
        this.welcomeWaiter = this.welcomeWaiter === waiter ? null : this.welcomeWaiter;
        for (const [id, pending] of this.replyWaiters) if (pending === waiter) this.replyWaiters.delete(id);
      };
      arm(waiter);
    });
  }

  private receiveHandshake(frame: CompanionRelayFrame): void {
    const waiter = this.handshakeWaiter;
    // 用完即摘：已 resolve 的等待者留在字段里，会让后续帧投递给死等待者并被吞掉。
    if (waiter) { this.handshakeWaiter = null; waiter.resolve(frame); }
    else this.handshakeFrame = frame;
  }

  private onMessage(raw: string): void {
    const frame = parseCompanionRelayFrame(JSON.parse(raw) as unknown);
    if (companionRelayFrameExpired(frame, this.now())) return;
    if (frame.kind === 'revoke' || frame.kind === 'disconnect') {
      this.drop(new Error('COMPANION_DEVICE_REVOKED'));
      this.onRevoked?.();
      return;
    }
    if (frame.kind === 'handshake') { this.receiveHandshake(frame); return; }
    if (frame.kind !== 'forward') return;
    this.inboundFrames += 1;
    for (const ready of this.inbound.push(frame, this.now())) this.deliverForward(ready);
  }

  private deliverForward(frame: CompanionRelayFrame): void {
    const welcome = this.welcomeWaiter;
    // 摘掉再 resolve：welcome 之后的所有 forward 都要按 requestId 路由，不能落进死等待者。
    if (welcome) { this.welcomeWaiter = null; welcome.resolve(frame); return; }
    const channel = this.channel;
    if (!channel) {
      if (this.incoming.length < L.relaySeqHold) this.incoming.push(frame);
      return;
    }
    let body: { requestId?: unknown };
    try { body = channel.open(JSON.parse(frame.ciphertext) as unknown) as { requestId?: unknown }; }
    catch (error) { this.drop(error instanceof Error ? error : new Error('COMPANION_INVALID_FRAME')); return; }
    if (typeof body.requestId !== 'string') return;
    const waiter = this.replyWaiters.get(body.requestId);
    if (waiter) { this.replyWaiters.delete(body.requestId); waiter.resolve(body); }
  }

  /** 关连接并按因结算所有在飞等待者。close() / 异常 / 对端断开共用一条路。 */
  private drop(reason: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.failure ??= reason;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.channel?.close();
    this.channel = null;
    this.seq = 0;
    this.inbound.reset();
    this.inboundFrames = 0;
    this.handshakeFrame = null;
    this.incoming.length = 0;
    socket?.close();
    this.settleWaiters(reason);
  }

  private settleWaiters(reason: Error): void {
    const waiters = [this.handshakeWaiter, this.welcomeWaiter, ...this.replyWaiters.values()];
    this.handshakeWaiter = null;
    this.welcomeWaiter = null;
    this.replyWaiters.clear();
    for (const waiter of waiters) waiter?.reject(reason);
  }
}
