import WebSocket from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { rootCertificates } from 'node:tls';
import type { KeyPair } from 'noise-handshake';
import type Noise from 'noise-handshake';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { createHandshake, NoiseChannel } from '../../../shared/companion/noiseChannel';
import { createRelayPairHandshake, deriveRelayPairVerify } from '../../../shared/companion/relayPair';
import { fromHex, toHex } from '../../../shared/companion/lanProtocol';
import { companionCommandSchema, type CompanionCommand, type CompanionSubmitResult } from '../../../shared/contract/companion';
import {
  COMPANION_RELAY_CLOSE_CODE_ROUTE_TAKEN,
  COMPANION_RELAY_PAIR_ROUTE_TOKEN,
  COMPANION_RELAY_SENTINEL_DEVICE_REF,
  COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN,
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  type CompanionRelayFrame,
  type CompanionRelayResolved,
  type CompanionRelayRoute,
  type CompanionRelayRouteRef,
} from '../../../shared/contract/companionRelay';
import type { CompanionRelayStatus } from '../../../shared/contract/companionManagement';
import { getRegisteredCompanionDictation } from '../capabilities/hostCapabilityPorts';
import { companionDictationReadiness, companionTranscriptionReadiness } from './transcriptionReadiness';
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

/**
 * relay 找回配对在 Host 侧的挂起态（N-COMPANION-RELAY-ACCOUNT-RECOVER）：收到 pair-request（XX
 * 第一条消息）后起 responder 挂着等电脑前的人表态，**同意之前绝不登记设备**——纯 XX 的第三条
 * 消息落地（手机静态公钥此刻才交给 Host）才 pairIdentity + 下发配对载荷，登记与握手收尾同拍落定。
 */
interface PendingRelayPair {
  requestId: string;
  noise: Noise;
  /** 已点同意（XX 第二条消息已发出）：此后到达的续帧才允许走登记路径。 */
  approved: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** 桌面上「新手机请求连接」卡片的事件面（app 层转 broadcastToRenderer）。 */
export interface CompanionRelayPairRequest {
  requestId: string;
  /** 4 位核对码：两端各自从同一份 XX 握手材料派生，人眼比对。 */
  code: string;
  expiresAt: number;
  /** 此刻电脑上零个项目（pairScope 空）：同意只会登记零授权设备，卡片要给「先建项目」的出路
   * （R2 Important②），同意按钮置灰；同意路径的守卫同判，UI 挡不住的兜底。 */
  scopeEmpty: boolean;
}

/** commandId must survive the relay hop; do not mint a new id here. */
function submitRelayedCommand(gateway: CompanionGateway, command: CompanionCommand): Promise<CompanionSubmitResult> {
  return gateway.submit(command);
}

/** ws close 事件的 reason 是可空的 Buffer：空 Buffer（对端没给说明）→ null；协议上限 123 字节，无需截断。 */
function closeReasonText(reason: Buffer): string | null {
  return reason.length ? reason.toString('utf8') : null;
}

export class CompanionRelayClient {
  private socket: WebSocket | null = null;
  /**
   * 本客户端实例的启动 nonce（N-COMPANION-RELAY-ROUTE-TAKEOVER）：routeToken 是持久身份确定性
   * 派生的，共用数据目录的另一个进程算出同一批 token——relay 靠这个内存态 nonce 分辨「同实例
   * 重连」（nonce 相同，放行）与「不同实例顶替」（nonce 不同，拒绝）。**绝不落盘**：落盘后共用
   * 数据目录的两个进程又拿到同一 nonce，洞白补。同一实例生命周期内不变，重连重注册与顶替才分得开。
   */
  private readonly instanceId = randomBytes(16).toString('base64url');
  /** register 自报的电脑名：截到契约上限，截完为空（纯符号主机名）就不带这一格。 */
  private readonly hostName: string | undefined;
  /** register 自报的主机公钥指纹：sha256(32 字节身份公钥) 的 hex，手机选电脑时核对的就是它。 */
  private readonly hostKeyFingerprint: string;
  private readonly pendingPairs = new Map<string, PendingRelayPair>();
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
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** 上一次 ping 后还没等到 pong 的 socket：下一周期它还是本尊 → 链路已死，terminate 重连。 */
  private pongPending: WebSocket | null = null;
  private attempt = 0;
  /** open 之后撑过 relayStableConnectionMs 才算真连上：relay 在 upgrade 完成后才验凭据、不通过就立刻关。 */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private live = false;
  /** 本连接收到过 relay 下发的票据帧（每次 open 重置）：鉴权成功的铁证，1005 收尾时据此不清盘上新票。 */
  private ticketIssuedOnSocket = false;
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
    /** register 自报的电脑名（list-hosts 列表行显示用）；缺省取 os.hostname()。 */
    hostName?: string;
    /**
     * relay 找回配对（N-COMPANION-RELAY-ACCOUNT-RECOVER）：pair-request 到达时通知桌面出卡。
     * 挂起态消账（拒绝/超时/完成/连接断）时 onPairSettled 收尾（收卡片）。
     */
    onPairRequest?: (request: CompanionRelayPairRequest) => void;
    onPairSettled?: (requestId: string) => void;
    /** 找回配对完成时新设备的授权范围（与 LAN 邀请同一取值面：全部项目的 grant）。 */
    pairScope?: () => string[];
    /** 旧路由（含共享凭据）取值回调——账号通道自己没有共享凭据，legacy 路由要从共享通道取。 */
    pairLegacyRoute?: (deviceId: string) => CompanionRelayRoute | null;
    /** 配对载荷里的 LAN 地址三件套（与二维码邀请同源）；LAN 面没开时缺席。 */
    pairLanAdvertisement?: () => { endpoint: string; altEndpoint: string | null; candidates: string[] } | null;
    /** 电脑当前登录的 Neo 账号邮箱（welcome 等值内容；手机登录引导/账号核对用）。 */
    hostAccountEmail?: () => string | null;
    now?: () => number;
    jitter?: () => number;
    WebSocket?: typeof WebSocket;
    logger?: CompanionRelayLogger;
  }) {
    this.now = deps.now ?? Date.now;
    this.jitter = deps.jitter ?? Math.random;
    this.WebSocketImpl = deps.WebSocket ?? WebSocket;
    this.logger = deps.logger;
    this.hostName = (deps.hostName ?? hostname()).trim().slice(0, L.relayHostNameLength) || undefined;
    this.hostKeyFingerprint = createHash('sha256').update(Buffer.from(deps.identity.publicKey)).digest('hex');
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
    // 账号通道不下发旧契约路由（credential 必填，账号通道的凭据形态是票据，走 relay.routes）。
    if (typeof this.deps.credential !== 'string') return null;
    const ref = this.relayRoute(deviceRef);
    return ref ? { ...ref, credential: this.deps.credential } : null;
  }

  /**
   * 不带凭据的路由引用（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：url + routeToken，共享凭据与
   * 账号两种凭据形态的通道都可用——账号通道把它交给 `relay.routes` 下发，手机拿自己登录换的
   * 票据拨。派生/注册语义与 routeFor 完全一致，只是不把凭据拼进去。
   */
  relayRoute(deviceRef: string): CompanionRelayRouteRef | null {
    if (this.stopped) return null;
    if (!this.routes.has(deviceRef)) {
      this.bindPairedDevices();
      const minted = this.routes.get(deviceRef);
      if (minted && this.socket?.readyState === WebSocket.OPEN) this.sendRegister(minted);
    }
    const route = this.routes.get(deviceRef);
    return route ? { v: 1, url: this.deps.config.url, routeToken: route.routeToken } : null;
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
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pongPending = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    this.dropSessions();
    this.clearAllPendingPairs();
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

  /** 清掉全部 Noise 会话并返回条数；close/open 路径据此留痕（stop 关停不打扰日志）。 */
  private dropSessions(): number {
    const ids = [...this.sessions.keys()];
    for (const id of ids) this.forget(id);
    return ids.length;
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
    this.push({
      v: 1, kind: 'register', role: 'host', instanceId: this.instanceId,
      ...(this.hostName ? { hostName: this.hostName } : {}),
      // hostKeyFingerprint 只在账号通道发（R3 Nit2）：唯一消费方 list-hosts 拒 legacy 主体，
      // legacy register 带这格永不被读——白占每帧 64 字节还误导排障。
      ...(typeof this.deps.credential === 'string' ? {} : { hostKeyFingerprint: this.hostKeyFingerprint }),
      envelope: this.controlEnvelope(route), ciphertext: '',
    });
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
    // 顶替拒绝（N-COMPANION-RELAY-ROUTE-TAKEOVER）：register 之后被 relay 以 4000 段自定 code 关闭
    // ＝本实例的路由被另一个 Host 实例持有。单列具名码，不折叠进 `close <code>` 泛化码——
    // 排障要能一眼分清「被中继顶掉」与「对端/链路普通断开」。
    if (closeCode === COMPANION_RELAY_CLOSE_CODE_ROUTE_TAKEN) return 'COMPANION_RELAY_ROUTE_TAKEN';
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
        this.ticketIssuedOnSocket = false;
        const droppedOnReconnect = this.dropSessions();
        if (droppedOnReconnect > 0) {
          logCompanionRelayInfo(this.logger, `Companion relay${this.label} sessions dropped on reconnect: ${droppedOnReconnect}`);
        }
        this.bindPairedDevices();
        for (const route of this.routes.values()) this.sendRegister(route);
        if (this.socket?.readyState === WebSocket.OPEN) {
          for (const frame of this.buffer.drain()) this.socket.send(JSON.stringify(frame));
        }
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => this.beat(), L.relayHeartbeatMs);
          this.heartbeat.unref();
        }
        if (!this.pingTimer) {
          this.pingTimer = setInterval(() => this.probe(), L.relayPingMs);
          this.pingTimer.unref();
        }
        for (const waiter of this.openWaiters.splice(0)) waiter();
        if (this.lastDialErrorCode === null) logCompanionRelayInfo(this.logger, `Companion relay connected${this.label}: ${this.deps.config.url}`);
        finish();
      });
      socket.on('message', data => {
        try { this.onMessage(String(data)); } catch { /* per-frame forget handles poison */ }
      });
      // relay→Host 方向的探活回执：清掉待答标记。relay 来的 ping 由 ws 库自动回 pong（零代码），
      // 这里只看我们主动发出去的 ping 有没有答。
      socket.on('pong', () => { if (this.pongPending === socket) this.pongPending = null; });
      socket.once('close', (code, reason) => {
        clearTimeout(timer);
        const wasLive = this.live && this.socket === socket;
        const stable = wasLive && this.stableTimer === null;
        if (this.socket === socket) {
          this.socket = null;
          this.live = false;
          if (this.stableTimer) clearTimeout(this.stableTimer);
          this.stableTimer = null;
          if (this.pongPending === socket) this.pongPending = null;
        }
        const droppedOnDisconnect = this.dropSessions();
        if (droppedOnDisconnect > 0) {
          logCompanionRelayInfo(this.logger, `Companion relay${this.label} sessions dropped on disconnect: ${droppedOnDisconnect}`);
        }
        // relay 找回的挂起配对随连接死掉：XX responder 状态不可跨连接续命，relay 侧会给手机回
        // host-offline/timeout；这里只清自己的账并收掉桌面卡片。
        this.clearAllPendingPairs();
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
          // 例外：本连接收到过 relay 新发票据（鉴权成功的铁证）就不清——这个 1005 不是凭据被拒，
          // 清了会把刚续签落盘的新票一起埋掉，下次还得回落令牌重换一张。
          if (viaTicket && !this.ticketIssuedOnSocket) this.deps.ticket?.clear();
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
          if (code === COMPANION_RELAY_CLOSE_CODE_ROUTE_TAKEN) {
            // 本实例的 route 被另一实例持有（共用数据目录的副本进程顶替被 relay 拒）：具名报警行，
            // 不与普通掉线混同一条文案。照常退避重连——relay 每次都会拒并留痕，两侧都有迹可循。
            this.logger?.warn(`Companion relay${this.label} route taken over: ${errorCode}; another host instance holds this route; closeCode=${code} reason=${JSON.stringify(reasonText ?? '')} uptimeMs=${uptimeMs}; reconnect in ${Math.round(delay)}ms`);
          } else {
            this.logger?.warn(`Companion relay${this.label} disconnected: ${errorCode}; closeCode=${code} reason=${JSON.stringify(reasonText ?? '')} uptimeMs=${uptimeMs}; reconnect in ${Math.round(delay)}ms`);
          }
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

  /**
   * 连接级探活（N-COMPANION-RELAY-KEEPALIVE）：每 relayPingMs 发一个 WS 协议层 ping，pong 清待答
   * 标记；到下一周期标记还在 = relay→Host 方向已死（单向应用帧心跳证明不了这个方向），直接
   * terminate 走既有 close(1006) → scheduleReconnect，把「内核超时（≈160s）才发现」压到一个 ping
   * 周期。半开连接 terminate 而不是 close：close 要等对端关帧握手，死链路等不来。与 beat() 职责
   * 分开：beat 续的是 route TTL（绑 route 生命周期），这里管的是连接本身的活性（零 route 也照发）。
   */
  private probe(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      this.pongPending = null;
      return;
    }
    if (this.pongPending === socket) {
      socket.terminate();
      return;
    }
    this.pongPending = socket;
    socket.ping();
  }

  private onMessage(raw: string): void {
    let frame: CompanionRelayFrame;
    try { frame = parseCompanionRelayFrame(JSON.parse(raw) as unknown); } catch { return; }
    // relay 直接在本连接上签发的设备票据（第 3A 刀）：不走路由、与任何会话无关。必须在过期与会话
    // 分支之前显式处理：掉进「未知 kind」会被吞掉，票据永远落不了盘；吃路由 TTL 则会在 relay 与
    // Host 时钟偏差超 60s 时整族误判过期、能力静默失效（sentinel 不走路由，票据自身的 30 天 exp
    // 由 store/load 把关；accountAuth 也按同量级 CLOCK_SKEW_S=60 容忍偏差）。信封必须对上契约
    // sentinel（routeToken/deviceRef）：票据只可能来自 relay 的签发通道，形状不对的一律忽略，
    // 别让任意来源的 ciphertext 顶掉当前票据。
    if (frame.kind === 'ticket') {
      if (frame.envelope.routeToken !== COMPANION_RELAY_TICKET_ISSUE_ROUTE_TOKEN
        || frame.envelope.deviceRef !== COMPANION_RELAY_SENTINEL_DEVICE_REF) return;
      // relay 只在鉴权成功后才发票据：收过票即本连接凭据被认过的铁证，1005 收尾不再按「票据被拒」清票。
      this.ticketIssuedOnSocket = true;
      this.deps.ticket?.store(frame.ciphertext);
      return;
    }
    if (companionRelayFrameExpired(frame, this.now())) return;
    const deviceRef = frame.envelope.deviceRef;
    try {
      if (frame.kind === 'revoke' || frame.kind === 'disconnect') { this.forget(deviceRef); return; }
      if (frame.kind === 'handshake') { this.handleHandshake(frame); return; }
      if (frame.kind === 'pair-request') { this.handlePairRequest(frame); return; }
      if (frame.kind !== 'forward') return;
      const inbound = this.inbound.get(deviceRef) ?? new RelaySeqBuffer();
      this.inbound.set(deviceRef, inbound);
      // read 走 gateway 的异步读，回包在 await 之后——错误的会话拆掉仍走 forget。
      for (const ready of inbound.push(frame, this.now())) void this.handleForward(ready).catch(() => this.forget(deviceRef));
    } catch {
      this.forget(deviceRef);
    }
  }

  /** pair-result / pair-request 的固定信封（sentinel 路由，与真实 route 的转发不混淆）。 */
  private pairEnvelope() {
    return {
      routeToken: COMPANION_RELAY_PAIR_ROUTE_TOKEN, deviceRef: COMPANION_RELAY_SENTINEL_DEVICE_REF,
      seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: this.now(),
    };
  }

  private pushPairResult(requestId: string, fields: { accepted: true; stage: 'reply' | 'complete'; ciphertext: string } | { accepted: false; reason: 'declined' | 'timeout' }): void {
    this.push({
      v: 1, kind: 'pair-result', requestId,
      ...(fields.accepted ? { accepted: true as const, stage: fields.stage } : { accepted: false as const, reason: fields.reason }),
      envelope: this.pairEnvelope(),
      ciphertext: fields.accepted ? fields.ciphertext : '',
    });
  }

  /**
   * relay 找回配对请求（N-COMPANION-RELAY-ACCOUNT-RECOVER）。带 instanceId 的是初次请求：起纯 XX
   * responder、挂起等电脑表态——4 位核对码此刻就能从握手材料（手机临时公钥）派生并上卡；**同意
   * 之前不登记任何设备**。不带 instanceId 的续帧是 XX 第三条消息：只有已同意（approved）的挂起态
   * 才收——收完握手即 complete，此刻才 pairIdentity 登记（与 LAN 配对同一落点）、铸双路由、用会话
   * 密钥封 welcome 等值内容 + relay.routes 下发。
   */
  private handlePairRequest(frame: Extract<CompanionRelayFrame, { kind: 'pair-request' }>): void {
    if (frame.envelope.routeToken !== COMPANION_RELAY_PAIR_ROUTE_TOKEN) return;
    const requestId = frame.requestId;
    const pending = this.pendingPairs.get(requestId);
    if (!frame.instanceId) {
      if (!pending || !pending.approved) {
        this.logger?.warn(`Companion relay${this.label} pair continuation dropped: ${pending ? 'not approved' : 'no pending pair'} for request ${requestId.slice(0, 8)}`);
        return;
      }
      let publicKey: string;
      try {
        if (pending.noise.recv(fromHex(frame.ciphertext)).length !== 0 || !pending.noise.complete || !pending.noise.rs) {
          throw new Error('COMPANION_INVALID_FRAME');
        }
        publicKey = toHex(pending.noise.rs);
      } catch (error) {
        this.clearPendingPair(requestId);
        this.pushPairResult(requestId, { accepted: false, reason: 'declined' });
        this.logger?.warn(`Companion relay${this.label} pair completion failed: ${error instanceof Error ? error.message : 'invalid frame'}`);
        return;
      }
      // 同意守卫之后才到这：登记 + 路由 + 载荷一次落定（pairIdentity 是 SQLite 事务，原子）。
      const device = this.deps.gateway.pairIdentity(publicKey, this.deps.pairScope?.() ?? []);
      const account = this.relayRoute(device.deviceId);
      const legacy = this.deps.pairLegacyRoute?.(device.deviceId) ?? null;
      const lan = this.deps.pairLanAdvertisement?.() ?? null;
      const email = this.deps.hostAccountEmail?.() ?? null;
      const cipher = new NoiseChannel(pending.noise);
      const payload = {
        deviceId: device.deviceId, scopeEpoch: device.scopeEpoch, scope: device.scope,
        transcription: companionTranscriptionReadiness(),
        sessionlessTranscribe: true as const,
        ...(email ? { hostAccountEmail: email } : {}),
        ...(getRegisteredCompanionDictation() ? { dictation: true as const, dictationTranscription: companionDictationReadiness() } : {}),
        ...(lan ? { lan } : {}),
        routes: { v: 1 as const, ...(account ? { account } : {}), ...(legacy ? { legacy } : {}) },
      };
      this.clearPendingPair(requestId);
      this.pushPairResult(requestId, { accepted: true, stage: 'complete', ciphertext: JSON.stringify(cipher.seal(payload)) });
      logCompanionRelayInfo(this.logger, `Companion relay${this.label} pair completed: device=${device.deviceId} scope=${device.scope.length}`);
      return;
    }
    if (pending) {
      this.logger?.warn(`Companion relay${this.label} pair request dropped: duplicate request ${requestId.slice(0, 8)}`);
      return;
    }
    // 挂起条数上限（R3 Nit3）：节流不能全押 relay 的 5s 限流，Host 自己也兜一层——满了拒新并
    // 留痕（手机侧由 relay 的挂起超时收尾，不登记、不出卡片）。可区分计数（ai-review R4
    // Important）：满员时点名其中几条是「已同意在等续帧」——回收窗失灵（条目不被清）一眼可辨。
    if (this.pendingPairs.size >= L.relayMaxPendingPairs) {
      const approved = [...this.pendingPairs.values()].filter(entry => entry.approved).length;
      this.logger?.warn(`Companion relay${this.label} pair request dropped: pending pairs full (${this.pendingPairs.size}, approved awaiting continuation ${approved})`);
      return;
    }
    const noise = createRelayPairHandshake(false, this.deps.identity);
    try {
      if (noise.recv(fromHex(frame.ciphertext)).length !== 0 || !noise.re) throw new Error('COMPANION_INVALID_FRAME');
    } catch (error) {
      this.logger?.warn(`Companion relay${this.label} pair request dropped: ${error instanceof Error ? error.message : 'invalid frame'}`);
      return;
    }
    const expiresAt = this.now() + L.relayPairTtlMs;
    const timer = setTimeout(() => {
      if (this.pendingPairs.get(requestId)?.noise === noise) {
        this.clearPendingPair(requestId);
        this.pushPairResult(requestId, { accepted: false, reason: 'timeout' });
        logCompanionRelayInfo(this.logger, `Companion relay${this.label} pair request timed out: request=${requestId.slice(0, 8)}`);
      }
    }, L.relayPairTtlMs);
    timer.unref();
    this.pendingPairs.set(requestId, { requestId, noise, approved: false, timer });
    this.deps.onPairRequest?.({ requestId, code: deriveRelayPairVerify(noise.re), expiresAt,
      scopeEmpty: (this.deps.pairScope?.() ?? []).length < 1 });
    logCompanionRelayInfo(this.logger, `Companion relay${this.label} pair request awaiting approval: request=${requestId.slice(0, 8)}`);
  }

  /** 桌面卡片表态入口（app 层经 manage 动作转进来）：同意 ⇒ 回 XX 第二条消息；拒绝 ⇒ 具名拒绝并销账。 */
  respondPair(requestId: string, approve: boolean): boolean {
    const pending = this.pendingPairs.get(requestId);
    if (!pending) return false;
    // 重复同意幂等（ai-review R2 Nit4）：XX responder 的 send() 已在第一次同意时推进到传输态，
    // 再调一次只会把传输密文当握手第二条消息发给手机（手机 recv 直接炸）——什么都不补发。
    if (approve && pending.approved) return true;
    if (!approve) {
      this.clearPendingPair(requestId);
      this.pushPairResult(requestId, { accepted: false, reason: 'declined' });
      logCompanionRelayInfo(this.logger, `Companion relay${this.label} pair declined: request=${requestId.slice(0, 8)}`);
      return true;
    }
    // 零 scope 守卫（R2 Important②，与 LanCompanionServer.invite 的 scope.length<1 同一条纪律）：
    // 项目库为空时同意只会登记零授权设备——手机侧 readRecoverPayload 判非法，每重试一次多一台
    // 僵尸设备（还顶掉同公钥上一台登记）。不登记，具名拒绝，桌面卡片以 scopeEmpty 给「先建项目」出路。
    if ((this.deps.pairScope?.() ?? []).length < 1) {
      this.clearPendingPair(requestId);
      this.pushPairResult(requestId, { accepted: false, reason: 'declined' });
      logCompanionRelayInfo(this.logger, `Companion relay${this.label} pair declined: empty scope for request=${requestId.slice(0, 8)}`);
      return true;
    }
    pending.approved = true;
    // 临界同意（R3 Nit4）：同意即摘「待同意」定时器——deadline 前一刻点同意，定时器到点会把已
    // 同意的挂起清掉再补一刀 timeout，手机拿到 timeout 而非成功。手机侧的到点收尾由 relay 的
    // 挂起超时兜底；桌面卡片按自身 expiresAt 自隐，挂起态由续帧完成/断连/再拒绝销账。
    clearTimeout(pending.timer);
    // 同意后的回收窗（ai-review R4 Important）：续帧永不到达时（临界同意形状：relay 已到点替手机
    // 回 timeout，续帧被 relay 判 unmatched 丢掉）这条 approved 挂起曾经永不回收——攒满
    // relayMaxPendingPairs 后该 Host 所有新 pair-request 在上限检查处被静默丢，桌面不再弹卡、手机
    // 固定等满 120s，只有重启或断 relay 才恢复。到点只清条目并留痕，不补发 pair-result：relay 的
    // 挂起超时已给手机收尾，再发只会是一条对不上挂起态的迟到帧。
    pending.timer = setTimeout(() => {
      if (this.pendingPairs.get(requestId)?.noise !== pending.noise) return;
      this.clearPendingPair(requestId);
      logCompanionRelayInfo(this.logger, `Companion relay${this.label} pair approved continuation never arrived: request=${requestId.slice(0, 8)}`);
    }, L.relayPairApprovedTtlMs);
    pending.timer.unref();
    this.pushPairResult(requestId, { accepted: true, stage: 'reply', ciphertext: toHex(pending.noise.send()) });
    return true;
  }

  private clearPendingPair(requestId: string): void {
    const pending = this.pendingPairs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPairs.delete(requestId);
    this.deps.onPairSettled?.(requestId);
  }

  private clearAllPendingPairs(): void {
    for (const requestId of [...this.pendingPairs.keys()]) this.clearPendingPair(requestId);
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
    if (!session || !route) {
      // 手机还握着旧 Host 实例谈好的会话密钥、而本连接的会话表已清（close/open 都会清）时，
      // forward 到这里只能被吞——留一行 warn 让「静默丢消息」有迹可循（deviceRef 只给前缀，
      // 原文不进日志）。relay 侧的 host 腿断开宽限通知会让手机重拨重握手，这里负责剩下的留痕。
      this.logger?.warn(`Companion relay${this.label} forward dropped: ${session ? 'no route' : 'no session'} for deviceRef ${frame.envelope.deviceRef.slice(0, 8)}`);
      return;
    }
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
      result = await submitRelayedCommand(this.deps.gateway, command);
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
  /** register 自报的电脑名（缺省 os.hostname()）；list-hosts 列表行显示用。 */
  hostName?: string;
  /** relay 找回配对（N-COMPANION-RELAY-ACCOUNT-RECOVER）：桌面卡片的到达与消账广播。 */
  onPairRequest?: (request: CompanionRelayPairRequest) => void;
  onPairSettled?: (requestId: string) => void;
  /** 找回配对完成时新设备的授权范围（与 LAN 邀请同一取值面：全部项目的 grant）。 */
  pairScope?: () => string[];
  /** 旧路由（含共享凭据）取值回调：配对载荷的 relay.routes.legacy，从共享凭据通道取。 */
  pairLegacyRoute?: (deviceId: string) => CompanionRelayRoute | null;
  /** 配对载荷里的 LAN 地址三件套（与二维码邀请同源）；LAN 面没开时缺席。 */
  pairLanAdvertisement?: () => { endpoint: string; altEndpoint: string | null; candidates: string[] } | null;
  /** 电脑当前登录的 Neo 账号邮箱（配对载荷的 welcome 等值内容）。 */
  hostAccountEmail?: () => string | null;
}): {
  stop(): Promise<void>;
  revoke(deviceId: string): void;
  status(): CompanionRelayAccountStatus;
  /** 账号路由引用（不带凭据）：`relay.routes` 下发给手机，手机拿自己换的票据拨（第三刀）。 */
  relayRoute(deviceRef: string): CompanionRelayRouteRef | null;
  /** 桌面卡片对找回配对的表态（manage 动作 pair.respond 转进来）；挂起态没了回 false。 */
  respondPair(requestId: string, approve: boolean): boolean;
} {
  // 共享凭据通道已按同一份配置记过缺失/非法的日志，这里不重复记。
  const config = loadCompanionRelayConfig(opts.dataDirectory);
  // 没配中继：账号通道根本不起，但句柄仍自报 off，调用方不必特判 null。
  if (!config) {
    return {
      status: () => ({ account: 'off' }),
      revoke: () => {},
      relayRoute: () => null,
      respondPair: () => false,
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
    const previous = userId;
    userId = next;
    chain = chain.then(async () => {
      await client?.stop();
      client = null;
      // 登出/换账号（本通道上一个绑定的用户没了或换了）必须作废本地票据：那是一张 30 天、能直接
      // 以 acct:<原 sub> 连 relay 的 bearer 凭据，relay 侧没有按账号吊销的通道（全局作废只有删密钥
      // 文件一档＝连带作废所有账号），退出后只能由 Host 自己销毁。session 在 OS Keychain、登出即
      // 销毁，令牌那边本来就没口子。初始登录（previous 为 null，本通道没有可作废的旧绑定）不清：
      // 重启后要先读盘上票据接上（supabase 不通也能连），死票由 1005 拒收路径自己作废。
      // 进程关停（stop()）不走这条链，也不清。
      if (previous !== null) clearCompanionRelayTicket(opts.dataDirectory);
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
          try {
            if (storeCompanionRelayTicket(opts.dataDirectory, issued, next)) {
              logCompanionRelayInfo(opts.logger, 'Companion relay (account) ticket stored');
            } else {
              // 形状不对 / sub 不是当前账号：与落盘失败分开记，排障时能分清是哪一半没成。
              opts.logger?.warn('Companion relay (account) ticket not stored: malformed or wrong account');
            }
          } catch (error) {
            // 磁盘满/只读等落盘失败：不接住会被 socket.on('message') 的 catch {} 吞成零日志，
            // 行为静默退回「每次拨号都要 supabase」（错题本：降级路径必须留痕）。
            opts.logger?.warn(`Companion relay (account) ticket store failed: ${errorHead(error)}`);
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
        hostName: opts.hostName,
        onPairRequest: opts.onPairRequest,
        onPairSettled: opts.onPairSettled,
        pairScope: opts.pairScope,
        pairLegacyRoute: opts.pairLegacyRoute,
        pairLanAdvertisement: opts.pairLanAdvertisement,
        hostAccountEmail: opts.hostAccountEmail,
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
    // 没登录/follow 链还没落地时 client 为 null ⇒ 没有账号路由；token 确定性派生，socket 断着也照给。
    relayRoute: deviceRef => client?.relayRoute(deviceRef) ?? null,
    respondPair: (requestId, approve) => client?.respondPair(requestId, approve) ?? false,
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
