import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHandshake, createIdentity, NoiseChannel } from '../../../src/shared/companion/noiseChannel';
import { fromHex, toHex } from '../../../src/shared/companion/lanProtocol';
import { LanCompanionClient, type LanPost } from '../../../packages/mobile/src/platform/lanCompanionClient';

/**
 * 走真实 Noise pair，welcome 里塞 transcription，断言 readBinding 的三态解析与非法值丢弃。
 * 监工删掉那一行 spread 时，本文件必须红。
 */
function pairWith(transcription: unknown) {
  const host = createIdentity();
  const phone = createIdentity();
  const inviteId = randomUUID();
  const psk = toHex(randomBytes(32));
  const hostKey = toHex(host.publicKey);
  const endpoint = 'http://192.168.1.2:8182';
  let pending: ReturnType<typeof createHandshake> | null = null;
  const post: LanPost = async (url, body) => {
    const req = body as { mode?: string; frame?: string };
    if (String(url).endsWith('/v1/hello')) {
      const noise = createHandshake(false, host, inviteId, psk);
      if (noise.recv(fromHex(req.frame)).length !== 0) throw new Error('COMPANION_INVALID_FRAME');
      pending = noise;
      return { channelId: randomUUID(), frame: toHex(noise.send()) };
    }
    if (String(url).endsWith('/v1/finish')) {
      if (!pending) throw new Error('COMPANION_HANDSHAKE_REJECTED');
      if (pending.recv(fromHex(req.frame)).length !== 0) throw new Error('COMPANION_INVALID_FRAME');
      const cipher = new NoiseChannel(pending);
      return {
        welcome: cipher.seal({
          deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'],
          transcription, sessionlessTranscribe: true,
        }),
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  const client = new LanCompanionClient(phone, post);
  return client.pair(JSON.stringify({
    version: 1, endpoint, inviteId, psk, hostKey, expiresAt: Date.now() + 60_000,
  }));
}

describe('LanCompanionClient 解析 transcription 三态', () => {
  it.each(['ready', 'not-installed', 'no-key'] as const)('收下 %s', async value => {
    const binding = await pairWith(value);
    expect(binding.transcription).toBe(value);
  });

  it.each(['maybe', 'READY', '', 1, null, { ready: true }, ['ready']])('丢弃非法值 %j', async value => {
    const binding = await pairWith(value);
    expect(binding.transcription).toBeUndefined();
  });
});

/**
 * 多网卡热点场景（N-COMPANION-MDNS-FALLBACK）：宿主邀请带一串私网字面量候选，
 * 手机按「endpoint → 其余字面量候选 → mDNS 名」的序试到能用的那个。
 * reachable 决定哪个地址「有人听」（可抛错扮演不同死法），只记 /v1/hello 的拨号序。
 */
function pairOver(invitation: Record<string, unknown>, reachable: (base: string) => boolean) {
  const host = createIdentity();
  const phone = createIdentity();
  const inviteId = randomUUID();
  const psk = toHex(randomBytes(32));
  const hostKey = toHex(host.publicKey);
  const attempts: string[] = [];
  let pending: ReturnType<typeof createHandshake> | null = null;
  const post: LanPost = async (url, body) => {
    const base = String(url).replace(/\/v1\/[a-z]+$/, '');
    const frame = (body as { frame?: string }).frame;
    if (String(url).endsWith('/v1/hello')) {
      attempts.push(base);
      if (!reachable(base)) throw new Error('ECONNREFUSED');
      const noise = createHandshake(false, host, inviteId, psk);
      if (noise.recv(fromHex(frame!)).length !== 0) throw new Error('COMPANION_INVALID_FRAME');
      pending = noise;
      return { channelId: randomUUID(), frame: toHex(noise.send()) };
    }
    if (String(url).endsWith('/v1/finish')) {
      if (!pending) throw new Error('COMPANION_HANDSHAKE_REJECTED');
      if (pending.recv(fromHex(frame!)).length !== 0) throw new Error('COMPANION_INVALID_FRAME');
      const cipher = new NoiseChannel(pending);
      return { welcome: cipher.seal({ deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const client = new LanCompanionClient(phone, post);
  return { client, attempts,
    pair: client.pair(JSON.stringify({ version: 1, endpoint: 'http://192.168.1.2:8182', inviteId, psk, hostKey,
      expiresAt: Date.now() + 60_000, ...invitation })) };
}

describe('LanCompanionClient 多网卡候选回落（candidates）', () => {
  const primary = 'http://192.168.1.2:8182';
  const hotspot = 'http://172.20.10.2:8182';
  const vpn = 'http://10.8.0.3:8182';
  const mdns = 'http://macbook.local:8182';

  it('按序试字面量候选，拨通第二个候选；mDNS 名没轮到且留在绑定备用位', async () => {
    const { attempts, pair } = pairOver({ candidates: [primary, hotspot, vpn], altEndpoint: mdns },
      base => base === vpn);
    const binding = await pair;
    expect(attempts).toEqual([primary, hotspot, vpn]);
    expect(binding.endpoint).toBe(vpn);
    expect(binding.altEndpoint).toBe(mdns);
  });

  it('字面量全死才轮到 mDNS 名；配对后备用位记第一个字面量', async () => {
    const { attempts, pair } = pairOver({ candidates: [primary, hotspot], altEndpoint: mdns },
      base => base === mdns);
    const binding = await pair;
    expect(attempts).toEqual([primary, hotspot, mdns]);
    expect(binding.endpoint).toBe(mdns);
    expect(binding.altEndpoint).toBe(primary);
  });

  it('握手谈崩（FATAL）不因候选变多而继续换地址', async () => {
    const wrongHostKey = toHex(createIdentity().publicKey);
    const { attempts, pair } = pairOver({ candidates: [primary, hotspot], hostKey: wrongHostKey },
      base => base === hotspot);
    await expect(pair).rejects.toThrow('COMPANION_HOST_KEY_MISMATCH');
    expect(attempts).toEqual([primary, hotspot]);
  });

  it('全部候选死透时抛第一个地址的错误', async () => {
    const { pair } = pairOver({ candidates: [primary, hotspot], altEndpoint: mdns }, base => {
      if (base === primary) return false; // 第一个：ECONNREFUSED
      throw new Error('ETIMEDOUT'); // 其余的死法不同，不许覆盖第一个错
    });
    await expect(pair).rejects.toThrow('ECONNREFUSED');
  });

  it('旧邀请（无 candidates）行为不变：endpoint → altEndpoint 两步', async () => {
    const { attempts, pair } = pairOver({ altEndpoint: mdns }, base => base === mdns);
    const binding = await pair;
    expect(attempts).toEqual([primary, mdns]);
    expect(binding.endpoint).toBe(mdns);
    expect(binding.altEndpoint).toBe(primary);
  });
});
