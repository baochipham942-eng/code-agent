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
