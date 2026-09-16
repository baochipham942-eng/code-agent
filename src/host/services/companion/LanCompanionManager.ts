import { projectGrant } from '../../../shared/contract/companionLibrary';
import { z } from 'zod';
import type { KeyPair } from 'noise-handshake';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type { CompanionManagementResult } from '../../../shared/contract/companionManagement';
import { LanCompanionServer, privateLanAddresses } from './LanCompanionServer';
import type { CompanionGateway } from './CompanionGateway';
import type { CompanionPushOutbox } from './CompanionPushOutbox';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('invite'), scope: z.array(z.string().trim().min(1).max(L.idLength)).min(1).max(L.maxScopeSessions) }).strict(),
  z.object({ action: z.literal('revoke'), deviceId: z.string().min(1).max(L.idLength) }).strict(),
]);

export class LanCompanionManager {
  private server: LanCompanionServer | null = null;
  private address: string | null = null;
  private starting: Promise<LanCompanionServer> | null = null;
  constructor(private readonly gateway: CompanionGateway, private readonly loadIdentity: () => Promise<KeyPair>,
    private readonly listSessions: () => Promise<{ id: string; title: string }[]>,
    private readonly listProjects: () => { id: string; name: string }[] = () => [],
    private readonly push?: CompanionPushOutbox,
    private readonly relayRoute?: (deviceId: string) => import('../../../shared/contract/companionRelay').CompanionRelayRoute | null) {}

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
    try { await this.start(); }
    catch (error) {
      console.warn('[companion] LAN surface failed to start:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async manage(raw: unknown): Promise<CompanionManagementResult> {
    const request = requestSchema.parse(raw);
    if (request.action === 'status') return { kind: 'status', sessions: await this.listSessions(), projects: this.listProjects(), devices: this.gateway.pairedDevices() };
    if (request.action === 'revoke') {
      if (this.server) this.server.revoke(request.deviceId); else this.gateway.revokeDevice(request.deviceId);
      return { kind: 'revoked' };
    }
    const sessions = await this.listSessions();
    if (request.scope.some(id => !sessions.some(session => session.id === id) && !this.listProjects().some(project => projectGrant(project.id) === id))) throw new Error('COMPANION_SESSION_NOT_FOUND');
    const server = await this.start();
    return { kind: 'invitation', invitation: server.invite(request.scope) };
  }

  hasApprovalUi(sessionId: string): boolean { return this.server?.hasApprovalUi(sessionId) ?? false; }

  async stop(): Promise<void> { await this.starting?.catch(() => {}); await this.server?.stop(); this.server = null; this.address = null; }

  private start(): Promise<LanCompanionServer> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const addresses = privateLanAddresses();
      if (this.server && this.address && addresses.includes(this.address)) return this.server;
      // A new invitation must never advertise an interface that disappeared.
      await this.server?.stop(); this.server = null; this.address = null;
      const address = addresses[0];
      if (!address) throw new Error('COMPANION_LAN_UNAVAILABLE');
      const server = new LanCompanionServer(this.gateway, await this.loadIdentity(), Date.now, this.push, this.relayRoute);
      await server.start(address); this.server = server; this.address = address; return server;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
}
