import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import express from 'express';
import type Noise from 'noise-handshake';
import type { KeyPair } from 'noise-handshake';
import { COMPANION_EVENT_DROPPED, COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { deriveInvitationVerify, fromHex, toHex, isLanPeer, isPrivateIPv4, lanAdvertisedHost, type LanInvitation } from '../../../shared/companion/lanProtocol';
import { createHandshake, NoiseChannel } from '../../../shared/companion/noiseChannel';
import { companionCommandSchema, type CompanionEvent } from '../../../shared/contract/companion';
import { getRegisteredCompanionDictation } from '../capabilities/hostCapabilityPorts';
import type { CompanionGateway } from './CompanionGateway';
import { logCompanionRelayInfo, type CompanionRelayLogger } from './companionRelayConfig';
import { companionDictationReadiness, companionTranscriptionReadiness } from './transcriptionReadiness';
import type { CompanionPushOutbox } from './CompanionPushOutbox';

interface Invitation { id: string; psk: string; expiresAt: number; scope: string[] }
interface Pending { noise: Noise; invite: Invitation; expiresAt: number }
interface Channel { cipher: NoiseChannel; publicKey: string; expiresAt: number; lastSeenAt: number | null
  /** 墓碑的 identity_invalid warn 已落过一次：剩余 TTL 里每轮 prune 不再复读同一行。 */
  identityLogged?: boolean }
/** Wire bodies stay `unknown`-per-field: every handler below validates before use. */
interface HelloBody { mode?: unknown; inviteId?: unknown; frame?: unknown }
interface ChannelBody { channelId?: unknown; frame?: unknown }

/** Keeps the seq and envelope of the event it replaces; the payload only says what was lost. */
function dropped(event: CompanionEvent, bytes: number): CompanionEvent {
  return { ...event, kind: COMPANION_EVENT_DROPPED, payload: { reason: 'too_large', kind: event.kind, bytes } };
}

/** channelId/publicKey 都不是秘密，但整串进日志太长——照 relay 的 tokenPrefix 先例截前 8 位。 */
function idPrefix(id: string): string {
  return id.slice(0, 8);
}

/**
 * action 是有限枚举（sync/status/dictation/relay.route/relay.routes/push.*），整名进日志：
 * 截 8 位会把 relay.route 与 relay.routes 截成同一个 relay.ro，路由断链判据就分不开了
 * （ai-review R3 Nit 2）。枚举名最长 push.unregister=16，32 只是防御上限；非标识符形状的
 * 任意 wire 字段照 modeLabel 只记类型/长度/前缀，不记原文。
 */
function actionLabel(action: unknown): string {
  if (typeof action === 'string' && action.length <= 32 && /^[a-z][a-z0-9._]*$/.test(action)) return action;
  return modeLabel(action);
}

/**
 * 握手前的入站字段一律不记原文（ai-review Important）：/v1/hello 在鉴权与限流之前，
 * 同网段任意设备都能塞一个近 4MB 的 mode 字符串把宿主日志当磁盘写。照 idPrefix 的
 * 截断口径只记「类型/长度/转义前 8 字符」——够归因（pair/resume/垃圾输入）且体积有界。
 */
function modeLabel(mode: unknown): string {
  if (typeof mode !== 'string') return `invalid(${typeof mode})`;
  return `string[len=${mode.length} prefix=${JSON.stringify(mode.slice(0, 8))}]`;
}

/**
 * exchange 出错关 channel 那行的错误字段：只认 COMPANION_* 形状的错误码；别的异常
 * （zod parse 的 message 会内嵌收到的 payload，可能有用户消息正文）只记构造名，不记原文。
 */
function exchangeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^[A-Z][A-Z0-9_]*$/.test(message)) return message;
  return error instanceof Error ? (error.constructor.name || 'Error') : typeof error;
}

/**
 * 本机此刻可用的私网 IPv4，按接口枚举顺序。宿主换网后这个列表就变了——
 * 广告出去的地址必须**每次现取**，不能在 start() 那一刻冻住（N-COMPANION-NOLANPORT）。
 */
export function privateLanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .flatMap(n => n?.family === 'IPv4' && !n.internal && isPrivateIPv4(n.address) ? [n.address] : []);
}

/** Dedicated LAN surface: encrypted records only, never desktop HTTP/IPC routes. */
export class LanCompanionServer {
  private server: Server | null = null;
  private invitation: Invitation | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly channels = new Map<string, Channel>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  /** start() 那一刻选中的地址：只在现取列表为空（掉线）时当兜底用。 */
  private startAddress = '';
  private listenPort = 0;
  private handshakeWindow = 0;
  private handshakeCount = 0;
  /** 手机逐秒轮询的同一 ghost commandId 的 status 异常行只落一次（ai-review R3 Nit 1）。 */
  private readonly ghostCommandIds = new Set<string>();
  /** 未鉴权对端的 hello 拒单按「对端 IP × 错误码」去重：同一对端复读同一错误不再刷行（ai-review R3 Nit 3）。 */
  private readonly helloRejects = new Set<string>();

  constructor(private readonly gateway: CompanionGateway, private readonly identity: KeyPair,
    private readonly now = Date.now, private readonly push?: CompanionPushOutbox,
    /** 手机经 LAN 问「我的 relay 路由是什么」；没有 relay 客户端时回 unavailable。 */
    private readonly relayRoute?: (deviceId: string) => import('../../../shared/contract/companionRelay').CompanionRelayRoute | null,
    /** 账号 relay 路由（不带凭据，N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：Host 登录了 Neo 账号才有。 */
    private readonly relayAccountRoute?: (deviceId: string) => import('../../../shared/contract/companionRelay').CompanionRelayRouteRef | null,
    /** 电脑当前登录的 Neo 账号邮箱：随 welcome 进配对信息，手机用它预填登录页并核对账号一致。 */
    private readonly hostAccountEmail?: () => string | null,
    /**
     * 连接层留痕（N-MOBILE-SEND-RESULT-LOST）：握手成败、channel 三条死路（TTL/身份失效/
     * exchange 出错）、exchange 首拍与异常。sync/status 轮询只在首拍或异常时打，不每秒刷屏。
     */
    private readonly logger?: CompanionRelayLogger) {}

  async start(address: string, port: number = L.lanPort): Promise<void> {
    if (this.server) return;
    if (!isPrivateIPv4(address)) throw new Error('COMPANION_LAN_UNAVAILABLE');
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
      res.setHeader('Cache-Control', 'no-store');
      if (!isLanPeer(peer)) { res.sendStatus(403); return; }
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json' ||
          (req.headers.origin && !['capacitor://localhost', 'http://localhost', 'https://localhost'].includes(req.headers.origin))) {
        res.sendStatus(403); return;
      }
      next();
    });
    app.use(express.json({ limit: L.maxFrameBytes * L.maxRequestRecords * 2 + 512, strict: true }));
    // socket.localAddress 一路带到 welcome：只有它才是「对面此刻够得到的那张网卡」。
    app.post('/v1/hello', (req, res) => {
      try { res.json(this.hello(req.body as HelloBody, req.socket.localAddress, req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '')); } catch { res.status(403).json({ error: 'COMPANION_HANDSHAKE_REJECTED' }); }
    });
    app.post('/v1/finish', (req, res) => {
      try { res.json(this.finish(req.body as ChannelBody, req.socket.localAddress)); } catch { res.status(403).json({ error: 'COMPANION_HANDSHAKE_REJECTED' }); }
    });
    app.post('/v1/exchange', async (req, res) => {
      // 撤销要能跟「通道没了」分开说：channel 被撤当场关掉后，手机下一次 sync 只能拿到笼统的
      // CHANNEL_CLOSED，只能当传输失败闪一拍「正在自动重试」再经 hello 才知道被踢。设备已撤销
      // 单独回名，手机 sync 直接按 revoked 结算。其余错误形状（含 TTL 过期的 CHANNEL_CLOSED）不动。
      try { res.json(await this.exchange(req.body as ChannelBody)); }
      catch (error) {
        res.status(403).json({ error: error instanceof Error && error.message === 'COMPANION_DEVICE_REVOKED' ? 'COMPANION_DEVICE_REVOKED' : 'COMPANION_CHANNEL_CLOSED' });
      }
    });
    // Body/parser failures must never echo ciphertext, invitation material, or stack traces.
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({ error: 'COMPANION_INVALID_FRAME' });
    });
    const server = createServer(app);
    server.requestTimeout = L.requestTimeoutMs;
    server.headersTimeout = L.requestTimeoutMs;
    server.maxConnections = L.maxChannels * 2;
    // Bound to every interface on purpose: pinning the socket to one literal makes it deaf the
    // moment that address goes away (host switches network), and nothing re-binds it until the
    // next invitation. Reach is taken back at the TCP layer instead — an off-link caller is cut
    // before it can hold a socket against maxConnections or idle out requestTimeout, which is
    // strictly tighter than the per-request 403 that guarded the single-address bind.
    server.on('connection', socket => {
      if (!isLanPeer(socket.remoteAddress?.replace(/^::ffff:/, '') ?? '')) socket.destroy();
    });
    const listenAt = (listenPort: number) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, () => { server.off('error', reject); resolve(); });
    });
    try {
      await listenAt(port);
    } catch (error) {
      // 同机多张 Host 脸并存（Dev 槽 app、独立 host-runtime）会抢 lanPort：先来的常驻，
      // 后到的 invite 全部 EADDRINUSE，配对入口整个消失（2026-09-15 真机首验：01:04 起的
      // 旧 Dev app 占着 8182，新 Host 一个二维码都发不出来，手机只能配到旧 app 上）。
      // 端点随 QR/绑定走，换端口对手机零成本；invite 硬失败才是贵的。
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error;
      console.warn(`[companion] LAN port ${port} already in use; falling back to an ephemeral port`);
      await listenAt(0);
    }
    this.server = server;
    this.listenPort = (server.address() as { port: number }).port;
    this.startAddress = address;
    this.sweep = setInterval(() => this.prune(), L.handshakeTtlMs);
    this.sweep.unref();
  }

  /**
   * welcome 里报给手机的「我此刻在哪」。只有**这次握手实际落在哪张网卡上**
   * （`socket.localAddress`）才算数，别的一律不报：
   *
   * - 宿主同时挂着 Wi-Fi 与热点时，`privateLanAddresses()[0]` 可能是手机根本不在的那一张，
   *   手机一采纳就把本来好好的连接换到一个连不上的地址上；
   * - 走 loopback 的调用方（本机自测、集成测试）拿到的会是一个它根本够不到的局域网字面量，
   *   下一个请求直接超时挂死——实测就是这么挂的（companionLan 两条字典用例 10s 超时）。
   *
   * 拿不准就返回 null ⇒ welcome 不带地址 ⇒ 手机留住它手里那个。**宁可不说，不可说错**：
   * 手机手里那个至少此刻是通的，而一个错地址会把唯一能用的路也换掉。
   *
   * 与下面 endpoints()（二维码广告用）分开：那个答的是「谁都可以来连我」，这个答的是
   * 「**你**够得到我的那一个」——同一台机器上这两个答案未必一样。
   */
  private reachedEndpoint(via?: string): string | null {
    const reached = via?.replace(/^::ffff:/, '');
    return reached && isPrivateIPv4(reached) ? `http://${reached}:${this.listenPort}` : null;
  }

  /**
   * 二维码里广告的地址。**每次现算**，不用 start() 冻住的那个：socket 绑的是全部接口，宿主
   * 换网后照样能连，变的只是"该报哪个地址"。冻住它 ⇒ 换网后发出去的二维码带着一个死地址，
   * 手机扫了也连不上（N-COMPANION-NOLANPORT，爸 2026-09-16 真机）。
   *
   * 主地址用「此刻一定连得上」的字面量；mDNS 名只作备用，手机连不上主地址时才试它。
   * 反过来（只广告 mDNS 名）在「电脑连手机热点」下 100% 配不上：手机解析不了宿主的 .local。
   *
   * 主地址是单数不够：宿主多张私网接口时 `[0]` 可能是手机根本不在的那一张（reachedEndpoint
   * 的注释同款场景），热点下 .local 又解析不了 ⇒ 两个候选全灭。candidates 把**全部**私网
   * 字面量带出去（含 [0]，手机侧去重保序），socket 绑的就是全部接口，每一张都真的能连进来。
   */
  private endpoints(): { endpoint: string; altEndpoint: string | null; candidates: string[] } {
    // 列表为空 = 此刻没有任何私网接口（掉线）。那时报 start 时那个总比报空串强：
    // 手机拿它去试顶多失败一次，而空串会让 validateLanEndpoint 直接抛。
    const addresses = privateLanAddresses();
    const address = addresses[0] ?? this.startAddress;
    const endpoint = `http://${address}:${this.listenPort}`;
    const advertised = lanAdvertisedHost(address, hostname());
    const candidates = addresses.slice(0, L.invitationMaxCandidates).map(a => `http://${a}:${this.listenPort}`);
    return { endpoint, altEndpoint: advertised === address ? null : `http://${advertised}:${this.listenPort}`, candidates };
  }

  invite(scope: string[]): LanInvitation {
    if (!this.server || scope.length < 1 || scope.length > L.maxScopeSessions || scope.some(id => !id.trim() || id.length > L.idLength)) {
      throw new Error('COMPANION_INVALID_SCOPE');
    }
    this.pending.clear();
    this.invitation = { id: randomUUID(), psk: randomBytes(32).toString('hex'), scope: [...new Set(scope)], expiresAt: this.now() + L.invitationTtlMs };
    const hostKey = toHex(this.identity.publicKey);
    const { endpoint, altEndpoint, candidates } = this.endpoints();
    return { version: 1, endpoint, ...(altEndpoint ? { altEndpoint } : {}),
      // 单接口宿主的 candidates 与 endpoint 完全重合，带上只白占二维码字节：只在真有多张网卡时带。
      ...(candidates.length > 1 ? { candidates } : {}),
      inviteId: this.invitation.id, psk: this.invitation.psk, hostKey, expiresAt: this.invitation.expiresAt,
      verify: deriveInvitationVerify(this.invitation.psk, hostKey) };
  }

  revoke(deviceId: string): void {
    getRegisteredCompanionDictation()?.release(deviceId);
    this.gateway.revokeDevice(deviceId);
    this.prune();
  }

  hasApprovalUi(sessionId: string): boolean {
    const now = this.now();
    return [...this.channels.values()].some(channel => {
      if (channel.lastSeenAt === null || now < channel.lastSeenAt
        || now - channel.lastSeenAt >= L.uiPresenceTtlMs || channel.expiresAt <= now) return false;
      const device = this.gateway.identityDevice(channel.publicKey);
      return !!device && this.gateway.canAccessSession(device.deviceId, sessionId);
    });
  }

  async stop(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.invitation = null; this.pending.clear();
    for (const c of this.channels.values()) {
      this.releaseDictation(c.publicKey);
      c.cipher.close();
    }
    this.channels.clear();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }

  private prune(): void {
    const now = this.now();
    if (this.invitation && this.invitation.expiresAt <= now) this.invitation = null;
    for (const [id, p] of this.pending) if (p.expiresAt <= now || p.invite !== this.invitation) this.pending.delete(id);
    for (const [id, c] of this.channels) {
      if (c.expiresAt <= now) {
        this.releaseDictation(c.publicKey);
        c.cipher.close(); this.channels.delete(id);
        // TTL 到期 = 手机已经 channelTtlMs 没有任何 exchange 了（正常轮询下每秒都会续期）。
        // 不为这一行单独查 identityDevice（ai-review R3 Nit 4）：身份用 channel 自带的公钥前缀说。
        logCompanionRelayInfo(this.logger, `Companion LAN channel closed: reason=ttl_expired channel=${idPrefix(id)} key=${idPrefix(c.publicKey)}`);
        continue;
      }
      // 身份已失效（撤销/删除）的 channel 不删、只关密文：留一个墓碑，让该设备的下一次
      // exchange 还能凭 channel.publicKey 认出它、在解密之前就回 COMPANION_DEVICE_REVOKED。
      // 删掉的话只剩匿名的 CHANNEL_CLOSED，手机无从区分「被踢」和「电脑没回应」。
      // 密文已关 + exchange 的身份检查在 cipher.open 之前 ⇒ 墓碑不打开任何请求窗口，
      // 也不是「放行一拍让 syncForDevice 应答」；到 TTL 自然回收。
      if (!this.gateway.identityDevice(c.publicKey)) {
        this.releaseDictation(c.publicKey);
        c.cipher.close();
        // 身份既然已失效，这里解不出 deviceId，只给公钥前缀；且同一墓碑只在第一轮 prune 落一行。
        if (!c.identityLogged) {
          c.identityLogged = true;
          this.logger?.warn(`Companion LAN channel closed: reason=identity_invalid channel=${idPrefix(id)} key=${idPrefix(c.publicKey)}`);
        }
      }
    }
  }

  private hello(body: HelloBody, via?: string, peer = '') {
    try {
      return this.helloChecked(body, via);
    } catch (error) {
      // /v1/hello 在鉴权之前，同网段任意设备都能打：拒单行按「对端 IP × 错误码」去重，
      // 同一对端复读同一错误不再逐拍刷行；换了错误码（新故障）仍要点名。
      const code = exchangeErrorCode(error);
      if (!this.helloRejects.has(`${peer}|${code}`)) {
        this.helloRejects.add(`${peer}|${code}`);
        this.logger?.warn(`Companion LAN handshake rejected: mode=${modeLabel(body.mode)} via=${via ?? '-'} peer=${peer || '-'} code=${code}`);
      }
      throw error;
    }
  }

  private helloChecked(body: HelloBody, via?: string) {
    this.prune();
    if (this.now() - this.handshakeWindow >= L.handshakeTtlMs) { this.handshakeWindow = this.now(); this.handshakeCount = 0; }
    if (++this.handshakeCount > L.maxChannels || this.channels.size >= L.maxChannels || this.pending.size >= L.maxHandshakes) {
      throw new Error('COMPANION_BUSY');
    }
    const channelId = randomUUID();
    if (body.mode === 'pair') {
      const invite = this.invitation;
      if (!invite || body.inviteId !== invite.id) throw new Error('COMPANION_INVITATION_EXPIRED');
      const noise = createHandshake(false, this.identity, invite.id, invite.psk);
      if (noise.recv(fromHex(body.frame)).length !== 0) throw new Error('COMPANION_INVALID_FRAME');
      const frame = toHex(noise.send());
      this.pending.set(channelId, { noise, invite, expiresAt: this.now() + L.handshakeTtlMs });
      logCompanionRelayInfo(this.logger, `Companion LAN handshake: mode=pair channel=${idPrefix(channelId)} via=${via ?? '-'}`);
      return { channelId, frame };
    }
    if (body.mode !== 'resume') throw new Error('COMPANION_INVALID_FRAME');
    const noise = createHandshake(false, this.identity);
    if (noise.recv(fromHex(body.frame)).length !== 0 || !noise.rs) throw new Error('COMPANION_INVALID_FRAME');
    const publicKey = toHex(noise.rs);
    const device = this.gateway.identityDevice(publicKey);
    if (!device) throw new Error('COMPANION_DEVICE_REVOKED');
    const frame = toHex(noise.send());
    const cipher = new NoiseChannel(noise);
    this.channels.set(channelId, { cipher, publicKey, expiresAt: this.now() + L.channelTtlMs, lastSeenAt: null });
    logCompanionRelayInfo(this.logger, `Companion LAN handshake: mode=resume channel=${idPrefix(channelId)} device=${device.deviceId} via=${via ?? '-'}`);
    return { channelId, frame, welcome: cipher.seal(this.welcome(device, via)) };
  }

  private finish(body: ChannelBody, via?: string) {
    try {
      return this.finishChecked(body, via);
    } catch (error) {
      this.logger?.warn(`Companion LAN handshake rejected: mode=finish via=${via ?? '-'} code=${exchangeErrorCode(error)}`);
      throw error;
    }
  }

  private finishChecked(body: ChannelBody, via?: string) {
    this.prune();
    const id = typeof body.channelId === 'string' ? body.channelId : '';
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending?.invite !== this.invitation || this.channels.size >= L.maxChannels) throw new Error('COMPANION_INVITATION_EXPIRED');
    if (pending.noise.recv(fromHex(body.frame)).length !== 0 || !pending.noise.rs) throw new Error('COMPANION_INVALID_FRAME');
    // Synchronous consumption + SQLite identity transaction: only one finish can win.
    this.invitation = null; this.pending.clear();
    const publicKey = toHex(pending.noise.rs);
    const device = this.gateway.pairIdentity(publicKey, pending.invite.scope);
    const cipher = new NoiseChannel(pending.noise);
    this.channels.set(id, { cipher, publicKey, expiresAt: this.now() + L.channelTtlMs, lastSeenAt: null });
    logCompanionRelayInfo(this.logger, `Companion LAN handshake: mode=finish channel=${idPrefix(id)} device=${device.deviceId} scope=${device.scope.length} via=${via ?? '-'}`);
    return { welcome: cipher.seal(this.welcome(device, via)) };
  }

  private async exchange(body: ChannelBody) {
    this.prune();
    const id = typeof body.channelId === 'string' ? body.channelId : '';
    const channel = this.channels.get(id);
    if (!channel) throw new Error('COMPANION_CHANNEL_CLOSED');
    try {
      if (!Array.isArray(body.frame) || body.frame.length > L.maxRequestRecords) throw new Error('COMPANION_INVALID_FRAME');
      const device = this.gateway.identityDevice(channel.publicKey);
      if (!device) throw new Error('COMPANION_DEVICE_REVOKED');
      const request = channel.cipher.open(body.frame) as {
        requestId?: unknown; action?: unknown; command?: unknown; epoch?: unknown; afterSeq?: unknown;
        commandId?: unknown; query?: unknown; provider?: unknown; token?: unknown; environment?: unknown; routeToken?: unknown;
        op?: unknown; pcm?: unknown; streamId?: unknown;
      };
      if (!request || typeof request.requestId !== 'string' || request.requestId.length > L.idLength) throw new Error('COMPANION_INVALID_REQUEST');
      // 轮询型动作（sync/status 手机每秒一发）与 dictation 音频帧（100ms 一拍的实时流，
      // 60s 录音就是几百拍）只在通道首拍留痕；其余动作低频，每次一行。
      if ((request.action !== 'sync' && request.action !== 'status' && request.action !== 'dictation') || channel.lastSeenAt === null) {
        logCompanionRelayInfo(this.logger, `Companion LAN exchange: action=${actionLabel(request.action)} channel=${idPrefix(id)}${channel.lastSeenAt === null ? ' first=true' : ''}`);
      }
      let result: unknown;
      if (request.action === 'command') {
        const command = companionCommandSchema.parse(request.command);
        if (command.deviceId !== device.deviceId) throw new Error('COMPANION_IDENTITY_MISMATCH');
        result = await this.gateway.submit(command);
      } else if (request.action === 'push.register') {
        result = this.push?.register(device.deviceId, { provider: request.provider, token: request.token, environment: request.environment })
          ?? { kind: 'rejected', reason: 'unsupported_action' };
      } else if (request.action === 'push.unregister') {
        result = this.push?.unregister(device.deviceId) ?? { kind: 'rejected', reason: 'unsupported_action' };
      } else if (request.action === 'push.open') {
        result = this.push?.open(device.deviceId, { routeToken: request.routeToken })
          ?? { kind: 'rejected', reason: 'unsupported_action' };
      } else if (request.action === 'read') {
        result = await this.gateway.read(device.deviceId, request.query);
      } else if (request.action === 'relay.route') {
        // 路由发现：手机趁 LAN 还连着把 relay 路由缓存下来，LAN 断了才有路可落（N-MOBILE-RELAY-PHONE）。
        const route = this.relayRoute?.(device.deviceId) ?? null;
        result = route ? { kind: 'ok' as const, ...route } : { kind: 'unavailable' as const };
      } else if (request.action === 'relay.routes') {
        // 双路由下发（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：legacy 是既有契约原样（含共享凭据），
        // account 是不带凭据的账号路由引用。两条都没有回 unavailable；旧动作 relay.route 原样保留。
        const legacy = this.relayRoute?.(device.deviceId) ?? null;
        const account = this.relayAccountRoute?.(device.deviceId) ?? null;
        result = legacy || account
          ? { kind: 'ok' as const, routes: { v: 1 as const, ...(account ? { account } : {}), ...(legacy ? { legacy } : {}) } }
          : { kind: 'unavailable' as const };
      } else if (request.action === 'sync') {
        if (!Number.isSafeInteger(request.epoch) || Number(request.epoch) < 1 || !Number.isSafeInteger(request.afterSeq) || Number(request.afterSeq) < 0) throw new Error('COMPANION_INVALID_CURSOR');
        const page = this.gateway.syncForDevice(device.deviceId, Number(request.epoch), Number(request.afterSeq));
        let bytes = 512;
        const events: CompanionEvent[] = [];
        let nextSeq = page.nextSeq;
        for (const event of page.events) {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (bytes + size > L.maxPayloadBytes * L.maxMessageRecords) {
            // An event larger than a whole frame can never be delivered. Retiring the channel
            // left the cursor pinned on it forever, so the device could never advance again.
            // Hand over a same-seq marker instead: the cursor clears it and the phone still
            // sees that something was dropped rather than silently missing a seq.
            if (events.length === 0) { events.push(dropped(event, size)); nextSeq = event.seq; }
            else nextSeq = event.seq - 1;
            break;
          }
          bytes += size + 1; events.push(event);
        }
        result = { ...page, events, nextSeq };
        // epoch 变了（snapshot_required）或设备被撤（revoked）都是手机必须重自拍的异常拍，单独点名。
        if (page.kind !== 'events') this.logger?.warn(`Companion LAN exchange anomaly: action=sync channel=${idPrefix(id)} result=${page.kind}`);
      } else if (request.action === 'status' && typeof request.commandId === 'string' && request.commandId.length <= L.idLength) {
        result = this.gateway.commandStatus(device.deviceId, request.commandId);
        // 手机在轮询的 commandId 宿主根本不认识（或已不可见）⇒ 手机 pending 只能等超时回收。
        // 轮询是逐秒的：同一 ghost commandId 只点名一次，别的 ghost 仍各自点名（ai-review R3 Nit 1）。
        if (result === null && !this.ghostCommandIds.has(request.commandId)) {
          this.ghostCommandIds.add(request.commandId);
          this.logger?.warn(`Companion LAN exchange anomaly: action=status channel=${idPrefix(id)} commandId=${idPrefix(request.commandId)} result=unknown`);
        }
      } else if (request.action === 'dictation') {
        result = await this.dictation(device.deviceId, request);
      } else throw new Error('COMPANION_UNSUPPORTED_ACTION');
      const frame = channel.cipher.seal({ requestId: request.requestId, result });
      const lastSeenAt = this.now();
      channel.lastSeenAt = lastSeenAt;
      channel.expiresAt = lastSeenAt + L.channelTtlMs;
      return { frame };
    } catch (error) {
      // 身份还健在的按老规矩整条退场；身份已失效的留墓碑（撤销后手机可能还有几拍 poke 要认）。
      const device = this.gateway.identityDevice(channel.publicKey);
      if (device) {
        this.releaseDictation(channel.publicKey);
        channel.cipher.close(); this.channels.delete(id);
        // 断链取证（N-MOBILE-SEND-RESULT-LOST）：exchange 抛错当场关整条 channel 是安全纪律，
        // 但必须留痕——手机下一拍只会拿到笼统的 CHANNEL_CLOSED，没有这行就无从归因。
        this.logger?.warn(`Companion LAN channel closed: reason=exchange_error channel=${idPrefix(id)} device=${device.deviceId} error=${exchangeErrorCode(error)}`);
      }
      throw error;
    }
  }

  /**
   * 握手回执。除了设备身份，**带上宿主此刻的 LAN 地址**：手机存的地址是配对那一刻写死的，
   * 换网后就死了（N-COMPANION-NOLANPORT）。只要还有任何一条路连得上（旧地址仍通、mDNS 通、
   * 将来经 relay），手机就能借这次 welcome 把地址刷新成当前的，下次直连。
   * 这是"地址自愈"唯一不依赖额外通道的落点：握手本来就一定会发生。
   */
  private welcome(device: { deviceId: string; scopeEpoch: number; scope: readonly string[] }, via?: string) {
    const endpoint = this.reachedEndpoint(via);
    // 只捎当前地址，不动 altEndpoint：那一格记的是「我们还知道的另一个候选」，
    // 由手机自己维护（哪个拨通了哪个当主、另一个留作备用），宿主不该覆盖它。
    const base = endpoint ? { ...device, endpoint } : device;
    // 电脑账号邮箱（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：每次握手现取——登录/退出/换账号
    // 都反映在下一次 welcome 里，手机侧配对信息随之自愈。没登录就不带这一格。
    const email = this.hostAccountEmail?.() ?? null;
    return {
      ...base,
      transcription: companionTranscriptionReadiness(),
      sessionlessTranscribe: true as const,
      ...(email ? { hostAccountEmail: email } : {}),
      ...(getRegisteredCompanionDictation() ? { dictation: true as const, dictationTranscription: companionDictationReadiness() } : {}),
    };
  }

  private releaseDictation(publicKey: string): void {
    const device = this.gateway.identityDevice(publicKey);
    if (device) getRegisteredCompanionDictation()?.release(device.deviceId);
  }

  private async dictation(deviceId: string, request: { op?: unknown; pcm?: unknown; streamId?: unknown }) {
    const port = getRegisteredCompanionDictation();
    if (!port) return { ok: false, code: 'COMPANION_DICTATION_UNAVAILABLE', events: [] };
    if (request.op === 'open') return port.open(deviceId);
    if (request.op === 'close') {
      port.release(deviceId);
      return { ok: true, events: [] };
    }
    if (typeof request.streamId !== 'string' || !request.streamId || request.streamId.length > L.idLength) {
      return { ok: false, code: 'COMPANION_DICTATION_INACTIVE', events: [] };
    }
    if (request.op === 'stop') return port.stop(deviceId, request.streamId);
    if (request.op !== 'audio' || typeof request.pcm !== 'string' || request.pcm.length > L.voicePcmBase64Limit
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(request.pcm)) {
      return { ok: false, code: 'COMPANION_INVALID_FRAME', events: [] };
    }
    const pcm = Buffer.from(request.pcm, 'base64');
    if (pcm.length === 0 || pcm.length % 2 !== 0) return { ok: false, code: 'COMPANION_INVALID_FRAME', events: [] };
    return port.audio(deviceId, request.streamId, pcm);
  }
}
