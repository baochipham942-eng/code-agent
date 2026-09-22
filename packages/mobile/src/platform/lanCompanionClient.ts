import type { KeyPair } from 'noise-handshake';
import { createHandshake, NoiseChannel } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex, parseInvitation, validateLanEndpoint, type LanBinding, type LanInvitation } from '../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';

export type LanPost = (url: string, body: unknown) => Promise<unknown>;

/**
 * 宿主在 welcome 里报的地址优先于「我们这次拨通的那个」（N-COMPANION-NOLANPORT）。
 *
 * 为什么要优先：绑定里的地址是**配对那一刻**写死的，宿主换网后就死，而手机没有任何重新
 * 发现的手段（爸 2026-09-16 真机：主地址失效 + 备用 .local 在热点下解析不了 ⇒ 两条路一起死，
 * 只能删 app 重装）。握手一定会发生，把宿主当前地址捎回来，就等于每次连上都自愈一次。
 *
 * 宿主已经过 Noise + hostKey 校验，但地址仍然过 validateLanEndpoint：形状不对就退回这次
 * 拨通的那个——**此刻通着的地址永远比一个校验不过的新地址可信**，不能因为对面报了个坏值
 * 就把手里唯一能用的地址丢掉。
 *
 * 模块级函数，**不导出**：导出只是为了让测试够得着，而生产侧没有第二个消费方 ⇒ knip 生产档
 * 判它是新增 dead export，CI 红（2026-09-16 实付）。承重判据改从**真实路径**打：集成测试里
 * 把宿主的 reachedEndpoint 换成恶意值，看手机认不认——那比单测这个函数更接近真机。
 */
function adoptEndpoint(reported: unknown, dialed: string): string {
  if (typeof reported !== 'string' || !reported) return dialed;
  try { return validateLanEndpoint(reported); } catch { return dialed; }
}

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
   * 宿主给一串地址：字面量主地址（此刻一定连得上）、多网卡时的其余字面量候选（candidates）、
   * mDNS 名（换网后仍有效）。按「endpoint → 其余字面量候选（去重、保序）→ altEndpoint」试，
   * 记住连通的那个——它们指向同一台宿主，hostKey 校验对每个一视同仁。
   * `.local` 永远排最后：字面量拨一下立刻知道死活，mDNS 名在热点下解析要好几秒还多半不通
   * （2026-09-12 真机），排前面只会白烧超时。
   * 全部失败时抛**第一个**错误：主地址的失败原因才是用户要看的那句。
   *
   * 只有「没连上」才换地址。握手本身谈崩了（主机身份不对、绑定变了、会话被调用方换掉）
   * 说明我们**已经**够到了宿主，换个地址还是同一台机器、同样谈崩，
   * 白白烧掉一次性邀请，还会把真正的失败原因替换成第二次的。
   */
  private static readonly FATAL = new Set([
    'COMPANION_CHANNEL_CHANGED', 'COMPANION_HOST_KEY_MISMATCH',
    'COMPANION_BINDING_CHANGED', 'COMPANION_INVALID_BINDING', 'COMPANION_INVALID_FRAME',
  ]);
  private async overAddresses<T>(target: { endpoint: string; altEndpoint?: string; candidates?: string[] },
    attempt: (endpoint: string, alternate?: string) => Promise<T>): Promise<T> {
    const addresses = [...new Set([target.endpoint, ...(target.candidates ?? []), target.altEndpoint]
      .filter((value): value is string => Boolean(value)))];
    let firstError: unknown;
    for (const endpoint of addresses) {
      // 绑定的备用位优先给 mDNS 名：换网后仍解析得到的那条路不能从绑定里消失（PR#1904 同款
      // 纪律）；没有它才轮到其余字面量。旧邀请只有两个地址时与原行为逐字等价。
      const others = addresses.filter(other => other !== endpoint);
      const alternate = (target.altEndpoint && target.altEndpoint !== endpoint ? target.altEndpoint : undefined)
        ?? others[0];
      try { return await attempt(endpoint, alternate); }
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

  async recover(target: { endpoint: string; altEndpoint?: string; candidates?: string[]; hostKey: string }, binding?: LanBinding): Promise<LanBinding> {
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
    // 只采纳主地址。altEndpoint 由这一侧维护，宿主不该覆盖它。
    //
    // 采纳了新主地址时，**被挤下主位的正是刚刚拨通的那个**，它必须落到备用位——否则会丢掉
    // 唯一换网还能用的候选（grok ai-review PR#1904 Important）：主地址死掉、经 `.local` 备用
    // 拨通的那一轮，若把宿主报的字面量写进主位而备用位仍留着那个死字面量，`.local` 就从绑定里
    // 整个消失；宿主再换一次网，两个字面量一起死，手机又回到只能重新扫码。
    // 没采纳（宿主没报或报了坏值）时主位没动，备用位照旧。
    const live = adoptEndpoint(v.endpoint, endpoint);
    const fallback = live === endpoint ? altEndpoint : endpoint;
    const transcription = v.transcription;
    const dictationTranscription = v.dictationTranscription;
    return { version: 1, endpoint: live, ...(fallback ? { altEndpoint: fallback } : {}), hostKey,
      deviceId: v.deviceId, scopeEpoch: Number(v.scopeEpoch), scope: v.scope,
      // 电脑账号邮箱（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）：每次 welcome 现带，宿主没登录就缺席。
      ...(typeof v.hostAccountEmail === 'string' && v.hostAccountEmail.trim() && v.hostAccountEmail.length <= L.accountEmailMaxLength
        ? { hostAccountEmail: v.hostAccountEmail } : {}),
      ...(v.dictation === true ? { dictation: true as const } : {}),
      ...(transcription === 'ready' || transcription === 'not-installed' || transcription === 'no-key' ? { transcription } : {}),
      ...(v.dictation === true && (dictationTranscription === 'ready' || dictationTranscription === 'not-installed' || dictationTranscription === 'no-key')
        ? { dictationTranscription } : {}),
      ...(v.sessionlessTranscribe === true ? { sessionlessTranscribe: true as const } : {}) };
  }
}
