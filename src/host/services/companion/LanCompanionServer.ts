import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import type Noise from 'noise-handshake';
import type { KeyPair } from 'noise-handshake';
import { COMPANION_EVENT_DROPPED, COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { fromHex, toHex, isPrivateIPv4, type LanInvitation } from '../../../shared/companion/lanProtocol';
import { createHandshake, NoiseChannel } from '../../../shared/companion/noiseChannel';
import { companionCommandSchema, type CompanionEvent } from '../../../shared/contract/companion';
import type { CompanionGateway } from './CompanionGateway';

interface Invitation { id: string; psk: string; expiresAt: number; scope: string[] }
interface Pending { noise: Noise; invite: Invitation; expiresAt: number }
interface Channel { cipher: NoiseChannel; publicKey: string; expiresAt: number; lastSeenAt: number | null }
/** Wire bodies stay `unknown`-per-field: every handler below validates before use. */
interface HelloBody { mode?: unknown; inviteId?: unknown; frame?: unknown }
interface ChannelBody { channelId?: unknown; frame?: unknown }

/** Keeps the seq and envelope of the event it replaces; the payload only says what was lost. */
function dropped(event: CompanionEvent, bytes: number): CompanionEvent {
  return { ...event, kind: COMPANION_EVENT_DROPPED, payload: { reason: 'too_large', kind: event.kind, bytes } };
}

/** Dedicated LAN surface: encrypted records only, never desktop HTTP/IPC routes. */
export class LanCompanionServer {
  private server: Server | null = null;
  private invitation: Invitation | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly channels = new Map<string, Channel>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private endpoint = '';
  private handshakeWindow = 0;
  private handshakeCount = 0;

  constructor(private readonly gateway: CompanionGateway, private readonly identity: KeyPair,
    private readonly now = Date.now) {}

  async start(address: string, port: number = L.lanPort): Promise<void> {
    if (this.server) return;
    if (!isPrivateIPv4(address)) throw new Error('COMPANION_LAN_UNAVAILABLE');
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
      res.setHeader('Cache-Control', 'no-store');
      if (!isPrivateIPv4(peer)) { res.sendStatus(403); return; }
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json' ||
          (req.headers.origin && !['capacitor://localhost', 'http://localhost', 'https://localhost'].includes(req.headers.origin))) {
        res.sendStatus(403); return;
      }
      next();
    });
    app.use(express.json({ limit: L.maxFrameBytes * L.maxRequestRecords * 2 + 512, strict: true }));
    app.post('/v1/hello', (req, res) => {
      try { res.json(this.hello(req.body as HelloBody)); } catch { res.status(403).json({ error: 'COMPANION_HANDSHAKE_REJECTED' }); }
    });
    app.post('/v1/finish', (req, res) => {
      try { res.json(this.finish(req.body as ChannelBody)); } catch { res.status(403).json({ error: 'COMPANION_HANDSHAKE_REJECTED' }); }
    });
    app.post('/v1/exchange', async (req, res) => {
      try { res.json(await this.exchange(req.body as ChannelBody)); } catch { res.status(403).json({ error: 'COMPANION_CHANNEL_CLOSED' }); }
    });
    // Body/parser failures must never echo ciphertext, invitation material, or stack traces.
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({ error: 'COMPANION_INVALID_FRAME' });
    });
    const server = createServer(app);
    server.requestTimeout = L.requestTimeoutMs;
    server.headersTimeout = L.requestTimeoutMs;
    server.maxConnections = L.maxChannels * 2;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.endpoint = `http://${address}:${(server.address() as { port: number }).port}`;
    this.sweep = setInterval(() => this.prune(), L.handshakeTtlMs);
    this.sweep.unref();
  }

  invite(scope: string[]): LanInvitation {
    if (!this.server || scope.length < 1 || scope.length > L.maxScopeSessions || scope.some(id => !id.trim() || id.length > L.idLength)) {
      throw new Error('COMPANION_INVALID_SCOPE');
    }
    this.pending.clear();
    this.invitation = { id: randomUUID(), psk: randomBytes(32).toString('hex'), scope: [...new Set(scope)], expiresAt: this.now() + L.invitationTtlMs };
    return { version: 1, endpoint: this.endpoint, inviteId: this.invitation.id, psk: this.invitation.psk,
      hostKey: toHex(this.identity.publicKey), expiresAt: this.invitation.expiresAt };
  }

  revoke(deviceId: string): void {
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
    for (const c of this.channels.values()) c.cipher.close();
    this.channels.clear();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }

  private prune(): void {
    const now = this.now();
    if (this.invitation && this.invitation.expiresAt <= now) this.invitation = null;
    for (const [id, p] of this.pending) if (p.expiresAt <= now || p.invite !== this.invitation) this.pending.delete(id);
    for (const [id, c] of this.channels) if (c.expiresAt <= now || !this.gateway.identityDevice(c.publicKey)) {
      c.cipher.close(); this.channels.delete(id);
    }
  }

  private hello(body: HelloBody) {
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
    return { channelId, frame, welcome: cipher.seal(device) };
  }

  private finish(body: ChannelBody) {
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
    return { welcome: cipher.seal(device) };
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
      const request = channel.cipher.open(body.frame) as { requestId?: unknown; action?: unknown; command?: unknown; epoch?: unknown; afterSeq?: unknown; commandId?: unknown; query?: unknown };
      if (!request || typeof request.requestId !== 'string' || request.requestId.length > L.idLength) throw new Error('COMPANION_INVALID_REQUEST');
      let result: unknown;
      if (request.action === 'command') {
        const command = companionCommandSchema.parse(request.command);
        if (command.deviceId !== device.deviceId) throw new Error('COMPANION_IDENTITY_MISMATCH');
        result = this.gateway.submit(command);
      } else if (request.action === 'read') {
        result = await this.gateway.read(device.deviceId, request.query);
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
      } else if (request.action === 'status' && typeof request.commandId === 'string' && request.commandId.length <= L.idLength) {
        result = this.gateway.commandStatus(device.deviceId, request.commandId);
      } else throw new Error('COMPANION_UNSUPPORTED_ACTION');
      const frame = channel.cipher.seal({ requestId: request.requestId, result });
      const lastSeenAt = this.now();
      channel.lastSeenAt = lastSeenAt;
      channel.expiresAt = lastSeenAt + L.channelTtlMs;
      return { frame };
    } catch (error) {
      channel.cipher.close(); this.channels.delete(id); throw error;
    }
  }
}
