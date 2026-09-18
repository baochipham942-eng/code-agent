import WebSocket from 'ws';
import { rootCertificates } from 'node:tls';
import type { KeyPair } from 'noise-handshake';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { createHandshake, NoiseChannel } from '../../../shared/companion/noiseChannel';
import { fromHex, toHex } from '../../../shared/companion/lanProtocol';
import { companionCommandSchema, type CompanionCommand, type CompanionSubmitResult } from '../../../shared/contract/companion';
import {
  COMPANION_RELAY_SENTINEL_DEVICE_REF,
  COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN,
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
  type CompanionRelayResolved,
  type CompanionRelayRoute,
} from '../../../shared/contract/companionRelay';
import type { CompanionRelayStatus } from '../../../shared/contract/companionManagement';
import type { CompanionGateway } from './CompanionGateway';
import { RelayOutboundBuffer, RelaySeqBuffer } from './companionRelayBuffer';
import { deriveCompanionRelayRouteToken } from './companionRelayRouteToken';
import {
  clearCompanionRelayTicket,
  loadCompanionRelayTicket,
  storeCompanionRelayTicket,
} from './companionRelayTicketStore';
import {
  errorHead,
  loadCompanionRelayConfig,
  loadCompanionRelayCredential,
  logCompanionRelayInfo,
  type CompanionRelayKeytarLoader,
  type CompanionRelayLogger,
} from './companionRelayConfig';

/** Host 侧路由表条目（deviceRef → routeToken）；与下发给手机的 CompanionRelayRoute 契约区分名。 */
interface RelayRouteEntry {
  deviceRef: string;
  routeToken: string;
}

/**
 * 账号通道的本地票据存取（N-COMPANION-RELAY-DEVICE-TICKET）：load 只在票据未过期且属于当前账号时
 * 返回原文；store 收到 relay 下发的 ticket 帧时覆盖落盘；clear 在票据被 relay 拒时作废。共享凭据
 * 通道不配它——那条通道不发 JWT，也就永远收不到 ticket 帧。
 */
export interface CompanionRelayTicketStore {
  load(): string | null;
  store(ticket: string): void;
  clear(): void;
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

/** ws close 事件的 reason 是可空的 Buffer：空 Buffer（对端没给说明）→ null；协议上限 123 字节，无需截断。 */
function closeReasonText(reason: Buffer): string | null {
  return reason.length ? reason.toString('utf8') : null;
}

export class CompanionRelayClient {
  private socket: WebSocket | null = null;
  private readonly buffer = new RelayOutboundBuffer();
  private readonly routes = new Map<string, RelayRouteEntry>();
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly inbound = new Map<string, RelaySeqBuffer>();
  private readonly peerSeq = new Map<string, number>();
  private controlSeq = 0;
  private stopped = true;
  private allowReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  /** open 之后撑过 relayStableConnectionMs 才算真连上：relay 在 upgrade 完成后才验凭据、不通过就立刻关。 */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private live = false;
  private lastDialErrorCode: string | null = null;
  private openWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly logger?: CompanionRelayLogger;

  constructor(private readonly deps: {
    gateway: CompanionGateway;
    identity: KeyPair;
    config: CompanionRelayResolved;
    /** 共享凭据原文；或每次拨号现取的账号令牌（N-COMPANION-RELAY-ACCOUNT-BIND，令牌 1h 过期，不能缓存）。 */
    credential: string | (() => Promise<string | null>);
    /** routeToken 派生的命名空间：缺省 local（共享凭据通道），账号通道为 acct:<Supabase 用户 id>。 */
    namespace?: string;
    /** 账号通道的本地票据存取（第 3A 刀）：有未过期票据先票据拨号，supabase 不通也能连。 */
    ticket?: CompanionRelayTicketStore;
    now?: () => number;
    jitter?: () => number;
    WebSocket?: typeof WebSocket;
    logger?: CompanionRelayLogger;
  }) {
    this.now = deps.now ?? Date.now;
    this.jitter = deps.jitter ?? Math.random;
    this.WebSocketImpl = deps.WebSocket ?? WebSocket;
    this.logger = deps.logger;
  }

  advertise(route: RelayRouteEntry): void {
    this.routes.set(route.deviceRef, route);
    if (this.socket?.readyState === WebSocket.OPEN) this.sendRegister(route);
  }

  routeTokenFor(deviceRef: string): string | null {
    return this.routes.get(deviceRef)?.routeToken ?? null;
  }

  /**
   * 给一台已配对手机的完整 relay 路由（url + routeToken + 共享凭据），经 Noise 信封下发给它缓存。
   * 没有 route 就当场派生并注册——手机不该为等下一次 heartbeat（20s）而拿不到路由。
   * socket 暂时断开时照常返回：token 不变（确定性派生，连 Host 重启都不变），重连后重新注册全部 route。
   */
  routeFor(deviceRef: string): CompanionRelayRoute | null {
    // 账号通道的路由暂不下发给手机（第三刀用新动作 relay.routes 下发，旧契约 credential 必填）。
    if (this.stopped || typeof this.deps.credential !== 'string') return null;
    if (!this.routes.has(deviceRef)) {
      this.bindPairedDevices();
      const minted = this.routes.get(deviceRef);
      if (minted && this.socket?.readyState === WebSocket.OPEN) this.sendRegister(minted);
    }
    const route = this.routes.get(deviceRef);
    if (!route) return null;
    return { v: 1, url: this.deps.config.url, routeToken: route.routeToken, credential: this.deps.credential };
  }

  private bindPairedDevices(): void {
    for (const device of this.deps.gateway.pairedDevices()) {
      if (this.routes.has(device.deviceId)) continue;
      // 确定性派生（不再 randomBytes）：Host 重启后同一设备拿到同一 token，手机缓存的
      // 路由不必等回到同一 Wi-Fi 刷新。撤销/换 epoch ⇒ 派生结果变，旧 token 不再注册。
      this.advertise({
        deviceRef: device.deviceId,
        routeToken: deriveCompanionRelayRouteToken(this.deps.identity.secretKey, device.deviceId, device.scopeEpoch, this.deps.namespace),
      });
    }
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
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
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
  /** 只读连接态：live 且已撑过稳定期（stableTimer 清空）才算 true。relay 拒证是 open 后立刻关，
   *  那个窗口里若报 true，设置页会闪一下「已开通」；whenConnected 仍在 open 即返回（收发不等稳定期）。 */
  get connected(): boolean { return this.live && this.stableTimer === null; }
  /** 最近一次拨号失败的码（连上后清空）；只进日志语义，不直接展示给用户。 */
  get lastDialError(): string | null { return this.lastDialErrorCode; }

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

  private controlEnvelope(route: RelayRouteEntry) {
    return {
      routeToken: route.routeToken, deviceRef: route.deviceRef, seq: this.controlSeq++,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
    };
  }

  private peerEnvelope(route: RelayRouteEntry, idempotencyKey?: string) {
    const seq = this.peerSeq.get(route.deviceRef) ?? 0;
    this.peerSeq.set(route.deviceRef, seq + 1);
    return {
      routeToken: route.routeToken, deviceRef: route.deviceRef, seq,
      ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  private sendRegister(route: RelayRouteEntry): void {
    this.push({ v: 1, kind: 'register', role: 'host', envelope: this.controlEnvelope(route), ciphertext: '' });
  }

  private push(frame: CompanionRelayFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(frame)); return; }
    this.buffer.enqueue(frame);
  }

  private peekReconnectDelay(): number {
    const steps = this.deps.config.reconnectBackoffMs;
    return (steps[Math.min(this.attempt, steps.length - 1)] ?? L.relayReconnectBackoffMs[0]) * (0.5 + this.jitter());
  }

  private logDialFailure(code: string, delayMs: number): void {
    if (this.lastDialErrorCode === code) return;
    this.lastDialErrorCode = code;
    this.logger?.warn(`Companion relay${this.label} dial failed: ${code}; reconnect in ${Math.round(delayMs)}ms`);
  }

  private failDial(code: string): void {
    const delay = this.peekReconnectDelay();
    this.logDialFailure(code, delay);
    this.scheduleReconnect(delay);
  }

  private dialErrorCode(lastError: unknown, closeCode: number, httpStatus?: number): string {
    if (httpStatus) return `HTTP ${httpStatus}`;
    if (lastError && typeof lastError === 'object') {
      const code = 'code' in lastError && typeof lastError.code === 'string' && lastError.code
        ? lastError.code
        : lastError instanceof Error ? errorHead(lastError) : '';
      if (code) return code;
    }
    // 1005（对端发了不带状态码的关闭帧）与 1006（没有关闭帧、TCP 层断）各自成码，不再折叠进兜底码：
    // 排障要分清是中继主动关还是链路断（N-COMPANION-RELAY-CLOSE-DIAG）。
    if (closeCode) return `close ${closeCode}`;
    return 'COMPANION_RELAY_CONNECT_FAILED';
  }

  private get label(): string {
    return typeof this.deps.credential === 'string' ? '' : ' (account)';
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    const provided = this.deps.credential;
    // 账号通道先试本地票据（relay 自签的 30 天凭据，不依赖 supabase 可达）；没有或已过期才现取
    // access token。取令牌会走 supabase-js 刷新，网络挂住时不能把拨号（以及关停时等它的 stop）一起挂死。
    let credential: string | null;
    let viaTicket = false;
    if (typeof provided === 'string') {
      credential = provided;
    } else {
      const ticket = this.deps.ticket?.load() ?? null;
      if (ticket) {
        credential = ticket;
        viaTicket = true;
      } else {
        credential = await Promise.race([
          provided().catch(() => null),
          new Promise<null>(resolve => { setTimeout(() => resolve(null), L.relayConnectTimeoutMs).unref(); }),
        ]);
      }
    }
    if (this.stopped) return;
    if (!credential) {
      this.failDial('COMPANION_RELAY_ACCOUNT_TOKEN_UNAVAILABLE');
      throw new Error('COMPANION_RELAY_ACCOUNT_TOKEN_UNAVAILABLE');
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let lastError: unknown;
      let httpStatus: number | undefined;
      // 本次 socket 的 open 时刻：disconnected 行里的存活时长用它实测，不用重连计数推。
      let openedAt: number | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      const options: WebSocket.ClientOptions = {
        headers: { authorization: `Bearer ${credential}` },
      };
      // 追加信任，不替换系统根：没配 caFile 时与现在完全一致。
      if (this.deps.config.caPem) options.ca = [...rootCertificates, this.deps.config.caPem];
      const socket = new this.WebSocketImpl(this.deps.config.url, options);
      const timer = setTimeout(() => {
        lastError = new Error('COMPANION_RELAY_CONNECT_TIMEOUT');
        socket.terminate();
        this.failDial('COMPANION_RELAY_CONNECT_TIMEOUT');
        finish(new Error('COMPANION_RELAY_CONNECT_TIMEOUT'));
      }, L.relayConnectTimeoutMs);
      socket.once('unexpected-response', (request, response) => {
        httpStatus = response.statusCode;
        request.destroy();
        clearTimeout(timer);
        const errorCode = this.dialErrorCode(lastError, 0, httpStatus);
        this.failDial(errorCode);
        finish(new Error(errorCode));
      });
      socket.once('error', error => { lastError = error; });
      socket.once('open', () => {
        clearTimeout(timer);
        openedAt = this.now();
        this.socket = socket;
        this.live = true;
        // attempt / 失败去重不在 open 时清：被 relay 拒的连接也会先 open 再立刻关（ai-review PR#1926）。
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          if (this.socket !== socket) return;
          this.attempt = 0;
          if (this.lastDialErrorCode !== null) logCompanionRelayInfo(this.logger, `Companion relay connected${this.label}: ${this.deps.config.url}`);
          this.lastDialErrorCode = null;
        }, L.relayStableConnectionMs);
        this.stableTimer.unref();
        this.controlSeq = 0;
        this.peerSeq.clear();
        this.dropSessions();
        this.bindPairedDevices();
        for (const route of this.routes.values()) this.sendRegister(route);
        if (this.socket?.readyState === WebSocket.OPEN) {
          for (const frame of this.buffer.drain()) this.socket.send(JSON.stringify(frame));
        }
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => this.beat(), L.relayHeartbeatMs);
          this.heartbeat.unref();
        }
        for (const waiter of this.openWaiters.splice(0)) waiter();
        if (this.lastDialErrorCode === null) logCompanionRelayInfo(this.logger, `Companion relay connected${this.label}: ${this.deps.config.url}`);
        finish();
      });
      socket.on('message', data => {
        try { this.onMessage(String(data)); } catch { /* per-frame forget handles poison */ }
      });
      socket.once('close', (code, reason) => {
        clearTimeout(timer);
        const wasLive = this.live && this.socket === socket;
        const stable = wasLive && this.stableTimer === null;
        if (this.socket === socket) {
          this.socket = null;
          this.live = false;
          if (this.stableTimer) clearTimeout(this.stableTimer);
          this.stableTimer = null;
        }
        this.dropSessions();
        const errorCode = this.dialErrorCode(lastError, code, httpStatus);
        if (!settled) {
          this.failDial(errorCode);
          finish(new Error(errorCode));
          return;
        }
        if (wasLive && !stable && code === 1005 && !lastError) {
          // open 后没撑过稳定期、收到不带关闭码的关闭帧（1005）：relay 验凭据不通过就是这个形状（账号令牌
          // 被拒、relay 没开账号鉴权）。按拨号失败走递增退避 + 同因去重，不按「掉线」秒级重连刷屏。
          // 网络断（1006）与带关闭码的主动断开（relay 重启 1001、测试里的 1000）仍按掉线记。
          // 拨号用的是票据时这还有一层含义：票据被 relay 作废了（换了票据密钥、或回拨了系统时钟）。
          // 作废本地票据，下次拨号回落 access token 重新换票，别抱着死票按退避重试到自然过期。
          if (viaTicket) this.deps.ticket?.clear();
          this.failDial('COMPANION_RELAY_CLOSED_AFTER_OPEN');
          return;
        }
        if (wasLive) {
          // 已连上的连接被断开不是「拨号失败」，单独一行，免得排障时误读成握手/鉴权问题。
          // 原始 close code / reason / 实测存活时长随行打出：errorCode 可能折叠不同物理事实（本单前
          // 1005 与 1006 同码），这三样才是分诊依据（1005=对端主动关、1006=链路断、reason=对端关闭说明）。
          const reasonText = closeReasonText(reason);
          const uptimeMs = openedAt === null ? -1 : this.now() - openedAt;
          const delay = this.peekReconnectDelay();
          this.logger?.warn(`Companion relay${this.label} disconnected: ${errorCode}; closeCode=${code} reason=${JSON.stringify(reasonText ?? '')} uptimeMs=${uptimeMs}; reconnect in ${Math.round(delay)}ms`);
          this.scheduleReconnect(delay);
        }
      });
    });
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped || !this.allowReconnect || this.reconnectTimer) return;
    const delay = delayMs ?? this.peekReconnectDelay();
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  private beat(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.bindPairedDevices();
    for (const route of this.routes.values()) {
      this.push({ v: 1, kind: 'heartbeat', envelope: this.controlEnvelope(route), ciphertext: '' });
    }
  }

  private onMessage(raw: string): void {
    let frame: CompanionRelayFrame;
    try { frame = parseCompanionRelayFrame(JSON.parse(raw) as unknown); } catch { return; }
    if (companionRelayFrameExpired(frame, this.now())) return;
    // relay 直接在本连接上签发的设备票据（第 3A 刀）：不走路由、与任何会话无关。必须在会话分支
    // 之前显式处理，否则掉进「未知 kind 直接 return」被吞掉，票据永远落不了盘。信封必须对上契约
    // sentinel（routeToken/deviceRef）：票据只可能来自 relay 的签发通道，形状不对的一律忽略，
    // 别让任意来源的 ciphertext 顶掉当前票据。
    if (frame.kind === 'ticket') {
      if (frame.envelope.routeToken !== COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN
        || frame.envelope.deviceRef !== COMPANION_RELAY_SENTINEL_DEVICE_REF) return;
      this.deps.ticket?.store(frame.ciphertext);
      return;
    }
    const deviceRef = frame.envelope.deviceRef;
    try {
      if (frame.kind === 'revoke' || frame.kind === 'disconnect') { this.forget(deviceRef); return; }
      if (frame.kind === 'handshake') { this.handleHandshake(frame); return; }
      if (frame.kind !== 'forward') return;
      const inbound = this.inbound.get(deviceRef) ?? new RelaySeqBuffer();
      this.inbound.set(deviceRef, inbound);
      // read 走 gateway 的异步读，回包在 await 之后——错误的会话拆掉仍走 forget。
      for (const ready of inbound.push(frame, this.now())) void this.handleForward(ready).catch(() => this.forget(deviceRef));
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

  private async handleForward(frame: CompanionRelayFrame): Promise<void> {
    if (frame.kind !== 'forward') return;
    const session = this.sessions.get(frame.envelope.deviceRef);
    const route = this.routes.get(frame.envelope.deviceRef);
    if (!session || !route) return;
    const device = this.deps.gateway.identityDevice(session.publicKey);
    if (!device) { this.revoke(frame.envelope.deviceRef); return; }
    const request = session.cipher.open(JSON.parse(frame.ciphertext) as unknown) as {
      requestId?: unknown; action?: unknown; command?: unknown; commandId?: unknown; epoch?: unknown; afterSeq?: unknown; query?: unknown;
    };
    if (!request || typeof request.requestId !== 'string' || request.requestId.length > L.idLength) throw new Error('COMPANION_INVALID_REQUEST');
    let result: unknown;
    if (request.action === 'command') {
      const command = companionCommandSchema.parse(request.command);
      if (command.deviceId !== device.deviceId) throw new Error('COMPANION_IDENTITY_MISMATCH');
      result = submitRelayedCommand(this.deps.gateway, command);
    } else if (request.action === 'read') {
      // 与 LAN exchange 同一个读口：手机经 relay 也能读库/历史/成果列表（N-MOBILE-RELAY-PHONE）。
      result = await this.deps.gateway.read(frame.envelope.deviceRef, request.query);
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
  logger?: CompanionRelayLogger;
  credential?: string;
  now?: () => number;
  jitter?: () => number;
  loadKeytar?: CompanionRelayKeytarLoader;
}): Promise<CompanionRelayClient | null> {
  const config = loadCompanionRelayConfig(opts.dataDirectory, opts.logger);
  if (!config) return null;
  const credential = opts.credential ?? await loadCompanionRelayCredential(config.credentialRef, {
    logger: opts.logger,
    loadKeytar: opts.loadKeytar,
  });
  if (!credential) return null;
  let identity: KeyPair;
  try {
    identity = await opts.loadIdentity();
  } catch (error) {
    opts.logger?.warn(`Companion relay identity load failed: ${errorHead(error)}`);
    return null;
  }
  const client = new CompanionRelayClient({
    gateway: opts.gateway,
    identity,
    config,
    credential,
    now: opts.now,
    jitter: opts.jitter,
    logger: opts.logger,
  });
  await client.start();
  return client;
}

/** 账号通道只需要这三样；authService 单例满足它，测试可直接喂假对象。 */
export interface CompanionRelayAccountSource {
  getCurrentUser(): { id: string } | null;
  getAccessToken(): Promise<string | null>;
  addAuthChangeCallback(callback: (user: { id: string } | null) => void): () => void;
}

/** 账号通道对设置页自报的状态（CompanionRelayStatus 的 account 部分，由装配层拼上 legacy）。 */
export type CompanionRelayAccountStatus = Pick<CompanionRelayStatus, 'account' | 'accountError'>;

/**
 * 账号通道（N-COMPANION-RELAY-ACCOUNT-BIND 第一刀）：电脑登录了 Neo 账号就再开一条 relay 连接，用
 * Supabase access token 鉴权、按 acct:<用户 id> 派生路由并登记。与共享凭据通道完全并行，那条一字不改；
 * 本刀不下发给手机，只让 relay 侧的离线验签与账号路由在生产里有真实消费方。
 * 登录 / 退出 / 换账号时按用户 id 起停；同一用户的令牌刷新不重连（每次拨号现取令牌）——
 * 例外：上次身份加载失败会回退已记的用户 id，同一用户的下一次登录态变化会重试。
 */
export function startCompanionRelayAccountIfConfigured(opts: {
  dataDirectory: string;
  gateway: CompanionGateway;
  loadIdentity: () => Promise<KeyPair>;
  auth: CompanionRelayAccountSource;
  logger?: CompanionRelayLogger;
  now?: () => number;
  jitter?: () => number;
  WebSocket?: typeof WebSocket;
}): { stop(): Promise<void>; revoke(deviceId: string): void; status(): CompanionRelayAccountStatus } {
  // 共享凭据通道已按同一份配置记过缺失/非法的日志，这里不重复记。
  const config = loadCompanionRelayConfig(opts.dataDirectory);
  // 没配中继：账号通道根本不起，但句柄仍自报 off，调用方不必特判 null。
  if (!config) {
    return {
      status: () => ({ account: 'off' }),
      revoke: () => {},
      stop: async () => {},
    };
  }
  let client: CompanionRelayClient | null = null;
  let userId: string | null = null;
  let stopped = false;
  let chain = Promise.resolve();
  const follow = (user: { id: string } | null) => {
    const next = user?.id ?? null;
    if (stopped || next === userId) return;
    userId = next;
    chain = chain.then(async () => {
      await client?.stop();
      client = null;
      if (stopped || !next || userId !== next) return;
      let identity: KeyPair;
      try {
        identity = await opts.loadIdentity();
      } catch (error) {
        opts.logger?.warn(`Companion relay (account) identity load failed: ${errorHead(error)}; retrying on next auth change`);
        // 身份加载失败后 follow 链里没有自动重试，把 userId 回退掉，让同一用户的下一次登录态
        // 变化（token 刷新/后台 session 验证/重新登录都会发）能重新走这条链——否则设置页的
        // connecting 文案宣称「稍后自动重试」就成了假话。被更新的登录态顶掉时不能回退。
        if (userId === next) userId = null;
        return;
      }
      if (stopped || userId !== next) return;
      // 票据存取绑定当前账号 id：换了账号登录，旧账号的票据读不出来（sub 对不上），回落令牌拨号。
      const ticket: CompanionRelayTicketStore = {
        load: () => loadCompanionRelayTicket(opts.dataDirectory, next, opts.now),
        store: issued => {
          if (storeCompanionRelayTicket(opts.dataDirectory, issued, next)) {
            logCompanionRelayInfo(opts.logger, 'Companion relay (account) ticket stored');
          }
        },
        clear: () => clearCompanionRelayTicket(opts.dataDirectory),
      };
      client = new CompanionRelayClient({
        gateway: opts.gateway,
        identity,
        config,
        credential: () => opts.auth.getAccessToken(),
        namespace: `acct:${next}`,
        ticket,
        now: opts.now,
        jitter: opts.jitter,
        WebSocket: opts.WebSocket,
        logger: opts.logger,
      });
      await client.start();
    });
  };
  const unsubscribe = opts.auth.addAuthChangeCallback(follow);
  follow(opts.auth.getCurrentUser());
  return {
    revoke: deviceId => client?.revoke(deviceId),
    // 判定顺序即优先级：没登录必然没起 client（follow 会停它），先查 user 不会把登出误报成 connecting。
    status: (): CompanionRelayAccountStatus => {
      if (!opts.auth.getCurrentUser()) return { account: 'signedOut' };
      if (client?.connected) return { account: 'connected' };
      // 已登录、账号通道未连上：含 follow 链未落地（client 还没建）与拨号退避中两种情况，都算开通中。
      const accountError = client?.lastDialError;
      return accountError ? { account: 'connecting', accountError } : { account: 'connecting' };
    },
    stop: async () => {
      stopped = true;
      unsubscribe();
      await chain;
      await client?.stop();
      client = null;
    },
  };
}
