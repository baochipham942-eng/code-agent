import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { networkInterfaces } from 'node:os';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { LanCompanionServer } from '../../src/host/services/companion/LanCompanionServer';
import { createHandshake, createIdentity, NoiseChannel } from '../../src/shared/companion/noiseChannel';
import { fromHex, toHex, isPrivateIPv4 } from '../../src/shared/companion/lanProtocol';
import type { CompanionRelayLogger } from '../../src/host/services/companion/companionRelayConfig';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';

/**
 * LAN 连接层留痕（N-MOBILE-SEND-RESULT-LOST）：真机现场「宿主日志无任何连接/通道记录」，
 * 断链四个候选断点里三个落在 LanCompanionServer——exchange 出错关整条 channel（A）、
 * TTL 到期被 prune 收掉（B）、身份失效留墓碑。这里用真 HTTP + 真 Noise 握手驱动，
 * fake logger 收集行、按 reason 码断言（照 companionRelayCloseDiag 的范式）。
 */

describe('LAN companion connection diagnostics', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let server: LanCompanionServer;
  let now: number;
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();
  const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && isPrivateIPv4(n.address))?.address;
  let info: string[];
  let warn: string[];

  const post = async (url: string, body: unknown): Promise<{ ok: boolean; status: number; body: any }> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, body: raw ? JSON.parse(raw) : null };
  };

  beforeEach(async () => {
    if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
    now = Date.now(); info = []; warn = [];
    const logger: CompanionRelayLogger = { info: message => info.push(message), warn: message => warn.push(message) };
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { now: () => now });
    server = new LanCompanionServer(gateway, hostIdentity, () => now, undefined, undefined, logger);
    await server.start(address, 0);
  });
  afterEach(async () => { await server?.stop(); db?.close(); });

  /** 与手机 pairAt 同序的配对：hello(pair) → finish，返回可用的加密通道。 */
  async function pairChannel(): Promise<{ channelId: string; channel: NoiseChannel; endpoint: string; deviceId: string }> {
    const invitation = server.invite(['shared']);
    const noise = createHandshake(true, phoneIdentity, invitation.inviteId, invitation.psk);
    const hello = await post(`${invitation.endpoint}/v1/hello`, { mode: 'pair', inviteId: invitation.inviteId, frame: toHex(noise.send()) });
    if (!hello.ok) throw new Error(`hello_${hello.status}`);
    if (noise.recv(fromHex(hello.body.frame)).length !== 0 || !noise.rs) throw new Error('handshake_recv_failed');
    const finishFrame = toHex(noise.send());
    const channel = new NoiseChannel(noise);
    const finish = await post(`${invitation.endpoint}/v1/finish`, { channelId: hello.body.channelId, frame: finishFrame });
    if (!finish.ok) throw new Error(`finish_${finish.status}`);
    const binding = channel.open(finish.body.welcome) as { deviceId: string };
    return { channelId: hello.body.channelId, channel, endpoint: invitation.endpoint, deviceId: binding.deviceId };
  }

  const exchange = async (c: { channelId: string; channel: NoiseChannel; endpoint: string }, payload: Record<string, unknown>) => {
    const requestId = 'req-diag-0001';
    const res = await post(`${c.endpoint}/v1/exchange`, { channelId: c.channelId, frame: c.channel.seal({ ...payload, requestId }) });
    if (!res.ok) throw new Error(`exchange_${res.status}`);
    const body = c.channel.open(res.body.frame) as { requestId: string; result: unknown };
    expect(body.requestId).toBe(requestId);
    return body.result;
  };

  it('logs pair/finish handshake success with channel prefix and device', async () => {
    const { channelId, deviceId } = await pairChannel();
    const pairLine = info.find(line => line.includes('mode=pair'));
    expect(pairLine).toContain(`channel=${channelId.slice(0, 8)}`);
    const finishLine = info.find(line => line.includes('mode=finish'));
    expect(finishLine).toContain(`channel=${channelId.slice(0, 8)}`);
    expect(finishLine).toContain(`device=${deviceId}`);
  });

  it('closes the channel and logs the error code when an exchange throws (A 断点判据)', async () => {
    const c = await pairChannel();
    const res = await post(`${c.endpoint}/v1/exchange`, { channelId: c.channelId, frame: 'not-an-array' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'COMPANION_CHANNEL_CLOSED' });
    expect(warn).toContain(`Companion LAN channel closed: reason=exchange_error channel=${c.channelId.slice(0, 8)} device=${c.deviceId} error=COMPANION_INVALID_FRAME`);
    // channel 真被关了：同一通道的下一拍只剩笼统 CHANNEL_CLOSED，且不再叠加 exchange_error 行。
    await expect(exchange(c, { action: 'sync', epoch: 1, afterSeq: 0 })).rejects.toThrow('exchange_403');
    expect(warn.filter(line => line.includes('reason=exchange_error'))).toHaveLength(1);
  });

  it('logs ttl_expired when the channel outlives its TTL before the next exchange (B 断点判据)', async () => {
    const c = await pairChannel();
    now += L.channelTtlMs + 1;
    const res = await post(`${c.endpoint}/v1/exchange`, { channelId: c.channelId, frame: c.channel.seal({ requestId: 'req-ttl-00001', action: 'sync', epoch: 1, afterSeq: 0 }) });
    expect(res.status).toBe(403);
    expect(info).toContain(`Companion LAN channel closed: reason=ttl_expired channel=${c.channelId.slice(0, 8)} device=${c.deviceId}`);
  });

  it('logs the identity_invalid tombstone when the paired device is revoked', async () => {
    const c = await pairChannel();
    server.revoke(c.deviceId);
    expect(warn).toContain(`Companion LAN channel closed: reason=identity_invalid channel=${c.channelId.slice(0, 8)} key=${toHex(phoneIdentity.publicKey).slice(0, 8)}`);
  });

  it('logs handshake rejections with mode and code', async () => {
    const endpoint = server.invite(['shared']).endpoint;
    const res = await post(`${endpoint}/v1/hello`, { mode: 'pair', inviteId: 'stale-invite-id', frame: '00' });
    expect(res.status).toBe(403);
    expect(warn.some(line => line.startsWith('Companion LAN handshake rejected: mode=pair') && line.includes('code=COMPANION_INVITATION_EXPIRED'))).toBe(true);
  });

  it('logs only the first sync beat per channel, not every poll', async () => {
    const c = await pairChannel();
    await exchange(c, { action: 'sync', epoch: 1, afterSeq: 0 });
    await exchange(c, { action: 'sync', epoch: 1, afterSeq: 0 });
    expect(info.filter(line => line.includes('action=sync'))).toEqual([
      `Companion LAN exchange: action=sync channel=${c.channelId.slice(0, 8)} first=true`,
    ]);
  });

  it('warns when the phone polls a commandId the host does not know (pending 悬挂判据)', async () => {
    const c = await pairChannel();
    const result = await exchange(c, { action: 'status', commandId: 'ghost-cmd' });
    expect(result).toBeNull();
    expect(warn).toContain(`Companion LAN exchange anomaly: action=status channel=${c.channelId.slice(0, 8)} commandId=ghost-cmd result=unknown`);
  });
});
