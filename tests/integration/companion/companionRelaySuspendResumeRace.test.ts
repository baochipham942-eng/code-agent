import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import WebSocketImpl from 'ws';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { startCompanionRelayAccountIfConfigured } from '../../../src/host/services/companion/companionRelayAccount';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { FakeCompanionRelay } from './fakeCompanionRelay';

/**
 * 总闸快速关→开（rework r1）：suspend() 尾部还在等旧 socket 关掉时 resume() 插进来，
 * 账号通道必须重新拨号，而不是被 follow 的同用户早退吞掉后一直没人拨。
 */

const quietLog = { warn(): void {}, info(): void {} };

describe('companion relay account suspend/resume race', () => {
  const sockets = { n: 0 };
  class SlowCloseWebSocket extends WebSocketImpl {
    constructor(url: string, options?: WebSocketImpl.ClientOptions) {
      sockets.n += 1;
      super(url, options);
    }

    /** 真正发起 close 推迟 400ms：client.stop() 要等 'close'，suspend 尾部的等待窗口因此被撑开成可观测的时长（仍在 stop 的 500ms 兜底内）。 */
    override close(code?: number | ((err?: Error) => void), data?: string | Buffer): void {
      setTimeout(() => { super.close(code as number | undefined, data); }, 400);
    }
  }

  let db: Database.Database | undefined;
  let relay: FakeCompanionRelay | undefined;
  let dataDir = '';
  let account: ReturnType<typeof startCompanionRelayAccountIfConfigured> | undefined;
  const secret = 'test-relay-credential';
  const hostIdentity = createIdentity();

  beforeEach(async () => {
    sockets.n = 0;
    db = new Database(':memory:');
    const gateway = new CompanionGateway(db);
    relay = new FakeCompanionRelay(secret);
    await relay.listen();
    dataDir = mkdtempSync(path.join(tmpdir(), 'relay-suspend-race-'));
    writeFileSync(path.join(dataDir, L.relayConfigFile), JSON.stringify({
      v: 1, enabled: true, url: relay.url, credentialRef: 'companion-relay', reconnectBackoffMs: [40, 40, 40],
    }));
    account = startCompanionRelayAccountIfConfigured({
      dataDirectory: dataDir,
      gateway,
      loadIdentity: async () => hostIdentity,
      auth: {
        getCurrentUser: () => ({ id: 'user-1' }),
        getAccessToken: async () => secret,
        addAuthChangeCallback: () => () => {},
      },
      jitter: () => 0,
      WebSocket: SlowCloseWebSocket as unknown as typeof WebSocket,
      logger: quietLog,
    });
    await vi.waitFor(() => expect(account!.connected()).toBe(true), { timeout: 8_000 });
  });

  afterEach(async () => {
    await account?.stop();
    await relay?.stop();
    db?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('redials after a resume that lands inside the suspend stop window', async () => {
    const handle = account;
    if (!handle) throw new Error('account handle missing');
    const seen = sockets.n;
    expect(handle.connected()).toBe(true);
    const suspending = handle.suspend();
    // 40ms 后 suspend 已在尾部等旧 socket 关（真 close 被拖到 400ms 才发起），还没返回。
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(handle.connected()).toBe(false);
    handle.resume();
    await suspending;
    // 修复前：resume 的 follow 命中同用户早退，随后 suspend 置空 client，此后再没有人拨号。
    await vi.waitFor(() => expect(sockets.n).toBeGreaterThan(seen), { timeout: 2_000 });
    await vi.waitFor(() => expect(handle.connected()).toBe(true), { timeout: 8_000 });
  });
});
