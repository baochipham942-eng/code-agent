import { projectGrant } from '../../../shared/contract/companionLibrary';
import { z } from 'zod';
import type { KeyPair } from 'noise-handshake';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type { CompanionManagementResult, CompanionRelayStatus } from '../../../shared/contract/companionManagement';
import { LanCompanionServer, privateLanAddresses } from './LanCompanionServer';
import { RemoteOffResponder } from './RemoteOffResponder';
import type { CompanionGateway } from './CompanionGateway';
import type { CompanionRelayLogger } from './companionRelayConfig';
import type { CompanionPushOutbox } from './CompanionPushOutbox';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('invite'), scope: z.array(z.string().trim().min(1).max(L.idLength)).min(1).max(L.maxScopeSessions) }).strict(),
  z.object({ action: z.literal('revoke'), deviceId: z.string().min(1).max(L.idLength) }).strict(),
  z.object({ action: z.literal('setRemote'), enabled: z.boolean() }).strict(),
]);

export class LanCompanionManager {
  private server: LanCompanionServer | null = null;
  private address: string | null = null;
  private starting: Promise<LanCompanionServer> | null = null;
  /** 总闸关闭期间顶班的固定拒绝应答器；与真服务同端口互斥，见 startResponder。 */
  private responder: RemoteOffResponder | null = null;
  constructor(private readonly gateway: CompanionGateway, private readonly loadIdentity: () => Promise<KeyPair>,
    private readonly listSessions: () => Promise<{ id: string; title: string }[]>,
    private readonly listProjects: () => { id: string; name: string }[] = () => [],
    private readonly push?: CompanionPushOutbox,
    private readonly relayRoute?: (deviceId: string) => import('../../../shared/contract/companionRelay').CompanionRelayRoute | null,
    /** 账号 relay 路由（不带凭据）取值回调；`relay.routes` 下发用（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）。 */
    private readonly relayAccountRoute?: (deviceId: string) => import('../../../shared/contract/companionRelay').CompanionRelayRouteRef | null,
    /** 跨网连接状态（legacy/account）取值回调；缺省时 status 结果不带 relay 字段（旧装配/旧测试）。 */
    private readonly relayStatus?: () => CompanionRelayStatus,
    /** 电脑当前登录的 Neo 账号邮箱；随 welcome 进配对信息（手机登录引导/账号核对用）。 */
    private readonly hostAccountEmail?: () => string | null,
    /** 透传给 LanCompanionServer 的连接层留痕 logger（N-MOBILE-SEND-RESULT-LOST）。 */
    private readonly logger?: CompanionRelayLogger,
    /** 总闸打开/关掉时，由装配层用同一批工厂停掉或重新拨起两条 relay。 */
    private readonly remoteTransports?: { start(): Promise<void>; stop(): Promise<void> }) {}

  /**
   * 开机自动起局域网服务的**唯一**入口，条件是本槽有配对设备。不满足时要留痕：
   * 否则这台电脑对手机是隐形的，而两边都看不出原因（N-COMPANION-NOLANPORT，爸 2026-09-16
   * 真机：跑的是 Dev 3 槽、配对在 Dev 槽，全程零对外端口、零日志，只能靠 lsof 才查得出来）。
   */
  async restore(): Promise<void> {
    if (!this.gateway.pairedDevices().length) {
      console.info('[companion] no paired device in this profile; LAN surface stays closed (phones cannot reach this host)');
      return;
    }
    if (!this.gateway.remoteEnabled()) {
      // 总闸关着（N-COMPANION-KILLSWITCH-WIRE）：绝不起真服务，只起固定拒绝应答器——
      // 手机要能分清「电脑关了远程」和「电脑不可达」，前者留着配对等 reopening，后者只会被当成断网。
      console.info('[companion] remote access is off; LAN answers every request with COMPANION_REMOTE_OFF only');
      await this.startResponder(L.lanPort)
        .catch(error => console.warn('[companion] remote-off responder failed to start:', error instanceof Error ? error.message : error));
      return;
    }
    try { await this.start(); }
    catch (error) {
      console.warn('[companion] LAN surface failed to start:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async manage(raw: unknown): Promise<CompanionManagementResult> {
    const request = requestSchema.parse(raw);
    if (request.action === 'status') return this.statusResult();
    if (request.action === 'revoke') {
      // 单台撤销与总闸无关：关着的时候也允许，打开后仍然拒绝这台。
      if (this.server) this.server.revoke(request.deviceId); else this.gateway.revokeDevice(request.deviceId);
      if (this.responder && !this.gateway.pairedDevices().length) await this.stopResponder();
      return { kind: 'revoked' };
    }
    if (request.action === 'setRemote') {
      this.gateway.setRemoteEnabled(request.enabled);
      if (request.enabled) {
        // LAN 面受环境影响（仅热点/VPN 时无私网 IPv4，restore 会抛 COMPANION_LAN_UNAVAILABLE）。
        // 打开总闸时它与 app.ts 开机路径同形按 best-effort 处理：失败只留痕，不能挡住
        // 两条 relay 的重新拨起——否则开关已持久化为开，relay 却直到重启 app 都不拨号。
        await this.stopResponder();
        await this.restore().catch(error => console.warn('[companion] remote switch on; LAN surface unavailable:', error instanceof Error ? error.message : error));
        await this.remoteTransports?.start();
      } else {
        // 关掉不是掀桌：真服务下岗、固定拒绝应答器在同一端口顶班（有配对设备才起，与 restore
        // 同一道门）。应答器起不来（仅热点/VPN）只留痕不挡道——关闸必须总能成功，relay 一定要停。
        const port = this.server?.port() || this.responder?.port || L.lanPort;
        await this.startResponder(port)
          .catch(error => console.warn('[companion] remote switch off; responder unavailable:', error instanceof Error ? error.message : error));
        await this.remoteTransports?.stop();
      }
      return this.statusResult();
    }
    if (!this.gateway.remoteEnabled()) throw new Error('COMPANION_REMOTE_OFF');
    const sessions = await this.listSessions();
    if (request.scope.some(id => !sessions.some(session => session.id === id) && !this.listProjects().some(project => projectGrant(project.id) === id))) throw new Error('COMPANION_SESSION_NOT_FOUND');
    const server = await this.start();
    return { kind: 'invitation', invitation: server.invite(request.scope) };
  }

  private async statusResult(): Promise<CompanionManagementResult> {
    const relay = this.relayStatus?.();
    return {
      kind: 'status',
      sessions: await this.listSessions(),
      projects: this.listProjects(),
      devices: this.gateway.pairedDevices(),
      remoteEnabled: this.gateway.remoteEnabled(),
      ...(relay ? { relay } : {}),
    };
  }

  hasApprovalUi(sessionId: string): boolean { return this.server?.hasApprovalUi(sessionId) ?? false; }

  /**
   * LAN 地址三件套（N-COMPANION-RELAY-ACCOUNT-RECOVER）：relay 找回配对载荷随 welcome 等值内容
   * 下发，与二维码邀请同源（每次现取，不冻住）。LAN 面没起（这台电脑还没有配对设备）时 null，
   * 手机侧 binding 的 LAN 地址留空、仅中继可达。
   * 总闸关着时只有应答器在答（N-COMPANION-KILLSWITCH-WIRE）：报应答器的端点——那一刻两条
   * relay 都停着，找回载荷发不出去，这个值实际服务于「面还在不在」的观测与验收。
   */
  lanAdvertisement(): { endpoint: string; altEndpoint: string | null; candidates: string[] } | null {
    if (this.server) return this.server.endpoints();
    if (this.responder) {
      const address = privateLanAddresses()[0];
      return address ? { endpoint: `http://${address}:${this.responder.port}`, altEndpoint: null, candidates: [] } : null;
    }
    return null;
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => {});
    const server = this.server; this.server = null; this.address = null;
    const responder = this.responder; this.responder = null;
    await server?.stop();
    await responder?.stop();
  }

  private async stopResponder(): Promise<void> {
    const responder = this.responder; this.responder = null;
    await responder?.stop();
  }

  /**
   * 起固定拒绝应答器。只在**有配对设备**时起（与 restore 的真服务同一道门：没有手机配对过，
   * 就没有人需要分辨「关了远程」和「不可达」）；也要求此刻有私网 IPv4（与真服务同环境判据）。
   * 真服务与应答器在同一端口上互斥顶班：起任何一个之前，两个都先停干净。
   */
  private async startResponder(port: number): Promise<void> {
    const paired = this.gateway.pairedDevices().length > 0;
    await this.stop();
    if (!paired) {
      console.info('[companion] no paired device in this profile; remote-off responder stays closed');
      return;
    }
    if (!privateLanAddresses().length) throw new Error('COMPANION_LAN_UNAVAILABLE');
    const responder = new RemoteOffResponder();
    await responder.start(port);
    this.responder = responder;
  }

  private start(): Promise<LanCompanionServer> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // 真服务要起时应答器必须先让位：两者同端口顶班，关系是双向的（旗标被绕过 manage 直接
      // 翻开的窄路上，别让应答器占着端口把真服务挤去临时端口）。
      await this.stopResponder();
      const addresses = privateLanAddresses();
      if (this.server && this.address && addresses.includes(this.address)) return this.server;
      // A new invitation must never advertise an interface that disappeared.
      await this.server?.stop(); this.server = null; this.address = null;
      const address = addresses[0];
      if (!address) throw new Error('COMPANION_LAN_UNAVAILABLE');
      const server = new LanCompanionServer(this.gateway, await this.loadIdentity(), Date.now, this.push, this.relayRoute, this.relayAccountRoute, this.hostAccountEmail, this.logger);
      await server.start(address); this.server = server; this.address = address; return server;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
}
