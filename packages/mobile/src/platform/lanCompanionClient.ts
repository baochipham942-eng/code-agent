import type { KeyPair } from 'noise-handshake';
import { createHandshake, NoiseChannel } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex, parseInvitation, validateLanEndpoint, type LanBinding, type LanInvitation } from '../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';

export type LanPost = (url: string, body: unknown) => Promise<unknown>;

/** All requests on a channel are serialized because Noise records are ordered. */
export class LanCompanionClient {
  private channel: NoiseChannel | null = null;
  private channelId = '';
  private binding: LanBinding | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  constructor(private readonly identity: KeyPair, private readonly post: LanPost) {}

  async pair(raw: string): Promise<LanBinding> {
    const invitation = parseInvitation(raw);
    return this.overAddresses(invitation, (endpoint, alternate) => this.pairAt(invitation, endpoint, alternate));
  }

  /**
   * 宿主给两个地址：字面量（此刻一定连得上）和 mDNS 名（换网后仍有效）。按序试，
   * 记住连通的那个——它们指向同一台宿主，hostKey 校验对两者一视同仁。
   * 两个都失败时抛**第一个**错误：主地址的失败原因才是用户要看的那句。
   *
   * 只有「没连上」才换地址。握手本身谈崩了（主机身份不对、绑定变了、会话被调用方换掉）
   * 说明我们**已经**够到了宿主，换个地址还是同一台机器、同样谈崩，
   * 白白烧掉一次性邀请，还会把真正的失败原因替换成第二次的。
   */
  private static readonly FATAL = new Set([
    'COMPANION_CHANNEL_CHANGED', 'COMPANION_HOST_KEY_MISMATCH',
    'COMPANION_BINDING_CHANGED', 'COMPANION_INVALID_BINDING', 'COMPANION_INVALID_FRAME',
  ]);
  private async overAddresses<T>(target: { endpoint: string; altEndpoint?: string },
    attempt: (endpoint: string, alternate?: string) => Promise<T>): Promise<T> {
    const addresses = [target.endpoint, target.altEndpoint].filter((value): value is string => Boolean(value));
    let firstError: unknown;
    for (const endpoint of addresses) {
      try { return await attempt(endpoint, addresses.find(other => other !== endpoint)); }
      catch (error) {
        if (error instanceof Error && LanCompanionClient.FATAL.has(error.message)) throw error;
        firstError ??= error;
      }
    }
    throw firstError ?? new Error('COMPANION_NETWORK_UNAVAILABLE');
  }

  private async pairAt(invitation: LanInvitation, endpoint: string, alternate?: string): Promise<LanBinding> {
    this.close();
    const generation = this.generation;
    const noise = createHandshake(true, this.identity, invitation.inviteId, invitation.psk);
    try {
      const hello = await this.post(`${endpoint}/v1/hello`, {
        mode: 'pair', inviteId: invitation.inviteId, frame: toHex(noise.send()),
      }) as { channelId: string; frame: string };
      if (generation !== this.generation) throw new Error('COMPANION_CHANNEL_CHANGED');
      if (noise.recv(fromHex(hello.frame)).length !== 0 || !noise.rs || toHex(noise.rs) !== invitation.hostKey) throw new Error('COMPANION_HOST_KEY_MISMATCH');
      const finish = toHex(noise.send());
      this.channel = new NoiseChannel(noise); this.channelId = hello.channelId;
      const result = await this.post(`${endpoint}/v1/finish`, { channelId: hello.channelId, frame: finish }) as { welcome: string[] };
      if (generation !== this.generation) throw new Error('COMPANION_CHANNEL_CHANGED');
      this.binding = this.readBinding(this.channel.open(result.welcome), endpoint, invitation.hostKey, alternate);
      return this.binding;
    } catch (error) { if (generation === this.generation) this.close(); throw error; }
  }

  async resume(binding: LanBinding): Promise<void> {
    await this.recover(binding, binding);
  }

  async recover(target: { endpoint: string; altEndpoint?: string; hostKey: string }, binding?: LanBinding): Promise<LanBinding> {
    return this.overAddresses(target, (endpoint, alternate) => this.recoverAt(endpoint, target.hostKey, alternate, binding));
  }

  private async recoverAt(endpoint: string, hostKey: string, alternate?: string, binding?: LanBinding): Promise<LanBinding> {
    this.close(); validateLanEndpoint(endpoint);
    const generation = this.generation;
    const noise = createHandshake(true, this.identity, undefined, undefined, hostKey);
    try {
      const hello = await this.post(`${endpoint}/v1/hello`, { mode: 'resume', frame: toHex(noise.send()) }) as { channelId: string; frame: string; welcome: string[] };
      if (generation !== this.generation) throw new Error('COMPANION_CHANNEL_CHANGED');
      if (noise.recv(fromHex(hello.frame)).length !== 0) throw new Error('COMPANION_INVALID_FRAME');
      this.channel = new NoiseChannel(noise); this.channelId = hello.channelId;
      const confirmed = this.readBinding(this.channel.open(hello.welcome), endpoint, hostKey, alternate);
      if (binding && (confirmed.deviceId !== binding.deviceId || confirmed.scopeEpoch !== binding.scopeEpoch || JSON.stringify(confirmed.scope) !== JSON.stringify(binding.scope))) {
        throw new Error('COMPANION_BINDING_CHANGED');
      }
      this.binding = confirmed;
      return confirmed;
    } catch (error) { if (generation === this.generation) this.close(); throw error; }
  }

  request(payload: Record<string, unknown>): Promise<unknown> {
    const expectedChannel = this.channel;
    const task = this.queue.then(async () => {
      if (!this.binding || !this.channel || this.channel !== expectedChannel) throw new Error('COMPANION_NOT_CONNECTED');
      const channel = this.channel;
      try {
        const requestId = crypto.randomUUID();
        const response = await this.post(`${this.binding.endpoint}/v1/exchange`, {
          channelId: this.channelId, frame: channel.seal({ ...payload, requestId }),
        }) as { frame: string[] };
        if (this.channel !== channel) throw new Error('COMPANION_CHANNEL_CHANGED');
        const body = channel.open(response.frame) as { requestId: string; result: unknown };
        if (body.requestId !== requestId) throw new Error('COMPANION_INVALID_ACK');
        return body.result;
      } catch (error) { if (this.channel === channel) this.close(); throw error; }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  close(): void { this.generation++; this.channel?.close(); this.channel = null; this.channelId = ''; this.binding = null; }

  private readBinding(value: unknown, endpoint: string, hostKey: string, altEndpoint?: string): LanBinding {
    const v = value as Partial<LanBinding>;
    if (!v || typeof v.deviceId !== 'string' || v.deviceId.length > L.idLength || !Number.isSafeInteger(v.scopeEpoch) || Number(v.scopeEpoch) < 1 ||
        !Array.isArray(v.scope) || v.scope.length < 1 || v.scope.length > L.maxScopeSessions || v.scope.some(id => typeof id !== 'string' || !id || id.length > L.idLength)) {
      throw new Error('COMPANION_INVALID_BINDING');
    }
    return { version: 1, endpoint, ...(altEndpoint ? { altEndpoint } : {}), hostKey,
      deviceId: v.deviceId, scopeEpoch: Number(v.scopeEpoch), scope: v.scope };
  }
}
