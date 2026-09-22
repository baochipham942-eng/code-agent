import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient } from '../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { toHex } from '../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { FakeCompanionRelay } from './companion/fakeCompanionRelay';
import { RelayPhoneStub } from './companion/relayPhoneStub';

const SECRET = 'test-relay-credential';
const TOKEN = 'route-token-aaaaaa';

describe('companion relay: loopback fake relay + host dial-out', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let relay: FakeCompanionRelay;
  let host: CompanionRelayClient;
  let phone: RelayPhoneStub;
  let executions: number;
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();

  beforeEach(async () => {
    executions = 0;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      dispatch: () => { executions += 1; return { state: 'accepted', result: { runId: 'test-run' } }; },
    });
    const device = gateway.pairIdentity(toHex(phoneIdentity.publicKey), ['shared']);
    relay = new FakeCompanionRelay(SECRET);
    const url = await relay.listen();
    host = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    host.advertise({ deviceRef: device.deviceId, routeToken: TOKEN });
    await host.start();
    phone = new RelayPhoneStub(phoneIdentity, TOKEN, device.deviceId);
    await phone.connect(url, SECRET);
  });

  afterEach(async () => {
    phone?.close();
    await host?.stop();
    await relay?.stop();
    db?.close();
  });

  function command(deviceId: string, commandId: string, text: string) {
    return {
      version: 1, deviceId, commandId, scopeEpoch: 1, sessionId: 'shared',
      action: 'message.send' as const, payload: { text },
    };
  }

  async function pair() {
    return phone.resume(toHex(hostIdentity.publicKey), relay.url);
  }

  it('delivers an encrypted command round-trip without plaintext on the relay', async () => {
    const binding = await pair();
    const text = 'private-relay-message-正文';
    expect(await phone.request({ action: 'command', command: command(binding.deviceId, 'once', text) }))
      .toMatchObject({ kind: 'accepted', command: { state: 'accepted' } });
    expect(executions).toBe(1);
    const wire = relay.captures.join('\n');
    expect(wire).not.toContain(text);
    expect(wire).not.toContain('message.send');
    expect(JSON.parse(relay.captures[0] as string).kind).toBe('register');
  });

  it('does not re-execute after a relay restart when the commandId survives the hop', async () => {
    const binding = await pair();
    const cmd = command(binding.deviceId, 'once', 'private-relay-message-正文');
    expect(await phone.request({ action: 'command', command: cmd })).toMatchObject({ kind: 'accepted' });
    phone.close();
    await relay.restart();
    await host.whenConnected();
    phone = new RelayPhoneStub(phoneIdentity, TOKEN, binding.deviceId);
    await phone.connect(relay.url, SECRET);
    await phone.resume(toHex(hostIdentity.publicKey), relay.url);
    expect(await phone.request({ action: 'command', command: cmd })).toMatchObject({ kind: 'replayed' });
    expect(executions).toBe(1);
  });

  it('reorders frames into seq order and does not skip a dropped seq', async () => {
    const binding = await pair();
    const cmd = (id: string) => ({ action: 'command', command: command(binding.deviceId, id, `text-${id}`) });
    relay.holdKeys.add('device:1');
    const reordered = phone.burst([cmd('a'), cmd('b'), cmd('c')]);
    await vi.waitFor(() => expect(executions).toBe(1));
    relay.holdKeys.delete('device:1');
    relay.releaseHeld();
    const results = await reordered;
    expect(results.map(item => (item as { command: { commandId: string } }).command.commandId)).toEqual(['a', 'b', 'c']);
    expect(executions).toBe(3);

    relay.dropKeys.add('device:4');
    void phone.burst([cmd('d'), cmd('e'), cmd('f')]).catch(() => {});
    await vi.waitFor(() => expect(executions).toBe(4));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(executions).toBe(4);
  });

  it('disconnects the device side when the host revokes', async () => {
    const binding = await pair();
    expect(relay.deviceOpen(TOKEN)).toBe(true);
    gateway.revokeDevice(binding.deviceId);
    host.revoke(binding.deviceId);
    await vi.waitFor(() => {
      expect(relay.deviceOpen(TOKEN)).toBe(false);
      expect(phone.connected).toBe(false);
    });
    await expect(phone.request({ action: 'command', command: command(binding.deviceId, 'after-revoke', 'nope') }))
      .rejects.toThrow();
    expect(executions).toBe(0);
  });

  it('registers already-paired devices on dial-out without a prior advertise', async () => {
    await host.stop();
    const paired = gateway.pairedDevices()[0];
    if (!paired) throw new Error('expected a paired device');
    const client = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url: relay.url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    await client.start();
    expect(client.routeTokenFor(paired.deviceId)).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    await vi.waitFor(() => expect(relay.routeCount).toBeGreaterThan(0));
    await client.stop();
  });

  it('does not queue without bound while disconnected', async () => {
    const oversized = {
      v: 1 as const, kind: 'forward' as const,
      envelope: {
        routeToken: TOKEN, deviceRef: 'phone-1', seq: 0,
        ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now(),
      },
      ciphertext: randomBytes(32).toString('hex'),
    };
    await host.stop();
    let queued = 0;
    for (let index = 0; index < L.relayMaxBufferedFrames + 4; index += 1) {
      if (host.enqueueWhileDisconnected({ ...oversized, envelope: { ...oversized.envelope, seq: index } }) === 'queued') queued += 1;
    }
    expect(queued).toBe(L.relayMaxBufferedFrames);
    expect(host.droppedCount).toBe(4);
    expect(host.bufferedCount).toBe(L.relayMaxBufferedFrames);
  });

  it('does not report connected until the dial survives the stability window (settings-page criterion)', async () => {
    // beforeEach 里 start() 已 open（whenConnected 立即返回）；relay 拒证也是 open 后立刻关，
    // 所以设置页读的 connected 在稳定期内必须是 false，撑过 L.relayStableConnectionMs 才翻 true。
    await host.whenConnected();
    expect(host.connected).toBe(false);
    await vi.waitFor(() => expect(host.connected).toBe(true), { timeout: L.relayStableConnectionMs + 3_000 });
  });
});
