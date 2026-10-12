import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { LanCompanionManager } from '../../../src/host/services/companion/LanCompanionManager';
import { RemoteOffResponder } from '../../../src/host/services/companion/RemoteOffResponder';
import { createHandshake, createIdentity } from '../../../src/shared/companion/noiseChannel';
import { isPrivateIPv4, toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';

/**
 * N-COMPANION-KILLSWITCH-WIRE：总闸关着时 LAN 端口上只留一个最小应答器——每个请求都拿
 * 同一份固定字节（403 + COMPANION_REMOTE_OFF），手机由此分清「电脑关了远程」和「不可达」。
 * ② 六种请求形状字节全等；③ 结构上没有通向 gateway 的路径（行为 + 源码双钉）；
 * ④ 答案不携带任何设备信息；⑦ 重启（新 gateway + restore）开的只有应答器。
 */

const address = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && isPrivateIPv4(item.address))?.address;

function requireAddress(): string {
  if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
  return address;
}

const FIXED_BODY = '{"error":"COMPANION_REMOTE_OFF"}';

interface WireAnswer { statusLine: string; headers: string[]; body: string }

/** 真 TCP 客户端：把请求头（可选地连同一段 body）写出去，收完一整份 HTTP 应答再断言。 */
function ask(port: number, head: string, body?: string, bodyBytes = 0): Promise<WireAnswer> {
  return new Promise((resolve, reject) => {
    let pump = (): void => {};
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.write(head); if (body !== undefined) socket.write(body); else if (bodyBytes > 0) pump(); });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP_TIMEOUT')); }, 3_000);
    let raw = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const [statusLine, ...rest] = raw.split('\r\n');
      const blank = rest.indexOf('');
      resolve({ statusLine, headers: rest.slice(0, blank), body: rest.slice(blank + 1).join('\r\n') });
      socket.destroy();
    };
    socket.on('data', chunk => {
      raw += chunk.toString('latin1');
      const split = raw.indexOf('\r\n\r\n');
      if (split >= 0) {
        const length = Number(/content-length: (\d+)/i.exec(raw)?.[1] ?? '-1');
        if (raw.length - split - 4 >= length) done();
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // 服务端答案先到、FIN 写侧后，客户端还在灌大 body 会 EPIPE——答案已在手上就算成功。
      if (/EPIPE|ECONNRESET/.test(error.code ?? '')) done();
      else { clearTimeout(timer); reject(error); }
    });
    socket.once('close', () => done());
    if (bodyBytes > 0) {
      // 大 body 分帧续写：应答器从不读 body，答案必须在 body 灌完之前就完整到手。
      const chunk = 'a'.repeat(64 * 1024);
      let sent = 0;
      pump = () => {
        while (sent < bodyBytes) {
          const part = chunk.slice(0, Math.min(chunk.length, bodyBytes - sent));
          if (!socket.write(part)) { sent += part.length; socket.once('drain', pump); return; }
          sent += part.length;
        }
      };
    }
  });
}

function headOf(method: string, path: string, headers: Record<string, string>, length: number): string {
  return `${method} ${path} HTTP/1.1\r\nhost: 127.0.0.1:${L.lanPort}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\ncontent-length: ${length}\r\n\r\n`;
}

/** 六种形状：合法 hello / 坏 JSON / 错 method / 错 path / 错 content-type / 超限 body。 */
function shapes(): Array<{ label: string; method: string; path: string; headers: Record<string, string>; body: string }> {
  const json = { 'content-type': 'application/json' };
  const oversized = L.maxFrameBytes * L.maxRequestRecords * 2 + 512;
  return [
    { label: 'valid hello', method: 'POST', path: '/v1/hello', headers: json, body: JSON.stringify({ mode: 'resume', frame: '00' }) },
    { label: 'malformed JSON', method: 'POST', path: '/v1/hello', headers: json, body: '{"oops' },
    { label: 'wrong method (GET)', method: 'GET', path: '/v1/hello', headers: {}, body: '' },
    { label: 'wrong path', method: 'POST', path: '/v1/whatever', headers: { ...json, connection: 'close' }, body: '{}' },
    { label: 'wrong content-type', method: 'POST', path: '/v1/hello', headers: { 'content-type': 'text/plain' }, body: 'not json' },
    { label: 'oversized body', method: 'POST', path: '/v1/hello', headers: json, body: 'a'.repeat(oversized) },
  ];
}

function canonical(answer: WireAnswer): string {
  // date 是逐请求变化的唯一头，剥掉后六份应答必须逐字节相等。
  return [answer.statusLine, ...answer.headers.filter(line => !/^date:/i.test(line)).sort(), answer.body].join('\r\n');
}

describe('remote-off responder: fixed answer on the wire (②)', () => {
  let responder: RemoteOffResponder;
  beforeEach(async () => {
    responder = new RemoteOffResponder();
    await responder.start(0);
  });
  afterEach(async () => { await responder.stop(); });

  it('answers every request shape with the same fixed bytes', async () => {
    const answers: WireAnswer[] = [];
    for (const shape of shapes()) {
      const head = headOf(shape.method, shape.path, shape.headers, Buffer.byteLength(shape.body));
      answers.push(await ask(responder.port, head, shape.body));
    }
    for (const answer of answers) {
      expect(answer.statusLine).toBe('HTTP/1.1 403 Forbidden');
      expect(answer.headers).toContain('content-type: application/json');
      expect(answer.headers).toContain('cache-control: no-store');
      expect(answer.body).toBe(FIXED_BODY);
    }
    expect(new Set(answers.map(canonical)).size).toBe(1);
  });

  it('answers before an oversized body finishes uploading (never reads it)', async () => {
    const oversized = L.maxFrameBytes * L.maxRequestRecords * 2 + 512;
    const head = headOf('POST', '/v1/hello', { 'content-type': 'application/json' }, oversized);
    const answer = await ask(responder.port, head, undefined, oversized);
    expect(answer.statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect(answer.body).toBe(FIXED_BODY);
  });

  it('holds the same bounds as the real server', () => {
    // 同真服务：requestTimeout/headersTimeout/maxConnections 一致（不另设一套）。
    const source = readFileSync('src/host/services/companion/RemoteOffResponder.ts', 'utf8');
    expect(source).toContain('server.requestTimeout = L.requestTimeoutMs');
    expect(source).toContain('server.headersTimeout = L.requestTimeoutMs');
    expect(source).toContain('server.maxConnections = L.maxChannels * 2');
  });
});

describe('remote-off responder: no path to the gateway (③/④/⑦, manager-level)', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let manager: LanCompanionManager;
  const hostIdentity = createIdentity();
  let deviceId = '';
  let publicKey = '';

  beforeEach(() => {
    requireAddress();
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      now: () => 1_700_000_000_000,
      dispatch: () => ({ state: 'accepted', result: { runId: 'run' } }),
      read: async () => ({ sessions: [] }),
    });
    publicKey = toHex(createIdentity().publicKey);
    deviceId = gateway.pairIdentity(publicKey, ['shared']).deviceId;
    manager = new LanCompanionManager(gateway, async () => hostIdentity, async () => [{ id: 'shared', title: 'Shared' }], () => []);
  });
  afterEach(async () => {
    await manager.stop();
    db.close();
  });

  function endpoint(): string {
    const ad = manager.lanAdvertisement();
    if (!ad) throw new Error('responder did not open');
    const url = new URL(ad.endpoint);
    return `http://127.0.0.1:${url.port}`;
  }

  async function postRaw(path: string, body: unknown): Promise<{ status: number; text: string }> {
    const res = await fetch(`${endpoint()}${path}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  it('setRemote(false) swaps the real server for the responder on the same port; zero gateway calls while off (③)', async () => {
    const invitation = await manager.manage({ action: 'invite', scope: ['shared'] });
    if (invitation.kind !== 'invitation') throw new Error('invite failed');
    const before = new URL(manager.lanAdvertisement()!.endpoint).port;
    const spies = (['identityDevice', 'pairIdentity', 'submit', 'read', 'syncForDevice', 'commandStatus', 'revokeDevice'] as const)
      .map(method => vi.spyOn(gateway, method));
    const prepare = vi.spyOn(db, 'prepare');
    await manager.manage({ action: 'setRemote', enabled: false });
    prepare.mockClear();
    const after = new URL(manager.lanAdvertisement()!.endpoint).port;
    expect(after).toBe(before);   // 同一端口顶班：手机存的端点不用换
    for (const shape of shapes()) {
      const head = headOf(shape.method, shape.path, shape.headers, Buffer.byteLength(shape.body));
      const answer = await ask(Number(after), head, shape.body);
      expect(answer.body).toBe(FIXED_BODY);
    }
    const overLimit = await postRaw('/v1/hello', { mode: 'resume', frame: 'a'.repeat(1024) });
    expect(overLimit).toEqual({ status: 403, text: FIXED_BODY });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();   // 关闸后的请求一个字节都没读库
  });

  it('the answer carries no device-specific data: paired handshake bytes and garbage get identical bytes (④)', async () => {
    await manager.manage({ action: 'setRemote', enabled: false });
    const port = Number(new URL(manager.lanAdvertisement()!.endpoint).port);
    // 已配对设备的真握手字节（noise initiator 首帧）vs 纯垃圾：答案逐字节相同。
    const handshake = createHandshake(true, createIdentity(), undefined, undefined, toHex(hostIdentity.publicKey));
    const realFrame = toHex(handshake.send());
    const identity = vi.spyOn(gateway, 'identityDevice');
    const answers = await Promise.all([
      ask(port, headOf('POST', '/v1/hello', { 'content-type': 'application/json' }, realFrame.length), realFrame),
      ask(port, headOf('POST', '/v1/hello', { 'content-type': 'application/json' }, 4), 'junk'),
    ]);
    expect(answers.map(canonical)).toEqual([canonical(answers[1]), canonical(answers[1])]);
    expect(identity).not.toHaveBeenCalled();
  });

  it('restore() with the flag off opens only the responder, never the real server (⑦)', async () => {
    gateway.setRemoteEnabled(false);
    const loadIdentity = vi.fn(async () => hostIdentity);
    const fresh = new LanCompanionManager(gateway, loadIdentity, async () => [{ id: 'shared', title: 'Shared' }], () => []);
    try {
      await fresh.restore();
      manager = fresh;
      const ad = fresh.lanAdvertisement();
      expect(ad).not.toBeNull();
      expect(loadIdentity).not.toHaveBeenCalled();   // 真服务从未被构造
      const identity = vi.spyOn(gateway, 'identityDevice');
      const hello = await postRaw('/v1/hello', { mode: 'resume', frame: '00' });
      expect(hello).toEqual({ status: 403, text: FIXED_BODY });
      expect(gateway.pairedDevices().map(device => device.deviceId)).toEqual([deviceId]);   // 配对原样
      expect(identity).not.toHaveBeenCalled();
    } finally {
      await fresh.stop();
    }
  });
});

describe('remote-off responder: source contract (③)', () => {
  it('imports nothing outside node:http and the two shared modules', () => {
    const source = readFileSync('src/host/services/companion/RemoteOffResponder.ts', 'utf8');
    const specifiers = [...source.matchAll(/^import[^']*from '([^']+)';$/gm)].map(match => match[1]);
    expect(specifiers).toEqual(['node:http', '../../../shared/constants/companion', '../../../shared/companion/lanProtocol']);
  });
});
