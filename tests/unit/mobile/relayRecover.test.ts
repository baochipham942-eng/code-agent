import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { createRelayPairHandshake, deriveRelayPairVerify } from '../../../src/shared/companion/relayPair';
import { NoiseChannel } from '../../../src/shared/companion/noiseChannel';
import { fromHex, sha256, toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import { COMPANION_RELAY_PLACEHOLDER_URL } from '../../../src/shared/constants/network';
import { messages, recoverErrorCopy } from '../../../packages/mobile/src/i18n';
import type { RecoverError } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import type { RelayDialSocket } from '../../../packages/mobile/src/platform/relayCompanionClient';
import type { CompanionRelayFrame } from '../../../src/shared/contract/companionRelay';

/**
 * 「登录找回我的电脑」的手机全链路（N-COMPANION-RELAY-ACCOUNT-RECOVER）：真 relayRecover 协议
 * 客户端 + 真 XX 握手（对面是测试里现起的 responder），只脚本化 Supabase fetch 与 relay socket。
 * 守卫面：④ 配对落盘与扫码同一存储形状（binding/双路由/account 票据）、access token 与密码
 * **不落盘**（M4 哨兵）；⑤ 旧 Host（无指纹）确定性降级「需要升级」且不发 pair-request。
 */

const ACCESS_TOKEN = 'fake-access-token-sentinel';
const PASSWORD = 'super-secret-pw';
const TICKET = 'neo1.payload.mac';
const ACCOUNT_ROUTE = { v: 1 as const, url: 'wss://relay.example.invalid/companion', routeToken: 'account-token-bbbbbb' };
const LEGACY_ROUTE = { v: 1 as const, url: 'wss://relay.example.invalid/companion', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };

/** 脚本化的找回 socket：收帧记录、测试侧手工投帧（relay/Host 两角都由它演）。 */
class RecoverSocket {
  readonly sent: string[] = [];
  closed = false;
  private openHandlers: Array<() => void> = [];
  private closeHandlers: Array<() => void> = [];
  private messageHandlers: Array<(data: string) => void> = [];
  readonly socket: RelayDialSocket = {
    send: data => { this.sent.push(data); },
    close: () => { this.closed = true; },
    onOpen: handler => { this.openHandlers.push(handler); },
    onClose: handler => { this.closeHandlers.push(handler); },
    onError: () => {},
    onMessage: handler => { this.messageHandlers.push(handler); },
  };
  open(): void { for (const handler of [...this.openHandlers]) handler(); }
  deliver(frame: Record<string, unknown>): void {
    for (const handler of [...this.messageHandlers]) handler(JSON.stringify(frame));
  }
  fireClose(): void { for (const handler of [...this.closeHandlers]) handler(); }
  frames(): CompanionRelayFrame[] { return this.sent.map(raw => JSON.parse(raw) as CompanionRelayFrame); }
}

function envelope(routeToken: string) {
  return { routeToken, deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() };
}

const hostIdentity = createIdentity();
const HOST_FINGERPRINT = toHex(sha256(hostIdentity.publicKey));

function okFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** 会话脚本的 Host 侧：接到 pair-request 就按剧本回（同意 reply / 续帧 complete）。 */
async function playHostApproval(socket: RecoverSocket, payload: Record<string, unknown>): Promise<void> {
  const responder = createRelayPairHandshake(false, hostIdentity);
  const first = socket.frames().find(frame => frame.kind === 'pair-request' && frame.instanceId) as Extract<CompanionRelayFrame, { kind: 'pair-request' }>;
  expect(responder.recv(fromHex(first.ciphertext)).length).toBe(0);
  socket.deliver({
    v: 1, kind: 'pair-result', requestId: first.requestId, accepted: true, stage: 'reply',
    envelope: envelope('neo-relay-pair-request'), ciphertext: toHex(responder.send()),
  });
  // 手机的续帧在 deliver 恢复的微任务之后才发出来：等它落地。
  await vi.waitFor(() => {
    const continuation = socket.frames().find(frame => frame.kind === 'pair-request' && !frame.instanceId && frame.requestId === first.requestId);
    expect(continuation).toBeDefined();
  });
  const continuation = socket.frames().find(frame => frame.kind === 'pair-request' && !frame.instanceId && frame.requestId === first.requestId) as Extract<CompanionRelayFrame, { kind: 'pair-request' }>;
  expect(responder.recv(fromHex(continuation.ciphertext)).length).toBe(0);
  expect(responder.complete).toBe(true);
  const channel = new NoiseChannel(responder);
  socket.deliver({
    v: 1, kind: 'pair-result', requestId: first.requestId, accepted: true, stage: 'complete',
    envelope: envelope('neo-relay-pair-request'), ciphertext: JSON.stringify(channel.seal(payload)),
  });
}

const recoverPayload = {
  deviceId: 'phone-recovered-1', scopeEpoch: 3, scope: ['project:main'],
  hostAccountEmail: 'lin@example.com', sessionlessTranscribe: true as const,
  lan: { endpoint: 'http://192.168.1.4:8182', altEndpoint: 'http://mac.local:8182' },
  routes: { v: 1 as const, account: ACCOUNT_ROUTE, legacy: LEGACY_ROUTE },
};

function storeWith(socket: RecoverSocket, savedRaw: string | null = null) {
  const writes: string[] = [];
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => savedRaw,
    write: async value => { writes.push(value); },
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
    dialRelay: () => { queueMicrotask(() => socket.open()); return socket.socket; },
  };
  return { store: createCompanionStore(companion, () => {}), writes };
}

/** 成功后的 reconnect 需要 LAN/relay 会话客户端：成功连上 relay（真实现不进本测）。 */
vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() { throw new Error('COMPANION_NETWORK_UNAVAILABLE'); }
    async request() { throw new Error('unused'); }
    close() {}
  },
}));
vi.mock('../../../packages/mobile/src/platform/relayCompanionClient', () => ({
  browserRelayDial: () => { throw new Error('test must inject dialRelay'); },
  RelayCompanionClient: class {
    constructor() { /* 会话通道由本测替身扮演：只验 store 侧的落盘与状态迁移 */ }
    async connect() {}
    async resume() {}
    async request() { return { kind: 'events', epoch: 3, nextSeq: 0, events: [] }; }
    close() {}
  },
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('relayRecover：登录 → 列电脑 → 配对落盘（与扫码同形状）', () => {
  let socket: RecoverSocket;
  let store: ReturnType<typeof storeWith>['store'];
  let writes: string[];

  beforeEach(async () => {
    socket = new RecoverSocket();
    ({ store, writes } = storeWith(socket));
    await store.getState().hydrate();
    vi.stubGlobal('fetch', okFetch({ access_token: ACCESS_TOKEN, user: { id: 'user-1', email: 'lin@example.com' } }));
  });

  async function loginToListHosts(hostEntry: { name: string; fingerprint: string; instanceId: string }): Promise<void> {
    const loginPromise = store.getState().recoverLogin('lin@example.com', PASSWORD);
    // dial 同步构造 → open/list-hosts 请求都已发出后按剧本回帧。
    await vi.waitFor(() => expect(socket.frames().some(frame => frame.kind === 'list-hosts')).toBe(true));
    socket.deliver({
      v: 1, kind: 'ticket',
      envelope: envelope('neo-relay-ticket-issue'), ciphertext: TICKET,
    });
    socket.deliver({
      v: 1, kind: 'list-hosts', envelope: envelope('neo-relay-list-hosts'),
      ciphertext: JSON.stringify([hostEntry]),
    });
    await loginPromise;
    expect(store.getState().recoverStep).toBe('hosts');
  }

  it('④ 全链路同意 ⇒ 配对落盘与扫码同一存储形状；票据落 account；密码与 access token 不落盘', async () => {
    await loginToListHosts({ name: "Lin's MacBook Pro", fingerprint: HOST_FINGERPRINT, instanceId: 'instance-id-1234567890' });
    expect(store.getState().recoverHosts).toHaveLength(1);

    const selectPromise = store.getState().recoverSelectHost(store.getState().recoverHosts![0]);
    // S6：核对码立即上屏——来自 XX 握手材料（与 Host 侧派生一致）。
    await vi.waitFor(() => expect(store.getState().recoverStep).toBe('pairing'));
    expect(store.getState().recoverCode).toMatch(/^\d{4}$/);
    const first = socket.frames().find(frame => frame.kind === 'pair-request' && frame.instanceId) as Extract<CompanionRelayFrame, { kind: 'pair-request' }>;
    const initiatorEphemeral = fromHex(first.ciphertext).slice(0, 32);
    expect(store.getState().recoverCode).toBe(deriveRelayPairVerify(initiatorEphemeral));

    await playHostApproval(socket, recoverPayload);
    await selectPromise;
    await vi.waitFor(() => expect(store.getState().recoverStep).toBe('idle'));
    // 落盘最后一份记录：binding/双路由/account 与 payload 逐字段对齐（扫码配对的同一存储形状）。
    const saved = JSON.parse(writes.at(-1)!) as Record<string, any>;
    expect(saved.binding).toMatchObject({
      version: 1, endpoint: 'http://192.168.1.4:8182', altEndpoint: 'http://mac.local:8182',
      hostKey: toHex(hostIdentity.publicKey), deviceId: 'phone-recovered-1', scopeEpoch: 3,
      scope: ['project:main'], hostAccountEmail: 'lin@example.com', sessionlessTranscribe: true,
    });
    expect(saved.relay).toEqual(LEGACY_ROUTE);
    expect(saved.relayAccount).toEqual(ACCOUNT_ROUTE);
    expect(saved.account).toEqual({ ticket: TICKET, email: 'lin@example.com', userId: 'user-1' });
    // M4 守卫（哨兵断言）：access token 与密码绝不进任何一份落盘记录。
    for (const write of writes) {
      expect(write).not.toContain(ACCESS_TOKEN);
      expect(write).not.toContain(PASSWORD);
    }
    // 找回完成即「已配对+已登录」：React 态与重连都上路了。
    expect(store.getState().binding?.deviceId).toBe('phone-recovered-1');
    expect(store.getState().account).toEqual({ email: 'lin@example.com', userId: 'user-1' });
  });

  it('⑤ 旧 Host（register 不带指纹）⇒ 确定性降级「需要升级」，不发 pair-request、无重试风暴', async () => {
    await loginToListHosts({ name: 'Old Mac', fingerprint: '', instanceId: 'instance-id-1234567890' });
    const sentBefore = socket.sent.length;
    await store.getState().recoverSelectHost(store.getState().recoverHosts![0]);
    expect(store.getState().recoverError).toBe('hostUpgrade');
    expect(store.getState().recoverStep).toBe('hosts');
    // 一个 pair-request 都没发出去。
    expect(socket.frames().filter(frame => frame.kind === 'pair-request')).toHaveLength(0);
    expect(socket.sent.length).toBe(sentBefore);
  });

  it('② 电脑拒绝 ⇒ 回 S5 横幅具名 declined，会话保留可再选', async () => {
    await loginToListHosts({ name: 'Mac', fingerprint: HOST_FINGERPRINT, instanceId: 'instance-id-1234567890' });
    const selectPromise = store.getState().recoverSelectHost(store.getState().recoverHosts![0]);
    await vi.waitFor(() => expect(socket.frames().some(frame => frame.kind === 'pair-request')).toBe(true));
    const first = socket.frames().find(frame => frame.kind === 'pair-request' && frame.instanceId) as Extract<CompanionRelayFrame, { kind: 'pair-request' }>;
    socket.deliver({
      v: 1, kind: 'pair-result', requestId: first.requestId, accepted: false, reason: 'declined',
      envelope: envelope('neo-relay-pair-request'), ciphertext: '',
    });
    await selectPromise;
    expect(store.getState().recoverStep).toBe('hosts');
    expect(store.getState().recoverError).toBe('declined');
    expect(store.getState().recoverCode).toBeNull();
  });

  it('② 目标不在线（host-offline）与账号服务连不上（S7 形状）各归各类', async () => {
    await loginToListHosts({ name: 'Mac', fingerprint: HOST_FINGERPRINT, instanceId: 'instance-id-1234567890' });
    const offlinePromise = store.getState().recoverSelectHost(store.getState().recoverHosts![0]);
    await vi.waitFor(() => expect(socket.frames().some(frame => frame.kind === 'pair-request')).toBe(true));
    const first = socket.frames().find(frame => frame.kind === 'pair-request' && frame.instanceId) as Extract<CompanionRelayFrame, { kind: 'pair-request' }>;
    socket.deliver({
      v: 1, kind: 'pair-result', requestId: first.requestId, accepted: false, reason: 'host-offline',
      envelope: envelope('neo-relay-pair-request'), ciphertext: '',
    });
    await offlinePromise;
    expect(store.getState().recoverError).toBe('hostOffline');

    // S7：Supabase 网络失败 ⇒ idle 行内「连不上账号服务」，重试走同一提交口。
    vi.stubGlobal('fetch', okFetch({}, 503));
    await store.getState().recoverLogin('lin@example.com', PASSWORD);
    expect(store.getState().recoverStep).toBe('idle');
    expect(store.getState().recoverError).toBe('unreachable');
  });

  it('取消：S6 在途取消 ⇒ 会话关闭、步进归零、迟到的同意结果不落盘', async () => {    await loginToListHosts({ name: 'Mac', fingerprint: HOST_FINGERPRINT, instanceId: 'instance-id-1234567890' });
    void store.getState().recoverSelectHost(store.getState().recoverHosts![0]);
    await vi.waitFor(() => expect(store.getState().recoverStep).toBe('pairing'));
    const first = socket.frames().find(frame => frame.kind === 'pair-request' && frame.instanceId) as Extract<CompanionRelayFrame, { kind: 'pair-request' }>;
    store.getState().recoverCancel();
    expect(store.getState().recoverStep).toBe('idle');
    expect(socket.closed).toBe(true);
    // 迟到的电脑同意（reply/complete 都来）没有等待者接：不写盘、不翻状态。
    const responder = createRelayPairHandshake(false, hostIdentity);
    responder.recv(fromHex(first.ciphertext));
    socket.deliver({
      v: 1, kind: 'pair-result', requestId: first.requestId, accepted: true, stage: 'reply',
      envelope: envelope('neo-relay-pair-request'), ciphertext: toHex(responder.send()),
    });
    socket.deliver({
      v: 1, kind: 'pair-result', requestId: first.requestId, accepted: true, stage: 'complete',
      envelope: envelope('neo-relay-pair-request'), ciphertext: JSON.stringify(['ab']),
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes.filter(write => write.includes('phone-recovered-1'))).toHaveLength(0);
    expect(store.getState().binding).toBeNull();
  });

  it('S3 入口门（R2 Important①）：relay 地址还是占位值 ⇒ recoverEntryAvailable=false，缓存到真实地址才开门', async () => {
    // 未配对、无缓存（刚装好/刚清空）：占位常量兜底 ⇒ 不开门——拨占位域名只会 DNS 失败成
    // 泛化的「服务连不上」，入口置灰换「未开通」说明。
    expect(store.getState().recoverEntryAvailable).toBe(false);

    // 已配对的怪状态（绑定丢了但路由缓存还在）：缓存里的真实地址照常用，入口照开。
    const identity = createIdentity();
    const cachedRoute = { v: 1 as const, url: 'wss://relay.real.example.com/companion', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };
    const cachedStore = storeWith(new RecoverSocket(), JSON.stringify({
      version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey), relay: cachedRoute,
    }));
    await cachedStore.store.getState().hydrate();
    expect(cachedStore.store.getState().recoverEntryAvailable).toBe(true);

    // 缓存里的地址本身是占位值：仍不开门（判据认地址，不认「有没有缓存」）。
    const placeholderStore = storeWith(new RecoverSocket(), JSON.stringify({
      version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
      relay: { ...cachedRoute, url: COMPANION_RELAY_PLACEHOLDER_URL },
    }));
    await placeholderStore.store.getState().hydrate();
    expect(placeholderStore.store.getState().recoverEntryAvailable).toBe(false);
  });

  it('hosts 步重入 recoverLogin ⇒ 旧 recoverSession 的活 WS 先关再覆盖（Nit3）', async () => {
    await loginToListHosts({ name: 'Mac', fingerprint: HOST_FINGERPRINT, instanceId: 'instance-id-1234567890' });
    expect(store.getState().recoverStep).toBe('hosts');
    expect(socket.closed).toBe(false);
    // hosts 步不挡重入（回 S4 重新登录是正常出路）：旧会话的 WS 必须关掉，不能挂着陪跑到进程退出。
    void store.getState().recoverLogin('lin@example.com', PASSWORD);
    expect(socket.closed).toBe(true);
  });

  it('S5 横幅兜底（Nit2）：未登记的失败值渲染中性「没成功」，不冒充「电脑身份核对不上」', () => {
    const text = messages('zh');
    expect(recoverErrorCopy(text, 'hostMismatch')).toBe(text.recoverHostMismatch);
    // 形参已按 RecoverError 收窄（R3 Nit5）：运行时兜底仍要钉——跨版本旧值/异常值不许冒充
    // 「电脑身份核对不上」，用显式断言 cast 模拟登记表之外的值。
    expect(recoverErrorCopy(text, 'unlisted-future-value' as RecoverError)).toBe(text.recoverGeneric);
    expect(recoverErrorCopy(text, 'unlisted-future-value' as RecoverError)).not.toContain('核对不上');
  });
});
