import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});
import Database from 'better-sqlite3';
import { hostname, networkInterfaces } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LanCompanionManager } from '../../src/host/services/companion/LanCompanionManager';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionFileService } from '../../src/host/services/companion/CompanionFileService';
import { FileCache } from '../../packages/mobile/src/platform/fileCache';
import { LanCompanionServer } from '../../src/host/services/companion/LanCompanionServer';
import { createHandshake, createIdentity, NoiseChannel } from '../../src/shared/companion/noiseChannel';
import { fromHex, toHex, isLanPeer, isPrivateIPv4, lanAdvertisedHost, parseInvitation, validateLanEndpoint, type LanBinding } from '../../src/shared/companion/lanProtocol';
import { LanCompanionClient, type LanPost } from '../../packages/mobile/src/platform/lanCompanionClient';
import { COMPANION_EVENT_DROPPED, COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { createCompanionStore } from '../../packages/mobile/src/stores/companionStore';
import type { CompanionSyncResult } from '../../src/shared/contract/companion';
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

  it('invites with the literal first and the mDNS name as the alternate', () => {
    // 2026-09-12 真机：只广告 mDNS 名时，Mac 连着 iPhone 热点的手机解析不了宿主的 .local，
    // 配对 100% 失败（app 报「无法连接电脑」，宿主端口上零 TCP，Safari 直连同样找不到服务器）。
    // 字面量是「此刻一定连得上」的那个，mDNS 名换网后才有价值——所以两个都给，顺序不能反。
    const invitation = server.invite(['shared']);
    expect(invitation.endpoint).toBe(`http://${address}:${new URL(invitation.endpoint).port}`);
    const advertised = lanAdvertisedHost(address!, hostname());
    if (advertised === address) expect(invitation.altEndpoint).toBeUndefined();
    else expect(invitation.altEndpoint).toBe(`http://${advertised}:${new URL(invitation.endpoint).port}`);
    expect(parseInvitation(JSON.stringify(invitation))).toMatchObject({ endpoint: invitation.endpoint });
  });

  it('rejects an invitation whose alternate address is not a valid LAN endpoint', () => {
    const invitation = server.invite(['shared']);
    for (const altEndpoint of ['http://evil.example:8182', 'http://8.8.8.8:8182', 'http://192.168.1.2:8182/path', 42]) {
      expect(() => parseInvitation(JSON.stringify({ ...invitation, altEndpoint }))).toThrow();
    }
  });

  it('pairs over the alternate address when the primary one is dead, and remembers which worked', async () => {
    const live = server.invite(['shared']);
    // 主地址指向一个没人听的端口：这就是「宿主换了网、旧地址失效」在测试里的样子。
    const dead = `http://${address}:${1}`;
    const binding = await client.pair(JSON.stringify({ ...live, endpoint: dead, altEndpoint: live.endpoint }));
    expect(binding.endpoint).toBe(live.endpoint);
    expect(binding.altEndpoint).toBe(dead);
    expect(await client.request({ action: 'command', command: command(binding) })).toMatchObject({ kind: 'accepted' });
  });

  it('reconnects over the alternate address after the primary one stops answering', async () => {
    const live = server.invite(['shared']);
    const binding = await client.pair(JSON.stringify(live));
    const dead = `http://${address}:${1}`;
    const recovered = await client.recover({ endpoint: dead, altEndpoint: binding.endpoint, hostKey: binding.hostKey }, binding);
    expect(recovered.endpoint).toBe(binding.endpoint);
    expect(recovered.altEndpoint).toBe(dead);
  });

  it('does not spend the alternate address when the handshake itself was rejected', async () => {
    // 换地址只解决「没连上」。主机身份对不上说明已经够到宿主了，换个地址还是同一台机器，
    // 只会白烧掉一次性邀请，并把真正的错误换成第二次的。
    const live = server.invite(['shared']);
    let hellos = 0;
    const counting = new LanCompanionClient(createIdentity(), async (url, body) => {
      if (url.endsWith('/v1/hello')) hellos += 1;
      return post(url, body);
    });
    await expect(counting.pair(JSON.stringify({ ...live, altEndpoint: live.endpoint,
      hostKey: toHex(createIdentity().publicKey) }))).rejects.toThrow('HOST_KEY_MISMATCH');
    expect(hellos).toBe(1);
    counting.close();
  });

  it('surfaces the primary failure, not the alternate one, when neither address answers', async () => {
    const live = server.invite(['shared']);
    await expect(client.pair(JSON.stringify({ ...live, endpoint: `http://${address}:1`, altEndpoint: `http://${address}:2` })))
      .rejects.toThrow(/ECONNREFUSED|fetch failed/);
  });

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
    // A channel expires only after a full TTL of silence following its last successful RPC.
    // 显式越过边界（TTL + 1ms），不押 expiresAt <= now 的等号巧合。
    now += L.channelTtlMs + 1;
    await expect(client.request({ action: 'status', commandId: 'first' })).rejects.toThrow('HTTP_403');
    await client.resume(binding);
  });
  it('keeps an active channel online beyond its original TTL', async () => {
    await pair();
    const firstExpiry = now + L.channelTtlMs;
    now += L.channelTtlMs - 1;
    await client.request({ action: 'status', commandId: 'missing' });
    expect(now).toBeGreaterThanOrEqual(firstExpiry - 1);

    now += L.channelTtlMs - 1;
    await client.request({ action: 'status', commandId: 'missing' });
    expect(now).toBeGreaterThan(firstExpiry);

    now += L.channelTtlMs - 1;
    await expect(client.request({ action: 'status', commandId: 'missing' })).resolves.toBeDefined();
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
  it('cache-full phone still previews a fully downloaded artifact', async () => {
    // 真 LAN + Noise + 真 CompanionFileService；手机缓存配额 1 字节必然 STORAGE_FULL。
    // 文件完整回传并通过 SHA-256 后预览必须照常，commandError 只提示 STORAGE_FULL。
    const workspace = mkdtempSync(path.join(tmpdir(), 'neo-lan-files-'));
    const db2 = new Database(':memory:');
    const holder: { files?: CompanionFileService } = {};
    const gateway2 = new CompanionGateway(db2, { now: () => now, dispatch: (cmd) =>
      cmd.action.startsWith('files.') ? holder.files?.dispatch(cmd) ?? { state: 'rejected', result: { code: 'HOST_UNAVAILABLE' } }
        : { state: 'rejected', result: { code: 'HOST_UNAVAILABLE' } } });
    holder.files = new CompanionFileService(db2, gateway2, () => workspace, undefined, () => now);
    const server2 = new LanCompanionServer(gateway2, hostIdentity, () => now);
    await server2.start(address!, 0);
    let storage: string | null = null;
    const phone = createCompanionStore({ read: async () => storage,
      write: async value => { storage = value; },
      scan: async () => JSON.stringify(server2.invite(['shared'])), post,
    }, () => {}, undefined, {
      cache: new FileCache(1),
      pick: async () => null,
      save: async () => { throw new Error('must-not-save'); },
    });
    try {
      await phone.getState().pair();
      const bytes = new TextEncoder().encode('lan-file-正文');
      await phone.getState().upload({ name: 'note.txt', mimeType: 'text/plain', size: bytes.length, bytes });
      const artifact = phone.getState().artifacts[0];
      expect(artifact).toBeTruthy();
      await phone.getState().previewArtifact(artifact.artifactId);
      const state = phone.getState();
      expect(state.preview?.bytes.length).toBe(bytes.length);
      expect(state.commandError).toBe('STORAGE_FULL');
      // files.read 的分片 base64 落库后随手机读取即擦除，不留永久膨胀（claude 复审 Important 3）
      const leftovers = db2.prepare("SELECT command_id FROM companion_commands WHERE action = 'files.read' AND json_extract(result_json, '$.data') IS NOT NULL").all();
      expect(leftovers).toEqual([]);
    } finally {
      phone.getState().pause();
      await server2.stop(); db2.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  it('transports long Unicode messages across multiple authenticated records', async () => {
    const binding = await pair();
    const long = { ...command(binding), payload: { text: '你'.repeat(30_000) } };
    expect(await client.request({ action: 'command', command: long })).toMatchObject({ kind: 'accepted' });
    expect(executions).toBe(1);
  });
  // A desktop paste can publish one event bigger than a whole frame. It used to retire the
  // channel, and the cursor could never get past it: the phone was locked out for good.
  const oversized = () => 'x'.repeat(L.maxPayloadBytes * L.maxMessageRecords + 1_024);
  const sync = async (binding: LanBinding, afterSeq: number) =>
    await client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq }) as CompanionSyncResult;

  it('steps the cursor past an undeliverable oversized event and keeps delivering what follows', async () => {
    const binding = await pair();
    gateway.publish('shared', 'message', { content: 'before' });
    gateway.publish('shared', 'message', { content: oversized() });
    gateway.publish('shared', 'message', { content: 'after' });

    const first = await sync(binding, 0);
    expect(first.events.map(event => event.payload.content)).toEqual(['before']);
    expect(first.nextSeq).toBe(1);

    // The oversized event is now first in the page: it must be cleared, not fatal.
    const second = await sync(binding, first.nextSeq);
    expect(second.nextSeq).toBe(2);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ seq: 2, sessionId: 'shared', kind: COMPANION_EVENT_DROPPED,
      payload: { reason: 'too_large', kind: 'message' } });
    // The marker replaces the payload rather than truncating it — no leak, no silent gap.
    expect(second.events[0].payload).not.toHaveProperty('content');
    expect(Number(second.events[0].payload.bytes)).toBeGreaterThan(L.maxPayloadBytes * L.maxMessageRecords);

    const third = await sync(binding, second.nextSeq);
    expect(third.events.map(event => event.payload.content)).toEqual(['after']);
    expect(third.nextSeq).toBe(3);
    // Same channel the whole way: the poison event never kicked the phone off.
    expect(server.hasApprovalUi('shared')).toBe(true);
  });

  it('leaves the phone connected on an oversized event and shows it as dropped, not missing', async () => {
    const invitation = JSON.stringify(server.invite(['shared']));
    let storage: string | null = null;
    const phone = createCompanionStore({
      read: async () => storage, write: async value => { storage = value; },
      scan: async () => invitation, post,
    }, () => {});
    await phone.getState().pair();
    gateway.publish('shared', 'message', { content: oversized() });
    gateway.publish('shared', 'message', { content: 'after' });

    await phone.getState().sync();
    await phone.getState().sync();
    expect(phone.getState().status).toBe('connected');
    expect(phone.getState().events.map(event => event.kind)).toEqual([COMPANION_EVENT_DROPPED, 'message']);
    expect(phone.getState().events[1].payload.content).toBe('after');
    phone.getState().pause();
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
  it('counts only recent authenticated activity in the authorized session as an approval UI', async () => {
    const binding = await pair();
    expect(server.hasApprovalUi('shared')).toBe(false);
    await client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq: 0 });
    expect(server.hasApprovalUi('shared')).toBe(true);
    expect(server.hasApprovalUi('hidden')).toBe(false);
    now += L.uiPresenceTtlMs;
    expect(server.hasApprovalUi('shared')).toBe(false);
    await client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq: 0 });
    expect(server.hasApprovalUi('shared')).toBe(true);
    server.revoke(binding.deviceId);
    expect(server.hasApprovalUi('shared')).toBe(false);
  });
  it('does not keep approval UI presence after an invalid authenticated exchange closes the channel', async () => {
    const binding = await pair();
    await client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq: 0 });
    expect(server.hasApprovalUi('shared')).toBe(true);
    await expect(client.request({ action: 'unsupported' })).rejects.toThrow();
    expect(server.hasApprovalUi('shared')).toBe(false);
  });
  it('recognizes a desktop-started user message as an active run on the phone', async () => {
    let storage: string | null = null;
    const phone = createCompanionStore({ read: async () => storage, write: async value => { storage = value; },
      scan: async () => JSON.stringify(server.invite(['shared'])), post }, () => {});
    await phone.getState().pair();
    gateway.publish('shared', 'message', { id: 'desktop-message', role: 'user', content: 'desktop task', runId: 'desktop-run' });
    await phone.getState().sync();
    expect(phone.getState()).toMatchObject({ runId: 'desktop-run', terminal: null });
    gateway.publish('shared', 'agent_complete', { runId: 'desktop-run' });
    await phone.getState().sync();
    expect(phone.getState()).toMatchObject({ runId: null, terminal: 'complete' });
    phone.getState().pause();
  });
  it('clears a pending file command after the transfer is interrupted so retry is possible', async () => {
    const invitation = JSON.stringify(server.invite(['shared']));
    let storage: string | null = null;
    const failingPost: LanPost = async (url, body) => {
      if (String(url).endsWith('/v1/exchange')) throw new Error('COMPANION_NETWORK_UNAVAILABLE');
      return post(url, body);
    };
    const phone = createCompanionStore({
      read: async () => storage, write: async value => { storage = value; },
      scan: async () => invitation, post: failingPost,
    }, () => {});
    await phone.getState().pair();
    expect(phone.getState().status).toBe('connected');
    await phone.getState().upload({ name: 'photo.png', mimeType: 'image/png', size: 4, bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(phone.getState().pending).toBe(false);
    expect(JSON.parse(storage!).pending).toBeUndefined();
    phone.getState().pause();
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

// 桌面或另一台手机先批了同一条审批时，网关回 approval_conflict。它曾经跟「设备被撤销」
// 共用 status:'rejected'，于是这台手机 sync / send / stop / respond 全部短路，界面显示
// 「设备已被移除」，只能人工重连。抢答是正常并发，不是设备失效。
describe('a lost approval race must not retire the device', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let server: LanCompanionServer;
  let decideCalls: number;
  const hostIdentity = createIdentity();
  const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && isPrivateIPv4(n.address))?.address;
  const post: LanPost = async (url, body) => {
    const res = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return JSON.parse(raw);
  };

  beforeEach(async () => {
    if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
    decideCalls = 0;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      dispatch: () => ({ state: 'accepted', result: { runId: 'run-after-race' } }),
      // 抢答会在 submit 的前置检查就返回，真实裁决口不该被再调一次。
      decide: () => { decideCalls += 1; return { kind: 'rejected', reason: 'unsupported_action' }; },
    });
    server = new LanCompanionServer(gateway, hostIdentity);
    await server.start(address, 0);
  });
  afterEach(async () => { await server?.stop(); db?.close(); });

  async function phoneOnline() {
    let storage: string | null = null;
    const invitation = JSON.stringify(server.invite(['shared']));
    const phone = createCompanionStore({
      read: async () => storage, write: async value => { storage = value; },
      scan: async () => invitation, post,
    }, () => {});
    await phone.getState().pair();
    expect(phone.getState().status).toBe('connected');
    return phone;
  }

  it('抢答只记成这条命令的结果，连接照旧可用', async () => {
    const phone = await phoneOnline();
    const requestId = 'request-raced';
    const card = { requestId, sessionId: 'shared', revision: 1, status: 'pending' as const, resolvedBy: null, operationDigest: 'digest-1' };
    gateway.registerDecision(card);
    gateway.publish('shared', 'approval', { ...card, preview: 'write /tmp/raced.txt' });
    await phone.getState().sync();
    expect(phone.getState().events.at(-1)?.kind).toBe('approval');

    // 桌面先批了：台账翻成 approved，手机手里那张卡就此过期——这就是抢答现场
    gateway.registerDecision({ ...card, status: 'approved', resolvedBy: 'desktop' });
    await phone.getState().respond(requestId, 'approved');

    // 连接没有被这次抢答终结
    expect(phone.getState().status).toBe('connected');
    // 而且这次抢答是可区分的，不是笼统的一句失败
    expect(phone.getState().commandError).toBe('COMPANION_APPROVAL_CONFLICT');
    expect(decideCalls).toBe(0);

    // 事件流还在收
    gateway.publish('shared', 'message', { content: 'after the race' });
    await phone.getState().sync();
    expect(phone.getState().events.map(event => event.payload.content)).toContain('after the race');

    // 后续命令仍然发得出去
    await phone.getState().send('still usable');
    expect(phone.getState()).toMatchObject({ status: 'connected', pending: false });
    phone.getState().pause();
  });

  it('授权真的不覆盖这条会话时仍然终结连接——修的是误判，不是把终态取消', async () => {
    const phone = await phoneOnline();
    await phone.getState().manage('session.rename', { title: 'renamed' }, 'session-outside-my-scope');
    expect(phone.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected' });
    phone.getState().pause();
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
  it('accepts canonical RFC1918 or mDNS endpoints and an unexpired well-formed QR', () => {
    expect(validateLanEndpoint('http://192.168.1.2:8181')).toBe('http://192.168.1.2:8181');
    expect(validateLanEndpoint('http://neo-host.local:8182')).toBe('http://neo-host.local:8182');
    expect(isPrivateIPv4('172.31.1.1')).toBe(true); expect(isPrivateIPv4('172.32.1.1')).toBe(false);
    expect(() => parseInvitation('{}')).toThrow();
  });
  const notMdns = ['local', 'localhost', '.local', '-bad.local', 'bad-.local', 'evil.local.com', 'foo.localdomain', 'local.evil.com'];
  it.each(notMdns)('does not mistake %s for an mDNS name', host => {
    expect(() => validateLanEndpoint(`http://${host}:8181`)).toThrow();
    expect(lanAdvertisedHost('192.168.1.2', host)).toBe('192.168.1.2');
  });
  it('admits only on-link peers, and cuts the rest before they can hold a socket', () => {
    // Binding every interface is only safe because this predicate runs on 'connection', not per
    // request: an off-link caller never gets to occupy maxConnections or idle out requestTimeout.
    for (const peer of ['192.168.1.2', '10.0.0.7', '172.16.3.4', '127.0.0.1', '127.5.5.5', '::1']) {
      expect(isLanPeer(peer)).toBe(true);
    }
    for (const peer of ['100.83.97.48', '198.18.0.1', '8.8.8.8', '169.254.169.254', '172.32.1.1', '', 'localhost']) {
      expect(isLanPeer(peer)).toBe(false);
    }
  });
  it('advertises the mDNS name when the host has one, the literal when it does not', () => {
    // The literal is what dies on a network change; the name is why a paired phone need not rescan.
    expect(lanAdvertisedHost('192.168.1.2', 'Linchens-MacBook-Pro.local')).toBe('linchens-macbook-pro.local');
    expect(lanAdvertisedHost('192.168.1.2', 'ubuntu-box')).toBe('192.168.1.2');
    expect(lanAdvertisedHost('192.168.1.2', 'host.localdomain')).toBe('192.168.1.2');
    expect(validateLanEndpoint(`http://${lanAdvertisedHost('192.168.1.2', 'neo.local')}:8182`)).toBe('http://neo.local:8182');
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
