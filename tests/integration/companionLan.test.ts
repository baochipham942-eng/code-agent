import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});
import Database from 'better-sqlite3';
import { networkInterfaces } from 'node:os';
import { LanCompanionManager } from '../../src/host/companion/LanCompanionManager';
import { CompanionGateway } from '../../src/host/companion/CompanionGateway';
import { LanCompanionServer } from '../../src/host/companion/LanCompanionServer';
import { createHandshake, createIdentity, NoiseChannel } from '../../src/shared/companion/noiseChannel';
import { fromHex, toHex, isPrivateIPv4, parseInvitation, validateLanEndpoint, type LanBinding } from '../../src/shared/companion/lanProtocol';
import { LanCompanionClient, type LanPost } from '../../packages/mobile/src/platform/lanCompanionClient';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { createCompanionStore } from '../../packages/mobile/src/stores/companionStore';
import vector from '../fixtures/companion/lan-noise-vector.json';

describe('LAN companion: real HTTP + Noise + SQLite', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let server: LanCompanionServer;
  let client: LanCompanionClient;
  let now: number;
  let executions: number;
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();
  const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && isPrivateIPv4(n.address))?.address;
  const captures: string[] = [];
  const post: LanPost = async (url, body) => {
    captures.push(JSON.stringify(body));
    const res = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await res.text(); captures.push(raw);
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return JSON.parse(raw);
  };
  beforeEach(async () => {
    if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
    now = Date.now(); executions = 0; captures.length = 0;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { now: () => now, dispatch: () => { executions++; return { state: 'accepted', result: { runId: 'test-run' } }; } });
    server = new LanCompanionServer(gateway, hostIdentity, () => now);
    await server.start(address, 0);
    client = new LanCompanionClient(phoneIdentity, post);
  });
  afterEach(async () => { client?.close(); await server?.stop(); db?.close(); });
  const command = (binding: LanBinding, id = 'once', sessionId = 'shared') => ({ version: 1, deviceId: binding.deviceId,
    commandId: id, scopeEpoch: binding.scopeEpoch, sessionId, action: 'message.send', payload: { text: 'private-lan-message-正文' } });
  async function pair() { return client.pair(JSON.stringify(server.invite(['shared']))); }

  it('pairs, delivers a command and receives scoped events without plaintext on the wire', async () => {
    const binding = await pair();
    expect(await client.request({ action: 'command', command: command(binding) })).toMatchObject({ kind: 'accepted', command: { state: 'accepted' } });
    gateway.publish('hidden', 'message', { content: 'other-session-private' });
    gateway.publish('shared', 'message', { content: 'private-response-正文' });
    expect(await client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq: 0 })).toMatchObject({ nextSeq: 2, events: [{ payload: { content: 'private-response-正文' } }] });
    expect(executions).toBe(1);
    expect(captures.join('\n')).not.toContain('private-lan-message');
    expect(captures.join('\n')).not.toContain('private-response');
    expect(captures.join('\n')).not.toContain('other-session-private');
  });
  it('consumes the QR once and cannot pair a second phone with it', async () => {
    const invitation = JSON.stringify(server.invite(['shared']));
    await client.pair(invitation);
    const other = new LanCompanionClient(createIdentity(), post);
    await expect(other.pair(invitation)).rejects.toThrow('HTTP_403');
    expect(gateway.pairedDevices()).toHaveLength(1);
  });
  it('rejects an expired invitation at the host even if the client clock is behind', async () => {
    const invitation = JSON.stringify(server.invite(['shared'])); now += L.invitationTtlMs;
    await expect(client.pair(invitation)).rejects.toThrow('HTTP_403');
    expect(gateway.pairedDevices()).toHaveLength(0);
  });
  it('rejects a wrong PSK and does not consume the legitimate invitation', async () => {
    const invitation = server.invite(['shared']);
    await expect(client.pair(JSON.stringify({ ...invitation, psk: '00'.repeat(32) }))).rejects.toThrow('HTTP_403');
    await expect(client.pair(JSON.stringify(invitation))).resolves.toMatchObject({ scope: ['shared'] });
  });
  it('pins the host key before completing pairing', async () => {
    const invitation = server.invite(['shared']);
    await expect(client.pair(JSON.stringify({ ...invitation, hostKey: toHex(createIdentity().publicKey) }))).rejects.toThrow('HOST_KEY_MISMATCH');
    expect(gateway.pairedDevices()).toHaveLength(0);
  });
  it('rejects replacement invites and cancels half-open handshakes', async () => {
    const invitation = server.invite(['shared']);
    const noise = createHandshake(true, phoneIdentity, invitation.inviteId, invitation.psk);
    const hello = await post(`${invitation.endpoint}/v1/hello`, { mode: 'pair', inviteId: invitation.inviteId, frame: toHex(noise.send()) }) as { channelId: string; frame: string };
    noise.recv(fromHex(hello.frame));
    server.invite(['different']);
    await expect(post(`${invitation.endpoint}/v1/finish`, { channelId: hello.channelId, frame: toHex(noise.send()) })).rejects.toThrow('HTTP_403');
    expect(gateway.pairedDevices()).toHaveLength(0);
  });
  it('reconnects with device identity and preserves command idempotency', async () => {
    const binding = await pair();
    await client.request({ action: 'command', command: command(binding) });
    await client.resume(binding);
    expect(await client.request({ action: 'command', command: command(binding) })).toMatchObject({ kind: 'replayed' });
    expect(executions).toBe(1);
  });
  it('rejects a different phone using copied nonsecret binding metadata', async () => {
    const binding = await pair();
    await expect(new LanCompanionClient(createIdentity(), post).resume(binding)).rejects.toThrow('HTTP_403');
  });
  it('reconciles a lost encrypted receipt after a fresh handshake without redispatch', async () => {
    const binding = await pair();
    let drop = true;
    const lossy = new LanCompanionClient(phoneIdentity, async (url, body) => {
      const result = await post(url, body);
      if (url.endsWith('/exchange') && drop) { drop = false; throw new Error('RECEIPT_LOST'); }
      return result;
    });
    await lossy.resume(binding);
    await expect(lossy.request({ action: 'command', command: command(binding) })).rejects.toThrow('RECEIPT_LOST');
    await lossy.resume(binding);
    expect(await lossy.request({ action: 'status', commandId: 'once' })).toMatchObject({ commandId: 'once', state: 'accepted' });
    expect(await lossy.request({ action: 'command', command: command(binding) })).toMatchObject({ kind: 'replayed' });
    expect(executions).toBe(1); lossy.close();
  });
  it('revocation invalidates an existing channel and prevents reconnect', async () => {
    const binding = await pair(); server.revoke(binding.deviceId);
    await expect(client.request({ action: 'status', commandId: 'once' })).rejects.toThrow('HTTP_403');
    await expect(client.resume(binding)).rejects.toThrow('HTTP_403');
    expect(executions).toBe(0);
  });
  it('rejects cross-session actions and cross-device body substitution', async () => {
    const binding = await pair();
    expect(await client.request({ action: 'command', command: command(binding, 'bad', 'hidden') })).toMatchObject({ kind: 'rejected', reason: 'scope_denied' });
    await expect(client.request({ action: 'command', command: { ...command(binding), deviceId: 'someone-else' } })).rejects.toThrow('HTTP_403');
    expect(executions).toBe(0);
  });
  it('cannot reach desktop APIs or arbitrary IPC through the LAN listener', async () => {
    const binding = await pair();
    const res = await fetch(`${binding.endpoint}/api/sessions`); expect(res.status).toBe(403);
    await expect(client.request({ action: 'ipc', channel: 'shell:execute' })).rejects.toThrow('HTTP_403');
  });
  it('rejects hostile browser origins before handshake processing', async () => {
    const invitation = server.invite(['shared']);
    const res = await fetch(`${invitation.endpoint}/v1/hello`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://hostile.example' }, body: '{}' });
    expect(res.status).toBe(403);
  });
  it('expires a channel and serializes concurrent RPC calls', async () => {
    const binding = await pair();
    const replies = await Promise.all(['first', 'second'].map(id => client.request({ action: 'command', command: command(binding, id) })));
    expect(replies).toHaveLength(2); expect(executions).toBe(2);
    now += L.channelTtlMs;
    await expect(client.request({ action: 'status', commandId: 'first' })).rejects.toThrow('HTTP_403');
    await client.resume(binding);
  });
  it('retains a phone identity before pairing and recovers a lost pairing receipt', async () => {
    const raw = JSON.stringify(server.invite(['shared']));
    let storage: string | null = null;
    let lose = true;
    const port = {
      read: async () => storage,
      write: async (value: string) => { storage = value; }, scan: async () => raw,
      post: async (url: string, body: unknown) => {
        expect(storage).not.toBeNull();
        const result = await post(url, body);
        if (url.endsWith('/finish') && lose) { lose = false; throw new Error('PAIRING_RECEIPT_LOST'); }
        return result;
      },
    };
    const first = createCompanionStore(port, () => {});
    await first.getState().pair(); expect(first.getState().status).toBe('offline');
    const restarted = createCompanionStore(port, () => {});
    await restarted.getState().hydrate();
    expect(restarted.getState().status).toBe('connected'); expect(gateway.pairedDevices()).toHaveLength(1);
    restarted.getState().pause();
  });
  it('phone storage failure prevents dispatch and keeps the draft', async () => {
    let storage: string | null = null; let fail = false; let cleared = false;
    const phone = createCompanionStore({ read: async () => storage,
      write: async value => { if (fail) throw new Error('STORAGE_FULL'); storage = value; },
      scan: async () => JSON.stringify(server.invite(['shared'])), post,
    }, () => { cleared = true; });
    await phone.getState().pair(); fail = true;
    await phone.getState().send('draft must stay');
    expect(phone.getState().status).toBe('storageError'); expect(executions).toBe(0); expect(cleared).toBe(false);
  });
  it('phone restart reconciles a pending command using the same persisted ID', async () => {
    let storage: string | null = null; let lose = true; let cleared = '';
    const port = { read: async () => storage, write: async (value: string) => { storage = value; },
      scan: async () => JSON.stringify(server.invite(['shared'])),
      post: async (url: string, body: unknown) => {
        const result = await post(url, body);
        if (url.endsWith('/exchange') && lose) { lose = false; throw new Error('RECEIPT_LOST'); }
        return result;
      },
    };
    const phone = createCompanionStore(port, text => { cleared = text; });
    await phone.getState().pair(); await phone.getState().send('persist before dispatch');
    expect(phone.getState().pending).toBe(true); expect(cleared).toBe('');
    const restarted = createCompanionStore(port, text => { cleared = text; });
    await restarted.getState().hydrate();
    expect(restarted.getState().pending).toBe(false); expect(cleared).toBe('persist before dispatch'); expect(executions).toBe(1);
    restarted.getState().pause();
  });
  it('transports long Unicode messages across multiple authenticated records', async () => {
    const binding = await pair();
    const long = { ...command(binding), payload: { text: '你'.repeat(30_000) } };
    expect(await client.request({ action: 'command', command: long })).toMatchObject({ kind: 'accepted' });
    expect(executions).toBe(1);
  });
  it.each([
    ['invalid QR', 'not-json', undefined, 'connectionQrInvalid'],
    ['expired QR', 'expired', undefined, 'connectionQrInvalid'],
    ['network failure', 'valid', 'COMPANION_NETWORK_UNAVAILABLE', 'connectionUnavailable'],
    ['host rejection', 'valid', 'COMPANION_PAIRING_REJECTED', 'connectionRejected'],
  ])('reports actionable %s without accepting work or revealing raw errors', async (_name, qr, failure, expected) => {
    const invitation = server.invite(['shared']);
    const send = vi.fn(async () => { throw new Error(failure); });
    const phone = createCompanionStore({ read: async () => null, write: async () => {},
      scan: async () => qr === 'not-json' ? qr : JSON.stringify({ ...invitation, ...(qr === 'expired' ? { expiresAt: 1 } : {}) }),
      post: send }, () => {});
    await phone.getState().pair();
    expect(phone.getState()).toMatchObject({ status: 'offline', connectionError: expected, pending: false });
    if (!failure) expect(send).not.toHaveBeenCalled();
    expect(executions).toBe(0);
  });
  it('does not resurrect a connection when pairing completes after the phone closes it', async () => {
    const closing = new LanCompanionClient(phoneIdentity, async (url, body) => {
      const result = await post(url, body);
      if (url.endsWith('/finish')) closing.close();
      return result;
    });
    await expect(closing.pair(JSON.stringify(server.invite(['shared'])))).rejects.toThrow('CHANNEL_CHANGED');
    await expect(closing.request({ action: 'sync', epoch: 1, afterSeq: 0 })).rejects.toThrow('NOT_CONNECTED');
  });
});

describe('LAN protocol validation', () => {
  it.each(['IK', 'XXpsk0'])('matches fixed %s handshake vectors and directional keys with the pure JS backend', pattern => {
    const keys = vector.keys.map(k => ({ publicKey: fromHex(k.publicKey), secretKey: fromHex(k.secretKey) }));
    const pairing = pattern === 'XXpsk0' ? vector.pairing : undefined;
    const expected = pairing ?? vector;
    const a = createHandshake(true, keys[0], pairing?.inviteId, pairing?.psk, pairing ? undefined : vector.keys[1].publicKey);
    const b = createHandshake(false, keys[1], pairing?.inviteId, pairing?.psk);
    a.e = keys[2]; b.e = keys[3];
    const first = a.send(); expect(toHex(first)).toBe(expected.frames[0]); b.recv(first);
    const second = b.send(); expect(toHex(second)).toBe(expected.frames[1]); a.recv(second);
    if (pairing) { const third = a.send(); expect(toHex(third)).toBe(pairing.frames[2]); b.recv(third); }
    expect(toHex(a.tx)).toBe(expected.initiatorTx); expect(toHex(b.rx)).toBe(expected.initiatorTx);
    expect(toHex(b.tx)).toBe(expected.responderTx); expect(toHex(a.rx)).toBe(expected.responderTx);
  });
  it.each(['truncate', 'reorder', 'tamper'])('rejects %s of a segmented encrypted message', mutation => {
    const host = createIdentity(); const a = createHandshake(true, createIdentity(), undefined, undefined, toHex(host.publicKey));
    const b = createHandshake(false, host); b.recv(a.send()); a.recv(b.send());
    const tx = new NoiseChannel(a); const rx = new NoiseChannel(b);
    const records = tx.seal({ content: '界'.repeat(30_000) });
    expect(records.length).toBeGreaterThan(1);
    if (mutation === 'truncate') records.pop();
    if (mutation === 'reorder') records.reverse();
    if (mutation === 'tamper') records[0] = (records[0].startsWith('00') ? '01' : '00') + records[0].slice(2);
    expect(() => rx.open(records)).toThrow();
    expect(() => rx.open(tx.seal({ content: 'next' }))).toThrow();
    tx.close();
  });
  it('retires a channel at the record budget before the upstream 32-bit nonce can wrap', () => {
    const host = createIdentity(); const a = createHandshake(true, createIdentity(), undefined, undefined, toHex(host.publicKey));
    const b = createHandshake(false, host); b.recv(a.send()); a.recv(b.send());
    const tx = new NoiseChannel(a);
    for (let i = 0; i < L.maxFrames; i++) tx.seal({ i });
    expect(() => tx.seal({ i: L.maxFrames })).toThrow('CHANNEL_LIMIT');
    expect(() => tx.seal({ i: 0 })).toThrow('CHANNEL_LIMIT');
  });
  it.each(['http://127.0.0.1:8181', 'http://169.254.169.254:80', 'http://example.com:8181', 'http://192.168.1.2:8181/path', 'http://user@192.168.1.2:8181', 'https://192.168.1.2:8181', 'http://192.168.1.2:8181#token'])('rejects invitation endpoint %s', endpoint => {
    expect(() => validateLanEndpoint(endpoint)).toThrow();
  });
  it('accepts only canonical RFC1918 endpoints and an unexpired well-formed QR', () => {
    expect(validateLanEndpoint('http://192.168.1.2:8181')).toBe('http://192.168.1.2:8181');
    expect(isPrivateIPv4('172.31.1.1')).toBe(true); expect(isPrivateIPv4('172.32.1.1')).toBe(false);
    expect(() => parseInvitation('{}')).toThrow();
  });
  it('retires a channel on replay and cannot resume using the next valid record', () => {
    // A separate matching IK exchange exercises the real cipher, not a mock decryptor.
    const host = createIdentity(); const initiator = createHandshake(true, createIdentity(), undefined, undefined, toHex(host.publicKey));
    const responder = createHandshake(false, host);
    responder.recv(initiator.send()); initiator.recv(responder.send());
    const tx = new NoiseChannel(initiator); const rx = new NoiseChannel(responder);
    const record = tx.seal({ content: 'first' }); expect(rx.open(record)).toEqual({ content: 'first' });
    expect(() => rx.open(record)).toThrow();
    expect(() => rx.open(tx.seal({ content: 'second' }))).toThrow();
    tx.close();
  });
});


describe('LAN manager network changes (mocked network and listener)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  function setup() {
    const interfaces = vi.mocked(networkInterfaces);
    const setAddresses = (...addresses: string[]) => interfaces.mockReturnValue({ en0: addresses.map(address => ({
      address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`,
    })) });
    const start = vi.spyOn(LanCompanionServer.prototype, 'start').mockResolvedValue();
    const stop = vi.spyOn(LanCompanionServer.prototype, 'stop').mockResolvedValue();
    vi.spyOn(LanCompanionServer.prototype, 'invite').mockReturnValue({ version: 1, endpoint: 'http://192.168.1.2:8181',
      inviteId: 'fixture', psk: '00'.repeat(32), hostKey: '00'.repeat(32), expiresAt: Date.now() + L.invitationTtlMs });
    const db = new Database(':memory:');
    const gateway = new CompanionGateway(db, { dispatch: () => ({ state: 'accepted' }) });
    const manager = new LanCompanionManager(gateway, async () => createIdentity(), async () => [{ id: 'shared', title: 'Shared' }]);
    return { setAddresses, start, stop, db, manager, invite: () => manager.manage({ action: 'invite', scope: ['shared'] }) };
  }
  it('rebinds when the paired interface disappears and serializes concurrent invitations', async () => {
    const t = setup();
    try {
      t.setAddresses('172.20.10.6'); await t.invite();
      t.setAddresses('192.168.1.2'); await Promise.all([t.invite(), t.invite()]);
      expect(t.start.mock.calls).toEqual([['172.20.10.6'], ['192.168.1.2']]);
      expect(t.stop).toHaveBeenCalledTimes(1);
      expect(t.stop.mock.invocationCallOrder[0]).toBeLessThan(t.start.mock.invocationCallOrder[1]);
    } finally { await t.manager.stop(); t.db.close(); }
  });
  it('keeps a still available interface even when network enumeration changes order', async () => {
    const t = setup();
    try {
      t.setAddresses('192.168.1.2'); await t.invite();
      t.setAddresses('10.1.1.2', '192.168.1.2'); await t.invite();
      expect(t.start).toHaveBeenCalledTimes(1); expect(t.stop).not.toHaveBeenCalled();
    } finally { await t.manager.stop(); t.db.close(); }
  });
  it('stops the stale listener and refuses invitations without a private interface, then recovers', async () => {
    const t = setup();
    try {
      t.setAddresses('192.168.1.2'); await t.invite();
      t.setAddresses('203.0.113.4'); await expect(t.invite()).rejects.toThrow('COMPANION_LAN_UNAVAILABLE');
      expect(t.stop).toHaveBeenCalledTimes(1); expect(t.start).toHaveBeenCalledTimes(1);
      t.setAddresses('10.1.1.2'); await t.invite();
      expect(t.start).toHaveBeenLastCalledWith('10.1.1.2');
    } finally { await t.manager.stop(); t.db.close(); }
  });
});
